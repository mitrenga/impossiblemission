#!/usr/bin/env python3
"""tracedeath — záznam **umírání** v originálu, `$95DA`.

Když `$94FA` nastaví `$43`, jde hra na `$95DA` a udělá celý obřad
(`sources/docs/disasm_notes.md` §31): rozpustí agentovy tři sprajty na
místě, vrátí výtahy místnosti tam, kde začínaly, postaví znovu roboty
a kouli, postaví agenta na vstupní pozici — a **přidá deset minut
hodinám**.

★ **Snímek tu není jednotka.** `$95E8` udělá `SEI` a `CLI` přijde až na
`$96F5`, takže po celou dobu obřadu neběží obsluha přerušení: `$E0` stojí,
hodiny stojí, roboti stojí a past na `$8361` se ani jednou neozve. Je to
totéž, co dělá bezpečnostní terminál (§29), a záznam se proto dělá stejně —
**zastávkami**, ne snímky:

| past | co už proběhlo |
|---|---|
| `$95E8` | rozhodlo se, že se umírá (v šachtě se neumírá, `$95E1`) |
| `$9643` | **jedno kolo rozpouštění** — 49 bajtů ve všech třech blocích |
| `$966C` | rozpouštění hotové, začíná stavba |
| `$96F5` | stavba hotová: místnost stojí, agent stojí, hodiny jsou o deset minut dál |
| `$9707` | konec — ★ ale **až za `CLI`**, takže do stavu už sáhlo přerušení |

★ Zastávka `$96F5` je tam právě kvůli té poslední poznámce. `CLI` pustí
obsluhu přerušení dřív, než obřad doběhne, a ta v těch pár desítkách cyklů
stihne pustit kolize, roboty i kouli — takže `$18`/`$19` jsou na `$9707`
cizí a `$D01E` je vyčištěné **jí**, ne obřadem. Měřit se dá jen to, co je
**před** `CLI`.

★ A na rozdíl od terminálu se sem **nedá dojít skriptem**: agent musí na
něco doopravdy narazit. Záznam proto nechá běžet **roboty, kouli
i kolize** (`traceplayer --collision` je vypíná jen ve svých vlastních
záznamech) a jede tak dlouho, až se pasti ozvou. Semínka a skripty, ve
kterých se to stane, jsou vybrané měřením: `deathrobot42` je týž běh, ve
kterém `matchcollision` hlásí smrt na 94. snímku.

    ./tools/tracedeath.py --name deathrobot42 --entropy 42 \\
        --lead 'right:200' --script 'right:250'
    ./tools/tracedeath.py --set          # celá sada pro akceptaci

Měří to `tools/matchdeath.mjs` proti `app/death.js`.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, STUB, STUB_CODE,
                         TICK_STUB, TICK_CODE, TICK_SITE, LOOP_STUB, LOOP_CODE,
                         LOOP_SITES, COUNTER, TABLE, MAX_FRAMES, JOY_SITES,
                         parse_script, parse_log)

# co se vypisuje na každé zastávce; blok `zp` musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('ptr', 0x43F8, 0x43FF, 'ram'),
         ('harness', 0x0320, 0x033F, 'ram'),
         # ★ **tři bloky, do kterých se agent rozpouští**: `$9720` tam jeho
         # sprajty zkopíruje a přesměruje na ně ukazatele, a teprve pak se
         # z nich po bajtech vyhazují body (`$97D7`)
         ('blocks', 0x4D80, 0x4E3F, 'ram'),
         # ★ **záznamy místností**: lift reset (`$A0F5`) přepisuje seznam
         # výtahů té, ve které se umřelo, kopií z `$2016` — a stav výtahu si
         # záznam nese (§25), takže bez tohohle bloku by se nedalo doložit,
         # že se výtahy vrátily
         ('records', 0x0E00, 0x1DFF, 'ram'),
         ('screen', 0x4000, 0x43FF, 'ram'),
         ('color', 0xD800, 0xDBFF, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))

# pasti uvnitř `$95DA` (viz hlavička)
TRAPS = (0x95E8, 0x9643, 0x966C, 0x96F5, 0x9707)
# ★ **Která past se ozvala, říká značka, ne kód.** Monitor VICE umí k pasti
# pověsit celý seznam příkazů, takže první z nich zapíše číslo pasti do
# `$0335` a teprve pak se vypisuje. Nic se tím do hry nezaplátuje — a to je
# tady podstatné: `$95E8` je **`SEI`, jeden bajt**, a tříbajtové `JSR` by
# přepsalo `JSR $9720` hned za ním.
STOP_MARK = 0x0335

# (jméno, semínko, rozjezd, skript)
# ★ **Vybrané měřením, ne odhadem.** Do robota se ve dvou stech snímcích
# nenarazí v každé pevnosti — v šestnácti vyzkoušených během chodil agent
# vedle nich. Sada je proto ta dvojice, u které `matchcollision` smrt hlásí
# (`collwalk42` na 94. snímku, `collroom07` na 119.); kdo hledá další, ať se
# zeptá `build/collision` tímhle způsobem, ne náhodnými skripty.
DOWN = 'down:400,idle:10,right:200,idle:60'
DEEP = 'right:200,right:250,idle:60'
SET_RUNS = (
    ('deathrobot42', '42', 'right:200', 'right:250'),
    ('deathroom07', '07', DOWN, 'right:250'),
    # ★ o místnost dál: jiná pevnost, jiný seznam výtahů, jiní roboti
    ('deathdeep5A', '5A', DEEP, 'right:250'),
    ('deathdeep6E', '6E', DEEP, 'right:250'),
)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    lead = parse_script(a.lead) if a.lead else []
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d'
                         % (total, MAX_FRAMES))
    base = os.path.join(a.dir, a.name)

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
    e.brk(GAME_IRQ)
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('del 1')
    e.cmd('bank ram')
    # ★ roboti, koule **ani kolize se nevypínají** — bez nich není na co umřít
    for at in range(0, 256, 16):
        e.cmd('> %04x %s' % (TABLE + at, ' '.join('%02x' % x for x in table[at:at+16])))
    e.cmd('> %04x %s' % (STUB, ' '.join('%02x' % x for x in STUB_CODE)))
    e.cmd('> %04x %s' % (TICK_STUB, ' '.join('%02x' % x for x in TICK_CODE)))
    e.cmd('> %04x %s' % (LOOP_STUB, ' '.join('%02x' % x for x in LOOP_CODE)))
    e.cmd('> %04x 20 %02x %02x' % (TICK_SITE, TICK_STUB & 0xFF, TICK_STUB >> 8))
    for site in LOOP_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, LOOP_STUB & 0xFF, LOOP_STUB >> 8))
    e.cmd('break exec $%04x' % FRAME_TICK)
    for _token, value, frames in lead:
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, value))
        e.ignore(1, max(0, frames - 1))
        e.go()
    for site in JOY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, STUB & 0xFF, STUB >> 8))
    e.cmd('> %04x %02x' % (COUNTER, 0xFE if lead else 0xFF))
    e.cmd('> %04x ff' % STOP_MARK)
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
    dump = '; '.join(parts)
    e.cmd('del')
    for i, at in enumerate(TRAPS):
        e.brk(at)
        e.on_break(i + 1, '> %04x %02x; %s; g' % (STOP_MARK, i, dump))
    e.go()

    cycles = (150_000_000
              + (a.start + sum(n for _, _, n in lead) + total + 200)*CYCLES_PER_FRAME_PAL)
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    stops = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in DUMPS])
    # ★ Záznam se uzavře **druhým obřadem**: agent po smrti stojí na vstupní
    # pozici, skript ho žene dál doprava a on může narazit znovu. Měří se
    # jeden obřad, ten první.
    kept = []
    for f in stops:
        mark = f['harness'][STOP_MARK - 0x0320]
        if mark == 0 and kept:
            break                       # druhý obřad — agent umřel znovu
        kept.append(f)
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead,
        'entropy': '%02X' % int(a.entropy, 16), 'start': a.start, 'robots': True,
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        'traps': ['$%04X' % x for x in TRAPS],
        'stopMark': '$%04X' % STOP_MARK,
        'trapOf': [f['harness'][STOP_MARK - 0x0320] for f in kept],
        'death': (kept[0]['zp'][0x43] if kept else None),
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in kept],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(kept) >= 3
    print('tracedeath %s: %d zastávek, smrt druhu %s, %s'
          % (a.name, len(kept), index['death'],
             'ok' if ok else 'CHYBÍ — agent v tom běhu neumřel?'))
    return 0 if ok else 1


def record_set(a):
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, lead, script = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.lead, args.script = lead, script
        return name, record(args)

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, SET_RUNS))
    bad = [n for n, rc in res if rc]
    print('tracedeath --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='right:250')
    ap.add_argument('--lead', default='right:200')
    ap.add_argument('--name', default='deathrobot42')
    ap.add_argument('--dir', default='build/death')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M4)')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
