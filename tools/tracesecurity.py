#!/usr/bin/env python3
"""tracesecurity — záznam **bezpečnostního terminálu** v originálu.

Nábytek, který má v délce prohledávání `$FF`, nepustí `$97F1`, ale `$9D09`
(`sources/docs/disasm_notes.md` §29): terminál si vezme **celou obrazovku**,
schová pod ni místnost (`$C100`) a její barvy (`$0400`) a registry VIC na
zásobník, a nabídne tři položky — lift reset, snooze a odchod.

Měří se proto víc než u prohledávání:

| blok | proč |
|---|---|
| `$4000`–`$43FF` a `$D800`–`$DBFF` | **obrazovka terminálu** i s **ukazateli sprajtů** na jejím konci |
| `$C100`–`$C4FF` a `$0400`–`$07FF` | **místnost schovaná pod ním** — a lift reset do ní kreslí |
| `$1900`–`$19FF` | **záznam té místnosti**, jehož seznam výtahů lift reset vrací na začátek |
| `$3430`–`$344F` | **počitadla v panelu šachty**, ze kterých terminál ubírá |
| registry VIC | terminál je celé přenastaví a na konci vrátí |

★ **Počitadla se dají dosadit** (`--counters`): `$3439` je jen dvojice
znakových kódů v panelu šachty, a bez nich by terminál uměl jenom říct
„password required". Je to **záplata záznamu**, ne pravidlo hry — stejná
jako vypnutí robotů — a bez ní se druhá polovina `$A194` nedá natočit
v žádné z měřitelných pevností, protože nábytek s `$FC` v nich není.

★ **A snímek tu není jednotka.** `$9D14` udělá `SEI` a `CLI` přijde až na
`$9ED8`, takže **po celou dobu terminálu neběží obsluha přerušení**: `$E0`
stojí, hodiny stojí, roboti stojí a past na `$8361` se ani jednou neozve.
Jednotka je proto **průchod menu**, jako u výtahu je jednotka krok (§20):

| past | co už proběhlo |
|---|---|
| `$9E50` | obrazovka terminálu je postavená a rozsvícená |
| `$9F8C` | jedno čtení páky (past je **hned za ním**, protože se středovou pákou se na `$9F96` vůbec nedojde) |
| `$9ED9` | místnost je vrácená a přerušení zapnuté |

★ A protože `$E0` stojí, nemůže se joystick brát z tabulky indexované
snímkem. Terminál má proto **vlastní tabulku na `$0800`** (těsně pod
programem) a **vlastní počitadlo průchodů** na `$0334`: `$9F68` ho zvedne
a `$9F5D` i `$9F89` čtou tutéž položku, takže **jeden průchod menu je jedna
položka skriptu**.

    ./tools/tracesecurity.py --name term42 --entropy 42 \\
        --lead 'right:200,left:32,idle:6' --script 'up:8,idle:40,upfire:4,idle:20'
    ./tools/tracesecurity.py --set          # celá sada pro akceptaci

Měří to `tools/matchsecurity.mjs` proti `app/terminal.js`.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, ROBOTS, BALL,
                         SPRITE_COLL, STUB, STUB_CODE, TICK_STUB, TICK_CODE,
                         TICK_SITE, LOOP_STUB, LOOP_CODE, LOOP_SITES, COUNTER,
                         TABLE, MAX_FRAMES, JOY_SITES, parse_script, parse_log)

# co se vypisuje na každém snímku; blok `zp` musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('ptr', 0x43F8, 0x43FF, 'ram'),
         ('harness', 0x0320, 0x033F, 'ram'),
         ('counters', 0x3430, 0x344F, 'ram'),
         # ★ **okno záznamu místnosti**, ne všech 3 764 bajtů: lift reset sahá
         # jen na seznam výtahů té jedné místnosti, ve které agent stojí, a
         # celý blok by z výpisu udělal osm kilobajtů na snímek — po dvou
         # snímcích emulátor skončil (2026-09-20)
         ('record', 0x1900, 0x19FF, 'ram'),
         # ★ **Celé čtyři stránky, ne tisíc bajtů.** Za obrazovkou leží
         # **ukazatele sprajtů `$43F8`-`$43FF`**, které si terminál přepisuje
         # na svoje — a přepis, který odkládal jen tisíc bajtů, se do hry
         # vracel s ukazateli terminálu a roboti byli rozsypaní. Úzké okno
         # to minulo (2026-09-20), tak je široké.
         ('parked', 0xC100, 0xC4FF, 'ram'),
         ('parkedColor', 0x0400, 0x07FF, 'ram'),
         ('screen', 0x4000, 0x43FF, 'ram'),
         ('color', 0xD800, 0xDBFF, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))

COUNTERS = 0x3439        # dvě číslice v panelu šachty ($A21A: $0D a $00)
COUNTER_SPOTS = (0x0D, 0x00)

# ★ vlastní joystick terminálu: tabulka pod programem a počitadlo průchodů
TERM_TABLE = 0x0800
TERM_COUNT = 0x0334
TERM_STEP = 0x0380       # INC počitadlo; LDY počitadlo; LDA tabulka,Y; RTS
TERM_READ = 0x0390       #                LDY počitadlo; LDA tabulka,Y; RTS
TERM_STEP_CODE = (0xEE, TERM_COUNT & 0xFF, TERM_COUNT >> 8,
                  0xAC, TERM_COUNT & 0xFF, TERM_COUNT >> 8,
                  0xB9, TERM_TABLE & 0xFF, TERM_TABLE >> 8, 0x60)
TERM_READ_CODE = (0xAC, TERM_COUNT & 0xFF, TERM_COUNT >> 8,
                  0xB9, TERM_TABLE & 0xFF, TERM_TABLE >> 8, 0x60)
TERM_STEP_SITE = 0x9F68          # čtení střelby na vrcholu smyčky menu
TERM_READ_SITES = (0x9F5D, 0x9F89)
# pasti: postavený terminál, jeden průchod menu, vrácená místnost
TRAPS = (0x9E50, 0x9F8C, 0x9ED9)
MAX_STEPS = 128

# (jméno, semínko, rozjezd, skript, počitadla)
# ★ Tři případy, které `$A194` rozlišuje: **nic k utracení** („password
# required"), **snooze** a **lift reset** („password accepted"), a k tomu
# pohyb kurzoru nahoru i dolů a odchod.
SET_RUNS = (
    # ★ Skript je **po průchodech menu**: `idle` nechá páku na středu (a tím
    # shodí západku `$83`), `up`/`down` pohne kurzorem o jednu položku
    # a `fire` vybere. Každý skript **končí odchodem**, jinak by terminál
    # běžel dál až do limitu cyklů.
    ('termnone42', '42', 'right:200,left:32,idle:6',
     'idle:2,up:1,idle:1,up:1,idle:1,fire:1,idle:2,down:1,idle:1,fire:1,'
     'idle:2,down:1,idle:1,fire:1,idle:2', None),
    ('termsnooze42', '42', 'right:200,left:32,idle:6',
     'idle:2,up:1,idle:1,fire:1,idle:3,down:1,idle:1,fire:1,idle:2', 0x85),
    ('termlift42', '42', 'right:200,left:32,idle:6',
     'idle:2,up:1,idle:1,up:1,idle:1,fire:1,idle:3,down:1,idle:1,'
     'down:1,idle:1,fire:1,idle:2', 0x85),
)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    lead = parse_script(a.lead) if a.lead else []
    total = sum(n for _, _, n in script)
    if total > MAX_STEPS:
        raise SystemExit('záznam má %d průchodů, harness jich unese %d'
                         % (total, MAX_STEPS))
    base = os.path.join(a.dir, a.name)

    # ★ tabulka je **po průchodech menu**, ne po snímcích (viz hlavička)
    table = [0x7F]*MAX_STEPS
    step = 0
    for _token, value, steps in script:
        for _ in range(steps):
            table[step] = value
            step += 1

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
    e.cmd('break exec $%04x' % FRAME_TICK)             # #1
    for _token, value, frames in lead:
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, value))
        e.ignore(1, max(0, frames - 1))
        e.go()
    # ★ Po rozjezdu zůstane joystick **zaražený na „nahoru"** prostou
    # záplatou: terminál se tím otevře a dál už ho řídí jeho vlastní tabulka.
    for site in JOY_SITES:
        e.cmd('> %04x a9 7e ea' % site)
    # ★ Stuby terminálu se sázejí **až po rozjezdu**: rozjezd přepisuje
    # všech osmnáct čtení `$DC00` (§7) a tři z nich jsou zrovna ta, která
    # patří terminálu — kdyby se nasadily dřív, rozjezd by je přemazal
    # a menu by celou dobu vidělo páku na středu (stálo to běh, 2026-09-20).
    for at in range(0, MAX_STEPS, 16):
        e.cmd('> %04x %s' % (TERM_TABLE + at,
                             ' '.join('%02x' % x for x in table[at:at+16])))
    e.cmd('> %04x %s' % (TERM_STEP, ' '.join('%02x' % x for x in TERM_STEP_CODE)))
    e.cmd('> %04x %s' % (TERM_READ, ' '.join('%02x' % x for x in TERM_READ_CODE)))
    e.cmd('> %04x %02x' % (TERM_COUNT, 0xFF))
    e.cmd('> %04x 20 %02x %02x' % (TERM_STEP_SITE, TERM_STEP & 0xFF, TERM_STEP >> 8))
    for site in TERM_READ_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, TERM_READ & 0xFF, TERM_READ >> 8))
    e.cmd('> %04x %02x' % (COUNTER, 0xFE if lead else 0xFF))
    # ★ dosazená počitadla — záplata záznamu, viz hlavička
    if a.counters is not None:
        for spot in COUNTER_SPOTS:
            e.cmd('> %04x %02x' % (COUNTERS + spot, int(a.counters)))
    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    e.cmd('bank ram')
    # past, která vypisuje stav a hned se vrací do hry — **jedno `g`**
    parts, bank = [], 'ram'
    for _name, lo, hi, want in DUMPS:
        if want != bank:
            parts.append('bank %s' % want)
            bank = want
        parts.append('m %04x %04x' % (lo, hi))
    if bank != 'ram':
        parts.append('bank ram')
    dump = '; '.join(parts)
    # ★ past není snímek, jsou to tři místa v terminálu (viz hlavička):
    # postavený terminál, jeden průchod menu a vrácená místnost
    e.cmd('del')
    for i, at in enumerate(TRAPS):
        e.brk(at)
        e.on_break(i + 1, '%s; g' % dump)
    e.go()

    cycles = (150_000_000
              + (a.start + sum(n for _, _, n in lead) + total*2 + 400)*CYCLES_PER_FRAME_PAL)
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    frames = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in DUMPS])
    # ★ Záznam se uzavře **první zastávkou, ve které se nepohnulo počitadlo
    # průchodů**: to je `$9ED9`, tedy vrácená místnost. Dál už agent drží
    # páku nahoru dál a terminál se otevře znovu — a to už není co měřit.
    # ★ Zastávka, ve které se počitadlo **nepohnulo**, je už **další
    # otevření** terminálu: agent drží páku nahoru dál, takže se `$9D09`
    # pustí znovu. Zahodí se tedy ona i všechno za ní; poslední, co zůstane,
    # je `$9ED9` — vrácená místnost.
    kept, last = [], None
    for f in frames:
        count = f['harness'][TERM_COUNT - 0x0320]
        if last is not None and count == last:
            break
        kept.append(f)
        last = count
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead,
        'entropy': '%02X' % int(a.entropy, 16), 'start': a.start, 'robots': False,
        'counters': a.counters,
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'segments': [{'token': t, 'value': '%02X' % v, 'steps': n} for t, v, n in script],
        'traps': ['$%04X' % x for x in TRAPS],
        'table': '$%04X' % TERM_TABLE, 'counter': '$%04X' % TERM_COUNT,
        'place': (frames[0]['zp'][0x1A] if frames else None),
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in kept],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    frames = kept
    ok = len(frames) >= 3
    print('tracesecurity %s: %d zastávek (skript má %d průchodů), %s'
          % (a.name, len(frames), total, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
    return 0 if ok else 1


def record_set(a):
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, lead, script, counters = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.lead, args.script, args.counters = lead, script, counters
        return name, record(args)

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, SET_RUNS))
    bad = [n for n, rc in res if rc]
    print('tracesecurity --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='up:8,idle:20,upfire:4,idle:20')
    ap.add_argument('--lead', default='right:200,left:32,idle:6')
    ap.add_argument('--name', default='termnone42')
    ap.add_argument('--dir', default='build/security')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--counters', default=None,
                    help='dosadit obě počitadla v panelu šachty (hex znakový kód)')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M3)')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
