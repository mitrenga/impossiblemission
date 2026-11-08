#!/usr/bin/env python3
"""tracespecial — záznam **dvou zvláštních místností** v originálu.

Nábytek, který drží `$FE`, nepustí prohledávání, ale **řídicí místnost**
`$AA40`; který drží `$FB`, **kódovou** `$A771`
(`sources/docs/disasm_notes.md` §35). Obojí běží s puštěnou obsluhou
přerušení, takže jednotkou je **snímek** — jako u kapesního počítače (§34)
a na rozdíl od terminálu (§29) i obřadu umírání (§31).

★ **Do místnosti se vstupuje přímo** (`r pc=$A771`), jako `tracepuzzle.py`
vstupuje do `$9C3A`: dojít v pevnosti k tomu jednomu kusu nábytku, který
`$FB` drží, by znamenalo projít půl pevnosti, a **na kódu, který se měří,
by to nic nezměnilo**. Co se dosazuje, je zapsané:

| co | proč |
|---|---|
| `$7E` | která místnost to je — kódové jsou **dvě** (`$11` a `$1B`) a každá si nese svou úroveň (`$75`, `$76`) |
| `$75`/`$76` | **úroveň**, tedy o kolik tónů jde; na začátku hry je nula, tedy jeden tón |
| `$345D`–`$3465` | **devět písmen hesla**; bez nich se řídicí místnost jen otočí a mlčí (`$AA42`) |

★ A **řídicí místnost jeden tik `$E0` ztratí**: `$AAD9 SEI` drží přes dva
kilobajty přehozené paměti, což je víc než snímek, takže rastrové přerušení
mezitím zapadne (latch `$D019` si pamatuje, že něco bylo, ne kolikrát).
Přepis to přiznává (`overrun`) a `matchspecial.mjs` ty snímky přeskočí.

    ./tools/tracespecial.py --name code42 --room 11 --level 2 \\
        --script 'idle:60,right:40,fire:2,idle:40'
    ./tools/tracespecial.py --set          # celá sada pro akceptaci

Měří to `tools/matchspecial.mjs` proti `app/codeRoom.js`
a `app/controlRoom.js`.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, ROBOTS, BALL,
                         SPRITE_COLL, TICK_SITE, LOOP_SITES, JOY_SITES,
                         parse_script, parse_log)
from tracecomputer import (TABLE, MAX_FRAMES, STUB, STUB_PAGE, STUB_CODE,
                           TICK_STUB, TICK_CODE, LOOP_STUB, LOOP_CODE,
                           COUNTER, PASSES)

CODE_ROOM, CONTROL_ROOM = 0xA771, 0xAA40
SHAFT_LOOP = 0x3A15              # vrchol smyčky šachty — hlavní kontext, `I` pustí
# ★ `$AB23 LDX #$04 / JSR $BF51` — **věta 4**, a s ní se záznam dál nenatočí:
# `$BF62` přehodí vektor IRQ na `$838C`, což je obsluha, která `$E0` **netiká**
# (jen potvrdí rastr a zavolá `$00FC`, tedy krok přehrávače řeči), a `$BF51`
# u vět 4 a 5 **na dohrání nečeká** (`$BF75`). Od té chvíle tedy past na
# `$8361` mlčí a z obrázku ani z blikání by nebyl ani jeden výpis. Řeč se měří
# `tools/matchsound.mjs` (§32), tady se proto vynechá — a **na její místo
# přijde `CLI`**, protože `$AAD9 SEI` jinak nemá kdo pustit: jediné `CLI`
# mezi nimi je uvnitř `$BF51` (`$BF6A`).
# ★ **A s ním i přehození vektoru IRQ** (`$BF62`): obsluha `$838C` `$E0`
# netiká, zato **nesahá na registry clony** — zatímco herní `$82E7` je každý
# snímek přepíše ze šachty, a obrázek řídicí místnosti by tím zmizel. Kdo
# `$BF51` vynechá a jen pustí `CLI`, změří něco jiného, než co hra dělá
# (stálo to jeden běh, 2026-09-21).
# ★ **A `$E0` přitom tiká dál** — jen jinudy: `$838C` volá `$00FC`, a to je
# `INC $E0 / RTS`. Past na snímek proto musí být **dvě**: `$8361` v herní
# obsluze a `$00FC` v té řečové. Jinak záznam řídicí místnosti skončí na
# `$AAD9` a obrázek ani blikání se nenatočí.
TICK_DURING_SPEECH = 0x00FC
SPEECH_SITE = 0xAB23
SPEECH_STUB = 0x0390
SPEECH_STUB_CODE = (0xA9, 0x8C, 0x8D, 0xFE, 0xFF,     # LDA #$8C / STA $FFFE
                    0xA9, 0x83, 0x8D, 0xFF, 0xFF,     # LDA #$83 / STA $FFFF
                    0x58, 0x60)                       # CLI / RTS
SPEECH_CODE = (0x20, SPEECH_STUB & 0xFF, SPEECH_STUB >> 8, 0xEA, 0xEA)
ROOM = 0x7E                      # ve které místnosti agent je
LEVELS = (0x75, 0x76)            # úroveň kódové místnosti `$11` a `$1B`
PASSWORD = 0x345D                # devět písmen hesla v panelu šachty
PASSWORD_LEN = 9

# co se vypisuje na každém snímku; blok `zp` musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('harness', 0x0300, 0x0343, 'ram'),
         ('panel', 0x3430, 0x3470, 'ram'),
         ('tones', 0xB21F, 0xB22E, 'ram'),
         ('board', 0xA8BE, 0xA8DD, 'ram'),
         ('blocks', 0x4D80, 0x4DFF, 'ram'),
         ('screen', 0x4000, 0x43FF, 'ram'),
         ('picture', 0xC000, 0xC3FF, 'ram'),
         ('color', 0xD800, 0xDBFF, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))

# (jméno, semínko, místnost, úroveň, heslo, skript)
SET_RUNS = (
    # ★ kódová místnost `$11`, jeden tón: dojít na první políčko a klepnout
    ('code11a', '42', 0x11, 0, None, None),
    # ★ a `$1B`, dva tóny — jiná místnost je **jiná úroveň** (`$76`)
    ('code1b', '42', 0x1B, 1, None, None),
    ('code11c', '07', 0x11, 2, None, None),
    # ★ klepnutí mimo mřížku je **vzdání** (`$A843`)
    ('codeout', '42', 0x11, 0, None,
     'idle:60,down:80,idle:2,fire:2,idle:40'),
    # ★ řídicí místnost bez hesla — jen se otočí (`$AA42`)
    ('ctrlnone', '42', 0x05, 0, None, 'idle:40'),
    # ★ a s ním: konzole, obrázek, věta 4 a blikání až do tabule
    ('ctrlfull', '42', 0x05, 0, '71 73 74 7f 6a 78 66 73 6c', 'idle:340'),
    ('ctrl1e', '1E', 0x05, 0, '71 73 74 7f 6a 78 66 73 6c', 'idle:340'),
)


# ★ Kam ruka musí stát, aby klepla na políčko `c`: sloupec je
# `((X+1) - $A2) >> 4` a řádek se porovnává se čtyřmi mezemi `$16`, `$2E`,
# `$46`, `$5E` nad `$A0` (`$A81B`-`$A841`). Střed políčka je tedy:
AIM_X0, AIM_Y = 0x24, (0x5A, 0x70, 0x88, 0xA0)
AIM_START_X, AIM_START_Y = 0x4F, 0x6D      # kde `$A7E2` ruku postaví


def aim_script(board, tones, level):
    """★ **Skript se počítá ze záznamu, ne hádá.** Kam generátor hodil
    kolik tónů, se dopředu neví — deska je losovaná. Nejdřív se proto
    natočí krátká sonda, z ní se přečte deska `$A8BE`, políčka se seřadí
    **podle výšky tónu** (to je, co `$A85E` chce) a teprve pak se sepíše
    cesta ruky. Jinak by se výhra nedala natočit vůbec."""
    filled = [(board[c], c) for c in range(32) if board[c] != 0xFF]
    filled.sort()
    # ★ **Napřed se musí dohrát předehra.** Každý tón trvá třiatřicet snímků
    # (`$A950`) a ruka se v nich hýbe taky (`$A9DA JSR $3E08`), jenže meze
    # i výchozí poloha se nastavují až **za** nimi (`$A7D2`). Kdo pohne pákou
    # dřív, hýbe rukou, kterou `$A7E2` stejně zase postaví doprostřed.
    parts, x, y = ['idle:%d' % (36 + 34*(level + 1))], AIM_START_X, AIM_START_Y
    for _tone, cell in filled[:level + 1]:
        want_x, want_y = AIM_X0 + 16*(cell & 7), AIM_Y[cell >> 3]
        if want_x > x:
            parts.append('right:%d' % (want_x - x))
        elif want_x < x:
            parts.append('left:%d' % (x - want_x))
        if want_y > y:
            parts.append('down:%d' % (want_y - y))
        elif want_y < y:
            parts.append('up:%d' % (y - want_y))
        parts += ['idle:2', 'fire:2', 'idle:40']
        x, y = want_x, want_y
    parts.append('idle:200')
    return ','.join(parts)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d'
                         % (total, MAX_FRAMES))
    base = os.path.join(a.dir, a.name)
    control = a.room == 0x05

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
    e.cmd('> %04x %02x' % (COUNTER, 0xFF))
    e.cmd('> %04x %02x' % (STUB_PAGE, (TABLE >> 8) - 1))
    # ★ dosazené: místnost, úroveň a heslo — záplaty záznamu, viz hlavička
    e.cmd('> %04x %02x' % (ROOM, a.room))
    for spot in LEVELS:
        e.cmd('> %04x %02x' % (spot, a.level))
    if a.password:
        e.cmd('> %04x %s' % (PASSWORD, a.password))
    if control and a.nospeech:
        e.cmd('> %04x %s' % (SPEECH_STUB,
                             ' '.join('%02x' % x for x in SPEECH_STUB_CODE)))
        e.cmd('> %04x %s' % (SPEECH_SITE,
                             ' '.join('%02x' % x for x in SPEECH_CODE)))
    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    e.cmd('bank ram')
    parts, bank = [], 'ram'
    for _name, lo, hi, want in DUMPS:
        if want != bank:
            parts.append('bank %s' % want)
            bank = want
        parts.append('m %04x %04x' % (lo, hi))
    if bank != 'ram':
        parts.append('bank ram')
    # ★ **Napřed ven z obsluhy přerušení.** Po `--start` snímcích stojí
    # emulátor na `$82E8`, tedy uvnitř IRQ: příznak `I` je nastavený a na
    # zásobníku leží návrat z přerušení. Kdo by odtud skočil na `$A771`,
    # zasekne se na prvním `$7F6B`, protože `$E0` už nikdy nestoupne (stálo
    # to jeden běh, 2026-09-21). Vrchol smyčky šachty je hlavní kontext.
    e.cmd('break exec $%04x' % SHAFT_LOOP)             # #1
    e.go()
    e.cmd('del 1')
    # ★ **Výpis z okamžiku, kdy místnost začíná.** Bez něj je první snímek
    # záznamu už za zamícháním šestnácti tónů a za rozházením desky, takže
    # by přepis musel začít z prostředka a míchačka by se rozešla hned
    # (stálo to jeden běh, 2026-09-21). Past na vstupu se ozve právě jednou.
    entry = CONTROL_ROOM if control else CODE_ROOM
    e.cmd('break exec $%04x' % entry)                  # #1
    e.on_break(1, '%s; g' % '; '.join(parts))
    e.cmd('break exec $%04x' % FRAME_TICK)             # #2
    e.on_break(2, '%s; g' % '; '.join(parts))
    if control:
        e.cmd('break exec $%04x' % TICK_DURING_SPEECH)  # #3
        e.on_break(3, '%s; g' % '; '.join(parts))
    # ★ **A kam se z místnosti vrátí.** `$A8B1 RTS` by sebral návratovou
    # adresu, kterou tam nikdo nepoložil, a stroj by se rozsypal — poslední
    # výpis by pak padl ještě **před** `$A896`, kde se úroveň zvedá, a výhra
    # by se nedala změřit. Na zásobník se proto položí vrchol smyčky šachty.
    e.cmd('r sp=fa')
    e.cmd('> 01fb %02x %02x' % ((SHAFT_LOOP - 1) & 0xFF, (SHAFT_LOOP - 1) >> 8))
    # ★ a **vstup do místnosti**: skok rovnou na rutinu, jako `tracepuzzle`
    e.cmd('r pc=$%04x' % entry)
    e.go()

    cycles = 150_000_000 + (a.start + total + 600)*CYCLES_PER_FRAME_PAL
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    frames = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in DUMPS])
    if len(frames) > total + 1:
        frames = frames[:total + 1]
    index = {
        'name': a.name, 'script': a.script, 'entropy': '%02X' % int(a.entropy, 16),
        'start': a.start, 'room': '$%02X' % a.room, 'level': a.level,
        'password': a.password, 'control': control, 'nospeech': bool(a.nospeech),
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'joy': ['%04X' % x for x in JOY_SITES],
        'stub': '%04X' % STUB, 'table': '%04X' % TABLE,
        'counter': '%04X' % COUNTER, 'passes': '%04X' % PASSES,
        'entry': '$%04X' % entry,
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in frames],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(frames) >= min(total, 8)
    print('tracespecial %s: %d snímků z %d, %s'
          % (a.name, len(frames), total + 1, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
    return 0 if ok else 1


def record_aimed(a):
    """Sonda, z ní deska, a teprve pak ostrý záznam (viz `aim_script`)."""
    import copy
    probe = copy.copy(a)
    probe.name, probe.script, probe.aim = a.name + '_probe', 'idle:%d' % (40 + 40*a.level), False
    if record(probe):
        return 1
    rec = json.load(open(os.path.join(a.dir, probe.name + '.json')))
    board = bytes.fromhex(rec['frames'][-1]['board'])
    tones = bytes.fromhex(rec['frames'][-1]['tones'])
    a.script = aim_script(board, tones, a.level)
    a.aim = False
    for suffix in ('.json', '.log', '.cmds', '.png', '_ram.bin', '_color.bin', '_vic.bin'):
        try:
            os.remove(os.path.join(a.dir, probe.name + suffix))
        except OSError:
            pass
    return record(a)


def record_set(a):
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, room, level, password, script = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.room, args.level, args.password, args.script = room, level, password, script
        args.aim = script is None
        args.nospeech = (name == 'ctrlquiet')
        return name, (record_aimed(args) if script is None else record(args))

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, SET_RUNS))
    bad = [n for n, rc in res if rc]
    print('tracespecial --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='idle:60,left:60,up:24,idle:2,fire:2,idle:60')
    ap.add_argument('--name', default='code11a')
    ap.add_argument('--dir', default='build/special')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--room', type=lambda x: int(x, 16), default=0x11,
                    help='$11 nebo $1B kódová, $05 řídicí')
    ap.add_argument('--level', type=int, default=0, help='úroveň kódové místnosti')
    ap.add_argument('--password', default=None,
                    help='devět znakových kódů hesla do $345D (hex, mezerami)')
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--nospeech', action='store_true',
                    help='vynechat `$AB23 JSR $BF51` a jen přehodit vektor IRQ')
    ap.add_argument('--aim', action='store_true',
                    help='natočit sondu, přečíst z ní desku a teprve pak ostrý záznam')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M5)')
    ap.add_argument('--jobs', type=int, default=3)
    a = ap.parse_args()
    if a.set:
        return record_set(a)
    return record_aimed(a) if a.aim else record(a)


if __name__ == '__main__':
    sys.exit(main())
