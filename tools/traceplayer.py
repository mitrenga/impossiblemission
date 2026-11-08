#!/usr/bin/env python3
"""traceplayer — záznam pohybu agenta v originálu, snímek po snímku.

M3 měří **krok agenta**: hlavní smyčka běží jednou za snímek (`$7249`
v místnosti, `$3A15` v šachtě, obě čekají na `$E0` v `$7F6B` —
`sources/docs/disasm_notes.md` §19), a všechno, co se o agentovi ví, leží
v nulté stránce: poloha tří sprajtů (`$2C`–`$32`), hrany (`$3A`–`$3D`),
stav (`$3F`), natočení (`$50`), rychlost (`$39`), tik (`$3E`/`$40`), pád
(`$41`/`$42`), smrt (`$43`), místo (`$1A`), místnost (`$7E`/`$7F`)
a hodiny (`$D1`–`$D4`).

Nástroj tedy:

1. dosadí **pevnou entropii** na `$82E3` (§8), takže je pevnost stejná;
2. přepíše **všech 18 čtení `$DC00`** na `LDA #imm` + `NOP` (§7, §12),
   takže joystick řídí skript;
3. volitelně **vypne roboty a kouli** (`$8ECA`, `$92C1` → `RTS`) a kolize
   sprajtů (`$94FA` → `RTS`) — M3 je agent bez robotů, ti jsou M4;
4. na `$8361` (obsluha přerušení, jednou za snímek) vypíše **celou nultou
   stránku**, ukazatele sprajtů agenta (`$43F9`–`$43FB`) a registry VIC;
5. na začátku záznamu uloží **celou paměť**, aby měl přepis z čeho začít.

    ./tools/traceplayer.py --script 'right:400' --name walk
    ./tools/traceplayer.py --script 'idle:30,right:120,fire:4,idle:200' --name jump
    ./tools/traceplayer.py --collision --lead 'right:200' --script 'right:250' --name collwalk42

Měří to `tools/matchplayer.mjs` proti `app/player.js`.

★ S `--collision` (M4, §30) přibude šestý úkol: obě `LDA $D01E` uvnitř
`$94FA` se přepíšou na stub, který hodnotu uloží do `$0334`/`$0335` a zvedne
čítač v `$0336`/`$0337`. Bez toho se nedá zjistit **co rutina přečetla** —
`$D01E` je latch, který se čtením nuluje, takže po něm v paměti nic nezbude.
Měří `tools/matchcollision.mjs`.
"""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL

ENTROPY_SITE = 0x82E3            # `EOR $D012` v míchačce (§8)
GAME_ENTRY = 0x3855              # vstup hry (§0)
FRAME_TICK = 0x8361              # `INC $E0` v obsluze, jednou za snímek (§19)
ROBOTS = 0x8ECA                  # krok robotů (§17)
BALL = 0x92C1                    # skript koule
SPRITE_COLL = 0x94FA             # kolize sprajtů → smrt
STUB = 0x0300                    # harness joysticku
STUB_CODE = (0x8C, 0x20, 0x03, 0xAC, 0x32, 0x03, 0xB9, 0x00, 0x02,
             0x8D, 0x21, 0x03, 0xAC, 0x20, 0x03, 0xAD, 0x21, 0x03, 0x60)
TICK_STUB = 0x0340               # čítač snímků v obsluze přerušení
TICK_CODE = (0xEE, 0x32, 0x03, 0xA9, 0x00, 0x8D, 0x33, 0x03, 0x4C, 0x98, 0x83)
# ★ Totéž, ale navíc se nuluje okénko kolizí ($0334-$0337). Musí to dělat
# **až `$8365`**, tedy hned za výpisem na `$8361`: co se do okénka nasbíralo,
# se tím zveřejní právě jednou a záznam má na každém snímku čisté hodnoty.
TICK_CODE_COLL = (0xEE, 0x32, 0x03, 0xA9, 0x00, 0x8D, 0x33, 0x03,
                  0x8D, 0x34, 0x03, 0x8D, 0x35, 0x03, 0x8D, 0x36, 0x03,
                  0x8D, 0x37, 0x03, 0x4C, 0x98, 0x83)
# ★ Latch `$D01E` **čtení nuluje**, takže „co v něm bylo" se z výpisu paměti
# přečíst nedá — než se na něj harness podívá, hra ho dávno sebrala. Jediný
# poctivý způsob je vzít hodnotu **tam, kde ji bere `$94FA`**: obě jeho
# `LDA $D01E` (`$9508` a `$9517`) jsou tříbajtové, takže se přepíšou na `JSR`
# na stub, který hodnotu uloží a vrátí ji v akumulátoru nedotčenou.
COLL_SITES = (0x9508, 0x9517)    # dvě `LDA $D01E` uvnitř `$94FA` (§30)
# ★ M6: kam hra píše SID — **všech 164 míst** z disassembly (`ST[AXY] $D4xx`).
# Sbírá se to **checkpointy monitoru**, ne záplatou: záplata by obsluhu
# prodloužila a u řeči se ukázalo, že na cyklech záleží (§32).
# ★ A **ne ze `scanhw.py`**: ten skenuje bajty lineárně a tři místa mu
# unikla (`$9225` mimo jiné), protože na ně lineární čtení nedopadne.
SID_SITES = (
    0x38F0, 0x3A1D, 0x3A22, 0x3A25, 0x3A39, 0x3F87, 0x3F8A, 0x3F8F, 0x3F94, 0x3F9B,
    0x3F9E, 0x3FA3, 0x7D4E, 0x7D51, 0x7D56, 0x7D59, 0x7D5E, 0x7D63, 0x7D68, 0x7D6D,
    0x7D72, 0x7D77, 0x7D7C, 0x7D81, 0x7D84, 0x7DC2, 0x7DC5, 0x7E32, 0x7E47, 0x7E4D,
    0x7E53, 0x7E59, 0x7E5E, 0x7E63, 0x7E66, 0x7EAA, 0x7EC3, 0x7EC6, 0x7ECB, 0x7ED0,
    0x7ED5, 0x7EDF, 0x7EE2, 0x7EEC, 0x7EEF, 0x7EFF, 0x7F10, 0x7F15, 0x7F1A, 0x7F1F,
    0x7F24, 0x7F27, 0x7F2C, 0x7F2F, 0x7F34, 0x7F39, 0x7F43, 0x7F4D, 0x7F50, 0x7F56,
    0x7F5B, 0x7F63, 0x8322, 0x8325, 0x85CE, 0x85D4, 0x85DC, 0x85DF, 0x85E4, 0x85E7,
    0x85EC, 0x85EF, 0x85F4, 0x85F9, 0x861D, 0x8829, 0x88F3, 0x8E81, 0x8E96, 0x8EA4,
    0x8EB4, 0x8EB7, 0x8EBC, 0x8EC1, 0x8EC6, 0x91D8, 0x91EB, 0x9225, 0x922A, 0x922D,
    0x9230, 0x9235, 0x923A, 0x923F, 0x9247, 0x924C, 0x924F, 0x9252, 0x9257, 0x925C,
    0x9261, 0x9267, 0x926A, 0x9273, 0x9278, 0x927D, 0x9280, 0x9285, 0x95EE, 0x95F1,
    0x95F4, 0x965D, 0x9660, 0x9700, 0x979C, 0x979F, 0x97A2, 0x97A5, 0x97A8, 0x97AD,
    0x97B2, 0x97B7, 0x97BC, 0x97C1, 0x97C9, 0x97CE, 0x97D3, 0x97F7, 0x9D17, 0x9D1A,
    0x9D1D, 0xA24C, 0xA24F, 0xA252, 0xA92B, 0xA92E, 0xA933, 0xA938, 0xA93B, 0xA93E,
    0xA941, 0xA944, 0xA947, 0xA94C, 0xA999, 0xA99E, 0xA9B9, 0xA9BC, 0xA9BF, 0xA9CF,
    0xA9D2, 0xA9D5, 0xA9EE, 0xA9F1, 0xA9F4, 0xB77F, 0xB782, 0xB785, 0xB7A4, 0xB7A7,
    0xB7AA, 0xBF57, 0xBF5A, 0xBF5D,
)
# `.C:85ce  8D 01 D4  STA $D401  - A:1D X:40 Y:00 SP:f8 ..-..I..  4212781`
SID_HIT = re.compile(r'^\.C:([0-9a-fA-F]{4})\s+([0-9A-F ]{8,11})\s+\S+.*?-\s+'
                     r'A:([0-9a-fA-F]{2})\s+X:([0-9a-fA-F]{2})\s+Y:([0-9a-fA-F]{2})')
# ★ **Šestnáct bajtů od sebe.** Stub má deset bajtů; s rozestupem osmi by
# druhý přepsal konec prvního a z `INC $0336` by se stalo `INC $AD36` —
# tedy tichá oprava kódu jízdy výtahem. Stálo to jeden běh (2026-09-20).
COLL_STUBS = (0x0370, 0x0380)
COLL_CODE = tuple(
    (0xAD, 0x1E, 0xD0,           # LDA $D01E   — a tím ho vynuluj, jako hra
     0x8D, slot, 0x03,           # STA $0334 / $0335
     0xEE, slot + 2, 0x03,       # INC $0336 / $0337 — kolikrát se četlo
     0x60)
    for slot in (0x34, 0x35))
TICK_SITE = 0x8365               # `JSR $8398` v obsluze (§19)
LOOP_STUB = 0x0360               # počitadlo průchodů hlavní smyčkou
LOOP_CODE = (0x20, 0x6B, 0x7F, 0xEE, 0x33, 0x03, 0x60)
LOOP_SITES = (0x7249, 0x83EA)    # `JSR $7F6B` na vrcholu obou smyček (§19)
COUNTER = 0x0332                 # pořadí snímku v záznamu
PASSES = 0x0333                  # průchodů smyčkou za snímek
TABLE = 0x0200                   # 256 bajtů, joystick po snímcích
MAX_FRAMES = 256
# ★ všech 18 čtení `LDA $DC00` v herním kódu (mimo obsluhu klávesnice $BEB2)
JOY_SITES = (0x3A3C, 0x3A7C, 0x3A85, 0x3AA4, 0x3B1E, 0x3E17, 0x7263, 0x81EA,
             0x81F1, 0x87F1, 0x8849, 0x98B8, 0x99C7, 0x9F5D, 0x9F68, 0x9F89,
             0xA808, 0xACCF)
NAMES = {'idle': 0x7F, 'up': 0x7E, 'down': 0x7D, 'left': 0x7B, 'right': 0x77,
         'fire': 0x6F, 'upfire': 0x6E, 'downfire': 0x6D, 'leftfire': 0x6B,
         'rightfire': 0x67}
# co se vypisuje na každém snímku; pořadí = pořadí v logu
DUMPS = (('zp', 0x0000, 0x00FF), ('ptr', 0x43F9, 0x43FB),
         ('harness', 0x0320, 0x0333), ('row', 0x41E0, 0x4207))
# ★ S roboty (M4) je potřeba víc: jejich ukazatele leží v `$43FC`-`$43FF`
# a jejich poloha **není v nulté stránce**, je rovnou v registrech VIC.
# Blok `zp` musí zůstat první, protože jím parser pozná nový snímek.
DUMPS_ROBOTS = (('zp', 0x0000, 0x00FF), ('ptr', 0x43F8, 0x43FF),
                ('harness', 0x0320, 0x0333), ('row', 0x41E0, 0x4207),
                ('vic', 0xD000, 0xD02E))
# ★ S kolizemi (M4) je potřeba ještě okénko `$0334`-`$0337`: co `$94FA`
# přečetlo z `$D01E` na obou svých místech a kolikrát tam bylo.
DUMPS_COLL = (('zp', 0x0000, 0x00FF), ('ptr', 0x43F8, 0x43FF),
              ('harness', 0x0320, 0x0337), ('row', 0x41E0, 0x4207),
              ('vic', 0xD000, 0xD02E))
# ★ `row` je dvanáctý řádek obrazovky hry (`$4000` + 12*40, §6). Je v záznamu
# proto, že je to **jediný vstup pohybu, který nepochází z nulté stránky**:
# `$8CC3` se ptá obrazovky, jestli je pod agentem podlaha. `matchplayer` ho
# srovnává taky, a tím hlídá, že obrazovka během záznamu stojí.


# ★ Standardní sada záznamů — to, co měří akceptace M3. Čtyři semínka jsou
# čtyři různé pevnosti, takže „místnost" není jedna a táž: `--entropy` mění
# los (§8) a s ním i to, do které místnosti se doprava dojde.
SET_SEEDS = ('42', '07', '99', 'C3')
SET_SHAFT = (('idle', 'idle:60'),
             ('right', 'idle:6,right:80'),
             ('left', 'idle:6,left:80'),
             ('jump', 'idle:5,fire:3,idle:70'))
SET_ROOM = (('idle', 'idle:80'),
            ('right', 'right:80'),
            ('left', 'left:80'),
            ('jump', 'idle:5,fire:3,idle:70'),
            ('jumpr', 'right:20,fire:3,idle:60'),
            ('jumpl', 'left:20,fire:3,idle:60'),
            ('walkjump', 'right:40,fire:3,idle:40'),
            ('up', 'idle:10,up:20,idle:40'))
# ★ Dva rozjezdy do místnosti: doprava z kabiny, a **výtahem dolů** a teprve
# pak doprava. U některých semínek totiž vedle kabiny žádná místnost není
# (mřížka `$FF96` má prázdné čtverce, §11) a agent se jen opře o ořez.
SET_LEADS = (('a', 'right:200'), ('b', 'down:400,idle:10,right:200,idle:60'))
# ★ A jeden záznam, který **jde dveřmi**: ze šachty se drží doprava tak dlouho,
# aby se stihl celý přechod (62 snímků, §21) a ještě kus chůze v nové
# místnosti. Bez rozjezdu, aby v něm byl i odchod ze šachty.
SET_DOOR = ('doorin', '', 'right:250')


def standard_set():
    """Čtveřice (jméno, semínko, rozjezd, skript) pro `--set`."""
    out = []
    for seed in SET_SEEDS:
        for name, script in SET_SHAFT:
            out.append(('shaft%s%s' % (name, seed), seed, '', script))
        for tag, lead in SET_LEADS:
            for name, script in SET_ROOM:
                out.append(('room%s%s%s' % (name, tag, seed), seed, lead, script))
        name, lead, script = SET_DOOR
        out.append(('%s%s' % (name, seed), seed, lead, script))
    return out


def value_of(token):
    token = token.strip()
    return NAMES[token] if token in NAMES else int(token, 16)


def parse_script(text):
    out = []
    for part in text.split(','):
        token, frames = part.split(':')
        out.append((token.strip(), value_of(token), int(frames)))
    return out


def parse_log(path, blocks=DUMPS):
    """Z logu monitoru poskládá snímky.

    Řádek `m` vypadá jako `>C:002c  ac 6a ac 5e  ac 73 00 00  …   .j.^.s…`:
    skupiny bajtů odděluje **dvojmezera**, výpis ASCII **trojmezera** — a ta
    se musí uříznout, jinak by se z textu `ab` stal další bajt.
    """
    blocks = list(blocks)
    frames, cur = [], None
    head = re.compile(r'^>C:([0-9a-f]{4})\s')
    for line in open(path, errors='replace'):
        m = head.match(line)
        if not m:
            continue
        addr = int(m.group(1), 16)
        blk = next((b for b in blocks if b[1] <= addr <= b[2]), None)
        if blk is None:
            continue
        name, lo, hi = blk
        data = [int(x, 16) for x in line.split('   ')[0].split()[1:]]
        if addr == lo:
            if name == blocks[0][0]:
                if cur:
                    frames.append(cur)
                cur = {}
            if cur is None:
                continue
            cur[name] = []
        if cur is None or name not in cur:
            continue
        cur[name] += data
        del cur[name][hi - lo + 1:]
    if cur:
        frames.append(cur)
    sizes = {name: hi - lo + 1 for name, lo, hi in blocks}
    return [f for f in frames if all(len(f.get(n, [])) == s for n, s in sizes.items())]


def record_set(a):
    """Natočí celou standardní sadu; každý záznam je vlastní běh emulátoru."""
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, lead, script = item
        args = copy.copy(a)
        args.set, args.name, args.entropy, args.lead, args.script = \
            False, name, seed, lead, script
        rc = record(args)
        return name, rc

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, standard_set()))
    bad = [n for n, rc in res if rc]
    print('traceplayer --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def parse_sid(path):
    """Zápisy do SID z logu monitoru, rozdělené po snímcích.

    ★ Čísla snímku se nikde nevypisuje — pozná se podle toho, že mezi
    zápisy leží **výpis snímku** (checkpoint na `$8361`, který tiskne řádky
    `>C:`). Zápis tedy patří do toho snímku, ve kterém padl.
    """
    frames, current = [], []
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.rstrip()
        if line.startswith('>C:'):
            continue
        m = SID_HIT.match(line)
        if not m:
            continue
        pc = int(m.group(1), 16)
        if pc == FRAME_TICK:
            frames.append(current)
            current = []
            continue
        if pc not in SID_SITES:
            continue
        raw = [int(x, 16) for x in m.group(2).split()]
        a_reg, x_reg, y_reg = (int(m.group(i), 16) for i in (3, 4, 5))
        opcode = raw[0]
        addr = raw[1] | (raw[2] << 8)
        if opcode == 0x9D:                           # STA abs,X
            addr += x_reg
        value = {0x8D: a_reg, 0x9D: a_reg, 0x8C: y_reg, 0x8E: x_reg}.get(opcode)
        if value is None or not (0xD400 <= addr <= 0xD418):
            continue
        current.append([addr - 0xD400, value])
    frames.append(current)
    return frames


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='right:120', help='úseky `jméno:snímky`')
    ap.add_argument('--lead', default='', help='úseky, které se **odehrají, ale nezaznamenají** — '
                    'tím se agent dostane tam, kde má záznam začít (třeba do místnosti). '
                    '★ Do místnosti je potřeba nejmíň 180 snímků: místnost se po vstupu '
                    'teprve **stírá** z $C100 na $4000 a než je stírání hotové, je obraz, '
                    'kterého se ptá kolize, jen z půlky (stálo to hodinu, 2026-09-19)')
    ap.add_argument('--name', default='walk')
    ap.add_argument('--dir', default='build/player')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000, help='snímků, než skript začne')
    ap.add_argument('--robots', action='store_true', help='nechat roboty běžet (M4)')
    ap.add_argument('--sid', action='store_true',
                    help='★ navíc zaznamenat **zápisy do SID** (M6): checkpointy '
                         'monitoru na všech místech, která píšou $D400-$D418. '
                         'Měří `tools/matchsound.mjs`.')
    ap.add_argument('--collision', action='store_true',
                    help='★ navíc sledovat, co `$94FA` čte z `$D01E` na obou svých '
                         'místech (M4, §30). Zapíná `--robots`.')
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true', help='x64 místo cyklově přesného x64sc')
    ap.add_argument('--set', action='store_true',
                    help='natočit celou standardní sadu záznamů (akceptace M3)')
    ap.add_argument('--jobs', type=int, default=4, help='kolik emulátorů naráz u --set')
    a = ap.parse_args()

    if a.collision:
        a.robots = True
    if a.set:
        return record_set(a)
    return record(a)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    lead = parse_script(a.lead) if a.lead else []
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d (čítač je bajt)'
                         % (total, MAX_FRAMES))
    base = os.path.join(a.dir, a.name)

    # tabulka joysticku: snímek `i` záznamu čte `$0200 + i`
    table = [0x7F]*256
    frame = 0
    for _token, value, frames in script:
        for _ in range(frames):
            table[frame] = value
            frame += 1

    e = C64Emu(a.image, fast=a.fast)
    e.cmd('break exec $%04x' % GAME_ENTRY)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
    e.cmd('del 1')
    e.brk(GAME_IRQ)                                    # #1 — krok po snímcích
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('del 1')
    e.cmd('bank ram')
    if not a.robots:
        for site in (ROBOTS, BALL, SPRITE_COLL):
            e.cmd('> %04x 60' % site)
    # harness: tabulka, obsluha a osmnáct `JSR`
    for at in range(0, 256, 16):
        e.cmd('> %04x %s' % (TABLE + at, ' '.join('%02x' % x for x in table[at:at+16])))
    e.cmd('> %04x %s' % (STUB, ' '.join('%02x' % x for x in STUB_CODE)))
    tick_code = TICK_CODE_COLL if a.collision else TICK_CODE
    e.cmd('> %04x %s' % (TICK_STUB, ' '.join('%02x' % x for x in tick_code)))
    if a.collision:
        for stub, code, site in zip(COLL_STUBS, COLL_CODE, COLL_SITES):
            e.cmd('> %04x %s' % (stub, ' '.join('%02x' % x for x in code)))
            e.cmd('> %04x 20 %02x %02x' % (site, stub & 0xFF, stub >> 8))
    e.cmd('> %04x %s' % (LOOP_STUB, ' '.join('%02x' % x for x in LOOP_CODE)))
    e.cmd('> %04x 20 %02x %02x' % (TICK_SITE, TICK_STUB & 0xFF, TICK_STUB >> 8))
    for site in LOOP_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, LOOP_STUB & 0xFF, LOOP_STUB >> 8))
    e.cmd('break exec $%04x' % FRAME_TICK)             # #1
    if lead:
        # Rozjezd se **odehraje, ale nezaznamená** — tím se agent dostane
        # například do místnosti, kam by se ze startu hry nedošel. Joystick
        # v něm drží jednoduchá záplata `LDA #imm` + `NOP` (§7), takže
        # rozjezd **nebere z tabulky** a celých 256 míst zůstane záznamu.
        for _token, value, frames in lead:
            for site in JOY_SITES:
                e.cmd('> %04x a9 %02x ea' % (site, value))
            e.ignore(1, max(0, frames - 1))
            e.go()
    for site in JOY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, STUB & 0xFF, STUB >> 8))
    # ★ Čítač: bez rozjezdu se stojí na `$82E8` a `$8365` do prvního výpisu
    # ještě neproběhne, takže `$FF`; s rozjezdem se stojí **na `$8361`**
    # a `$8365` proběhne hned po rozjetí, takže o jedna míň.
    e.cmd('> %04x %02x' % (COUNTER, 0xFE if lead else 0xFF))
    # výchozí stav: celá paměť, barvy a VIC v okamžiku, kdy záznam začíná
    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    e.cmd('bank ram')
    # past, která vypisuje stav a hned se vrací do hry: **jedno `g` na celý
    # záznam**, jinak by se log ztratil (viz hlavička)
    dumps = DUMPS_COLL if a.collision else (DUMPS_ROBOTS if a.robots else DUMPS)
    e.cmd('command 1 "%s"' % '; '.join(
        (['bank io'] if (a.robots or a.collision) else [])
        + ['m %04x %04x' % (lo, hi) for _, lo, hi in dumps] + ['g']))
    if a.sid:
        # ★ Checkpoint navíc na každém zápisu do SID; `command "g"` emulaci
        # pustí dál, aniž by ji o jediný cyklus prodloužil.
        for i, site in enumerate(SID_SITES):
            e.brk(site)
            e.on_break(i + 2, 'g')
    e.go()

    # limit cyklů = kam až má záznam dojít; na konci VICE **skončí sám**
    cycles = (150_000_000
              + (a.start + sum(n for _, _, n in lead) + total + 60)*CYCLES_PER_FRAME_PAL)
    r = e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
              moncmds='%s.cmds' % base, timeout=a.timeout)

    frames = parse_log('%s.log' % base, dumps)
    sid = parse_sid('%s.log' % base) if a.sid else None
    if len(frames) > total + 1:
        frames = frames[:total + 1]
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead, 'entropy': '%02X' % int(a.entropy, 16),
        'start': a.start, 'robots': bool(a.robots), 'collision': bool(a.collision),
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'joy': ['%04X' % x for x in JOY_SITES],
        'stub': '%04X' % STUB, 'table': '%04X' % TABLE,
        'counter': '%04X' % COUNTER, 'tick': '%04X' % TICK_STUB,
        'passes': '%04X' % PASSES, 'loop': '%04X' % LOOP_STUB,
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi}
                  for n, lo, hi in dumps],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        # kde záznam začíná: 0 šachta, 1 místnost (§19)
        'place': (frames[0]['zp'][0x1A] if frames else None),
        # ★ M6: zápisy do SID, po snímcích — `[[registr, hodnota], …]` za každý
        'sid': sid,
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in frames],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(frames) >= total + 1
    print('traceplayer %s: %d snímků z %d, %s' %
          (a.name, len(frames), total + 1, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
