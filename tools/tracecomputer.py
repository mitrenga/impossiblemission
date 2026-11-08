#!/usr/bin/env python3
"""tracecomputer — záznam **kapesního počítače** v originálu, snímek po snímku.

Tlačítko vestoje v šachtě nedělá salto, otevře počítač (`$3A49` → `$3AC6`,
`sources/docs/disasm_notes.md` §34). Na rozdíl od terminálu (§29) a od
obřadu umírání (§31) tu **jednotkou snímek je**: `$83EA` na vrcholu smyčky
`$3AF5` čeká na `$E0` a obsluha přerušení běží dál, takže jeden průchod
smyčky je jeden snímek a hodiny v počítači jdou.

Měří se to, čím počítač je:

| blok | proč |
|---|---|
| `$5C50`–`$5FAF` | **šest přihrádek**, tedy okno do sady počítače (§14) |
| `$4D80`–`$4DFF` | dva sprajtové bloky, ve kterých nesený dílek jezdí |
| `$4EF5`–`$4F54` | **seznam nalezených dílků** a jejich barvy |
| `$BFC0`–`$C04F` | **záznamy 36 dílků** — telefon do nich zapisuje (`$7F80`) |
| `$C100`–`$C2CF` | nárazník undo a to, co si pod sebe schová telefon |
| `$4280`–`$43FF` | spodní půlka obrazovky i s **ukazateli sprajtů** |
| `$DA80`–`$DBFF` | její barvy — listování seznamu je **posouvá** |
| `$3450`–`$3470` | panel šachty, do kterého padá **písmeno hesla** |
| registry VIC | ruka, značka a ukazatel jsou sprajty 4, 5 a 6 |

★ **Tabulka joysticku je tisíc míst, ne dvěset padesát šest.** Kurzor jde
o půl pixelu za snímek, takže cesta přes obrazovku je sto snímků a skript
se do bajtového čítače nevejde. Tabulka proto leží na `$0400`–`$07FF`
(videopaměť banky 0, kterou tahle hra nepoužívá — má banku 1, §6) a čítač
si k sobě nese **stránku**, kterou stub přepíše ve svém vlastním operandu.

★ **Nalezené dílky se dosazují** (`--pieces`): bez nich je seznam prázdný
a počítač neumí nic než odejít. Je to **záplata záznamu**, ne pravidlo hry
— stejná jako dosazená počitadla u terminálu — a bez ní by se nedalo
natočit složení skládačky, protože k tomu je potřeba najít čtyři určité
dílky, tedy prohledat půl pevnosti.
★ Dílky jedné skládačky jsou `4n`–`4n+3` (`$8109 ASL A / ASL A`), takže
`--pieces 0,1,2,3` je celá první skládačka.

★ **Ruka začíná na tlačítku mapy.** `$3E7F` ji bez vybrané přihrádky zaparkuje
na `$D008 = $10` s devátým bitem, tedy na půlpixelu `$88`, a `$D009 = $D1`
— a to je podle rozcestníku `$3C21` prostřední řádek pravých tlačítek, tedy
**mapa**, tedy odchod. Záznam „otevři a hned zmáčkni" je proto tři snímky.

    ./tools/tracecomputer.py --name compopen --script 'idle:4,fire:2,idle:20'
    ./tools/tracecomputer.py --set          # celá sada pro akceptaci

Měří to `tools/matchcomputer.mjs` proti `app/pocketComputer.js`.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, ROBOTS, BALL,
                         SPRITE_COLL, TICK_SITE, LOOP_SITES, JOY_SITES,
                         parse_script, parse_log)

FOUND, FOUND_COLORS = 0x4EF5, 0x4F25

# ★ tisícová tabulka joysticku a stub, který si nese stránku ve svém operandu
TABLE, MAX_FRAMES = 0x0400, 1000
STUB = 0x0300
STUB_PAGE = STUB + 8                      # operand `LDA $0400,Y`
STUB_CODE = (0x8C, 0x40, 0x03,            # STY $0340
             0xAC, 0x42, 0x03,            # LDY $0342
             0xB9, TABLE & 0xFF, TABLE >> 8,
             0x8D, 0x41, 0x03,            # STA $0341
             0xAC, 0x40, 0x03,            # LDY $0340
             0xAD, 0x41, 0x03,            # LDA $0341
             0x60)
TICK_STUB = 0x0350
TICK_CODE = (0xEE, 0x42, 0x03,            # INC $0342
             0xD0, 0x03,                  # BNE +3
             0xEE, STUB_PAGE & 0xFF, STUB_PAGE >> 8,
             0xA9, 0x00, 0x8D, 0x43, 0x03,
             0x4C, 0x98, 0x83)            # JMP $8398
LOOP_STUB = 0x0370
LOOP_CODE = (0x20, 0x6B, 0x7F, 0xEE, 0x43, 0x03, 0x60)
COUNTER, PASSES = 0x0342, 0x0343

# co se vypisuje na každém snímku; blok `zp` musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('harness', 0x0300, 0x0343, 'ram'),
         ('panel', 0x3450, 0x3470, 'ram'),
         ('blocks', 0x4D80, 0x4DFF, 'ram'),
         ('found', 0x4EF5, 0x4F54, 'ram'),
         ('window', 0x5C50, 0x5FAF, 'ram'),
         ('records', 0xBFC0, 0xC04F, 'ram'),
         ('buffers', 0xC100, 0xC2CF, 'ram'),
         ('screen', 0x4280, 0x43FF, 'ram'),
         ('color', 0xDA80, 0xDBFF, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))
# ★ odložená kopie přihrádek — mění se **jen na tlačítku mapy**, a je to
# osm set šedesát čtyři bajtů na snímek, tak se přidává jen k záznamu mapy
DUMPS_PARKED = DUMPS + (('parked', 0xC690, 0xC9EF, 'ram'),)

# (jméno, semínko, skript, dílky, mapa, nezamíchaná natočení)
# ★ Ruka stojí na tlačítku mapy, takže cesta kamkoli jinam je „doleva" nebo
# „nahoru" po půlpixelech: `$88` → `$2A` je 94 snímků, `$D1` → `$B4` je 29.
SET_RUNS = (
    ('compopen42', '42', 'idle:4,fire:2,idle:40', None, False, False),
    ('compmap42', '42', 'idle:4,fire:2,idle:2,fire:2,idle:30', None, True, False),
    # kurzor doleva na levý sloupec, nahoru na horní řádek přihrádek
    ('compslot42', '42', 'idle:4,fire:2,idle:2,left:94,up:29,idle:2,fire:2,idle:40',
     '0,1,2,3', False, False),
    # otočení a překlopení prvního dílku v seznamu
    ('comprot42', '42', 'idle:4,fire:2,idle:2,left:94,up:29,idle:2,fire:2,idle:2,'
     'right:94,down:29,idle:2,fire:2,idle:60', '0,1,2,3', False, False),
    # telefon: doleva až na jeho tlačítko a dolů
    ('compphone42', '42', 'idle:4,fire:2,idle:2,left:112,down:15,idle:2,fire:2,idle:20,'
     'fire:2,idle:200', '0,1,2,3', False, False),
    # listování seznamem nahoru a zpátky
    ('compscroll42', '42', 'idle:4,fire:2,idle:2,left:112,up:20,idle:2,fire:2,idle:20,'
     'down:16,idle:2,fire:2,idle:20', '0,1,2,3,4,5', False, True),
    # ★ **tlačítka vpravo**: dílek do přihrádky 1 a pak otočit, překlopit,
    # vyhodit a vrátit — ruka po vyhození zůstává tam, kde byla
    ('compedit42', '42',
     'idle:4,fire:2,idle:2,left:94,up:29,idle:2,fire:2,'
     'idle:2,right:28,idle:2,fire:2,'
     'idle:4,right:51,idle:2,fire:2,idle:40,'
     'right:12,idle:2,fire:2,idle:44,'
     'right:12,idle:2,fire:2,idle:20,'
     'left:12,down:20,idle:2,fire:2,idle:20,'
     'down:18,idle:2,fire:2,idle:20,'
     'up:18,right:12,idle:2,fire:2,idle:30,idle:4,fire:2,idle:20',
     '0,1,2,3', False, True),
    # ★ **hlášky**: bez vybrané přihrádky řekne „no image selected", a to je
    # `$81B8` — dva znaky za snímek a pak čekání na puštění a stisk
    ('compsay42', '42', 'idle:4,fire:2,idle:2,up:17,idle:2,fire:2,idle:30,'
     'idle:4,fire:2,idle:20,down:17,right:12,idle:2,fire:2,idle:30,idle:4,fire:2,idle:20',
     None, False, False),
    # ★ **složená skládačka**: čtyři dílky jedné skládačky do jedné přihrádky,
    # a `$80B6` v ní pozná kartu — sto bodů, písmeno hesla a čtyři dílky pryč.
    # ★ Začíná se **dvojím zalistováním**, a je to nutnost: `--pieces` položí
    # do seznamu čísla, ale obrázky v okně zůstanou ty, co tam byly (na stroji
    # je tam sází `$9976` při nálezu, §34). Teprve listování je `$9C3A` složí.
    ('compsolve42', '42',
     'idle:4,fire:2,idle:2,left:112,up:21,idle:2,fire:2,idle:6,fire:2,idle:8,'
     'right:18,up:8,idle:2,fire:2,idle:2,right:28,idle:2,fire:2,'
     'idle:6,left:43,down:16,idle:2,fire:2,idle:2,up:24,right:28,idle:2,fire:2,'
     'idle:6,left:61,down:16,idle:2,fire:2,idle:6,fire:2,idle:8,'
     'right:18,up:24,idle:2,fire:2,idle:2,right:28,idle:2,fire:2,'
     'idle:6,left:43,down:16,idle:2,fire:2,idle:2,up:24,right:28,idle:2,fire:2,idle:150',
     '0,1,2,3,4,5', False, True),
)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d'
                         % (total, MAX_FRAMES))
    base = os.path.join(a.dir, a.name)
    dumps = DUMPS_PARKED if a.map else DUMPS

    table = [0x7F]*MAX_FRAMES
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
    for site in (ROBOTS, BALL, SPRITE_COLL):
        e.cmd('> %04x 60' % site)
    e.cmd('> %04x %s' % (STUB, ' '.join('%02x' % x for x in STUB_CODE)))
    e.cmd('> %04x %s' % (TICK_STUB, ' '.join('%02x' % x for x in TICK_CODE)))
    e.cmd('> %04x %s' % (LOOP_STUB, ' '.join('%02x' % x for x in LOOP_CODE)))
    e.cmd('> %04x 20 %02x %02x' % (TICK_SITE, TICK_STUB & 0xFF, TICK_STUB >> 8))
    for site in LOOP_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, LOOP_STUB & 0xFF, LOOP_STUB >> 8))
    for site in JOY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, STUB & 0xFF, STUB >> 8))
    for at in range(0, MAX_FRAMES, 16):
        e.cmd('> %04x %s' % (TABLE + at,
                             ' '.join('%02x' % x for x in table[at:at+16])))
    # ★ čítač `$FF` a stránka o jedna níž: první `$8365` je posune na 0 a `$04`
    e.cmd('> %04x %02x' % (COUNTER, 0xFF))
    e.cmd('> %04x %02x' % (STUB_PAGE, (TABLE >> 8) - 1))
    # ★ **Nezamíchaná natočení** (`--plain`): `$B176` dá každému dílku do
    # čtvrtého bajtu záznamu náhodné bity 2 a 3, a `$9C3A` je pak musí při
    # každém složení obrázku odtočit — sto čtyřicet čtyři bajtů až
    # jednatřicetkrát. ★ **To se originálu do snímku nevejde**: výpis stavu
    # padne doprostřed otáčení (změřeno na `compscroll42`, `$18` = `$5000`
    # uprostřed `$9C7D`), takže se animace listování o snímek posune a nedá
    # se srovnávat — táž mez, jakou má `matchplayer` v těžké místnosti (§19).
    # S vynulovanými bity je složení levné a do snímku se vejde.
    # ★ A **spodní dva bity zůstat musí**: jsou to `y`, tedy místo dílku mezi
    # čtyřmi, a z nich plyne, která ze dvou masek se obrátí (`$9C44`). Kdo je
    # vynuluje taky, má čtyři dílky se stejnou maskou — a ty se pak podle
    # `$802A` „images can't overlap" (stálo to jeden běh, 2026-09-21).
    if a.plain:
        for piece in range(36):
            at = 0xBFC0 + 4*piece + 3
            e.cmd('> %04x %02x' % (at, piece % 4))
    # ★ dosazené dílky — záplata záznamu, viz hlavička
    if a.pieces:
        pieces = [int(x, 0) for x in a.pieces.split(',')]
        e.cmd('> %04x %s' % (FOUND, ' '.join('%02x' % p for p in pieces) + ' ff'))
        e.cmd('> %04x %s' % (FOUND_COLORS,
                             ' '.join('%02x' % int(a.tint, 16) for _ in pieces)))
        # ★ a **šest barev přihrádek** na tutéž barvu: `$3BAB` drop odmítne,
        # když se barva neshoduje, a `$98`-`$9D` nese hra z předchozí hry.
        # Zase záplata záznamu, ne pravidlo hry.
        e.cmd('> 0098 %s' % ' '.join('%02x' % int(a.tint, 16) for _ in range(6)))
    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    e.cmd('bank ram')
    parts, bank = [], 'ram'
    for _name, lo, hi, want in dumps:
        if want != bank:
            parts.append('bank %s' % want)
            bank = want
        parts.append('m %04x %04x' % (lo, hi))
    if bank != 'ram':
        parts.append('bank ram')
    e.cmd('break exec $%04x' % FRAME_TICK)             # #1
    e.on_break(1, '%s; g' % '; '.join(parts))
    e.go()

    cycles = 150_000_000 + (a.start + total + 60)*CYCLES_PER_FRAME_PAL
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    frames = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in dumps])
    if len(frames) > total + 1:
        frames = frames[:total + 1]
    index = {
        'name': a.name, 'script': a.script, 'entropy': '%02X' % int(a.entropy, 16),
        'start': a.start, 'pieces': a.pieces, 'tint': a.tint, 'map': bool(a.map),
        'plain': bool(a.plain),
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'joy': ['%04X' % x for x in JOY_SITES],
        'stub': '%04X' % STUB, 'table': '%04X' % TABLE,
        'counter': '%04X' % COUNTER, 'passes': '%04X' % PASSES,
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in dumps],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        'place': (frames[0]['zp'][0x1A] if frames else None),
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in frames],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(frames) >= total + 1
    print('tracecomputer %s: %d snímků z %d, %s'
          % (a.name, len(frames), total + 1, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
    return 0 if ok else 1


def record_set(a):
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, script, pieces, wants_map, plain = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.script, args.pieces, args.map = script, pieces, wants_map
        args.plain = plain
        return name, record(args)

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, SET_RUNS))
    bad = [n for n, rc in res if rc]
    print('tracecomputer --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='idle:4,fire:2,idle:40')
    ap.add_argument('--name', default='compopen42')
    ap.add_argument('--dir', default='build/computer')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--pieces', default=None,
                    help='dosadit nalezené dílky do $4EF5 (čárkami, třeba 0,1,2,3)')
    ap.add_argument('--tint', default='06', metavar='HEX',
                    help='barva dosazených dílků v $4F25')
    ap.add_argument('--plain', action='store_true',
                    help='vynulovat zamíchaná natočení dílků ($BFC3), aby se '
                         'složení obrázku vešlo do snímku')
    ap.add_argument('--map', action='store_true',
                    help='vypisovat i odloženou kopii přihrádek $C690-$C9EF')
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M5)')
    ap.add_argument('--jobs', type=int, default=3)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
