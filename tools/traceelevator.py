#!/usr/bin/env python3
"""traceelevator — záznam jízdy výtahem v originálu, krok po kroku.

M3 měří **výtah**: `$855A` (nahoru) a `$8590` (dolů) posunou okno šachty
o jeden znakový řádek a složí nový řádek na uvolněném okraji
(`sources/docs/disasm_notes.md` §20). Jeden krok jsou **dva snímky**, takže
snímek tady není jednotka — jednotka je **krok**.

Nástroj proto neláme běh po snímcích jako `traceplayer.py`, ale zastavuje se
přesně tam, kde je krok hotový:

| past | co už proběhlo |
|---|---|
| `$8587` | `$74C0` + `$75A5` + `$7749` + `$85B3` — celý krok nahoru |
| `$85AA` | `$744B` + `$7631` + `$85B3` + `$73CA` — celý krok dolů |

Aby bylo z výpisu poznat, kterým směrem se jelo, přepíše se `JSR $85B3`
v obou rutinách na vlastní útržek, který si směr poznamená na `$0320`
a napočítá kroky na `$0321`/`$0322`; snímky počítá `$0340` v obsluze
přerušení, takže z jednoho záznamu je vidět i **kadence** (má vyjít dva
snímky na krok).

Jinak je to táž záplatovaná hra jako u `traceplayer.py`: pevná entropie
na `$82E3` (§8), joystick na všech osmnácti místech (§7, §12), roboti a
koule vypnuté.

    ./tools/traceelevator.py --script down --steps 60 --name down42
    ./tools/traceelevator.py --set          # celá sada pro akceptaci

Měří to `tools/matchelevator.mjs` proti `app/elevator.js`.
"""
import argparse, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, ROBOTS, BALL, SPRITE_COLL,
                         JOY_SITES, NAMES, parse_script)

UP_DONE = 0x8587                 # za `JSR $85B3` v `$855A`
DOWN_DONE = 0x85AA               # za `JSR $73CA` v `$8590`
UP_SITE = 0x8584                 # `JSR $85B3` v kroku nahoru
DOWN_SITE = 0x85A4               # `JSR $85B3` v kroku dolů
UP_STUB, DOWN_STUB = 0x0300, 0x0310
DIRECTION, UP_COUNT, DOWN_COUNT, FRAME_COUNT = 0x0320, 0x0321, 0x0322, 0x0323
# ★ `$E0` v okamžiku, kdy se překresluje kabina: barva jejího sprajtu bliká
# podle čítače snímků, a ten je jediný vstup kroku zvenčí (`$73E4`)
CABIN_E0 = 0x0324
CABIN_STUB = 0x0350
CABIN_CODE = (0xA5, 0xE0, 0x8D, CABIN_E0 & 0xFF, CABIN_E0 >> 8, 0x4C, 0xE4, 0x73)
CABIN_SITES = (0x3A8E, 0x3AAE)   # `JSR $73E4` za krokem nahoru a dolů
# LDA #dir; STA $0320; INC počitadlo; JMP $85B3
def stub(direction, counter):
    return (0xA9, direction, 0x8D, DIRECTION & 0xFF, DIRECTION >> 8,
            0xEE, counter & 0xFF, counter >> 8, 0x4C, 0xB3, 0x85)
TICK_STUB = 0x0340               # čítač snímků v obsluze přerušení
TICK_CODE = (0xEE, FRAME_COUNT & 0xFF, FRAME_COUNT >> 8, 0x4C, 0x98, 0x83)
TICK_SITE = 0x8365               # `JSR $8398` v obsluze (§19)
FRAME_TICK = 0x8361              # `INC $E0`, jednou za snímek — krok rozjezdu

# co se vypisuje na každém kroku; pořadí = pořadí v logu, a **první blok
# otevírá nový krok**, takže nultá stránka musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('harness', 0x0320, 0x0324, 'ram'),
         ('screen', 0x4000, 0x425F, 'ram'),   # okno šachty, řádky 0-14
         ('marks', 0xFF30, 0xFF8F, 'ram'),    # kudy kabina jela po mapě
         ('color', 0xD800, 0xDA5F, 'io'),     # barvy okna
         ('vic', 0xD000, 0xD02E, 'io'))
# ★ `$FF30` je pod KERNALem, takže se čte v bance `ram`, ne `io`.
# ★ `screen` i `color` musí být celé okno: krok výtahu sahá na obě strany
# šachty naráz a nový řádek se objevuje jednou nahoře a jednou dole.

SET_SEEDS = ('42', '07', '99', 'C3')
SET_RUNS = (
    # (jméno, rozjezd ve snímcích, směr, kroků)
    ('down', '', 'down', 80),
    ('up', 'down:600', 'up', 80),
    # ★ Na dno i pod strop se **dojede v samotném záznamu**: jakmile se `$1D`
    # nebo `$1E` zvedne, krok se přestane volat a past se přestane ozývat,
    # takže rozjezdem by se konec šachty právě minul (stalo se 2026-09-19).
    ('bottom', '', 'down', 340),
    # ★ Hra **začíná pod stropem** (`$1D` = 1, `$1F` = `$20` = `$0B`), takže
    # záznam „nahoru" bez rozjezdu nemá co natočit: `$855A` se hned vrátí.
    ('top', 'down:600', 'up', 340)
)


def standard_set():
    out = []
    for seed in SET_SEEDS:
        for name, lead, direction, steps in SET_RUNS:
            out.append(('%s%s' % (name, seed), seed, lead, direction, steps))
    return out


def parse_log(path):
    """Z logu monitoru poskládá kroky (tvar je `traceplayer.parse_log`)."""
    blocks = list(DUMPS)
    steps, cur = [], None
    head = re.compile(r'^>C:([0-9a-f]{4})\s')
    for line in open(path, errors='replace'):
        m = head.match(line)
        if not m:
            continue
        addr = int(m.group(1), 16)
        blk = next((b for b in blocks if b[1] <= addr <= b[2]), None)
        if blk is None:
            continue
        name, lo, hi = blk[0], blk[1], blk[2]
        data = [int(x, 16) for x in line.split('   ')[0].split()[1:]]
        if addr == lo:
            if name == DUMPS[0][0]:
                if cur:
                    steps.append(cur)
                cur = {}
            if cur is None:
                continue
            cur[name] = []
        if cur is None or name not in cur:
            continue
        cur[name] += data
        del cur[name][hi - lo + 1:]
    if cur:
        steps.append(cur)
    sizes = {b[0]: b[2] - b[1] + 1 for b in DUMPS}
    return [s for s in steps if all(len(s.get(n, [])) == z for n, z in sizes.items())]


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    base = os.path.join(a.dir, a.name)
    lead = parse_script(a.lead) if a.lead else []
    ride = NAMES[a.script]

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
    # čítač snímků v obsluze přerušení — jen kvůli kadenci
    e.cmd('> %04x %s' % (TICK_STUB, ' '.join('%02x' % x for x in TICK_CODE)))
    e.cmd('> %04x 20 %02x %02x' % (TICK_SITE, TICK_STUB & 0xFF, TICK_STUB >> 8))
    e.cmd('break exec $%04x' % FRAME_TICK)             # #1 — rozjezd po snímcích
    for _token, value, frames in lead:
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, value))
        e.ignore(1, max(0, frames - 1))
        e.go()
    e.cmd('del 1')
    # od téhle chvíle drží joystick směr jízdy a nic jiného
    for site in JOY_SITES:
        e.cmd('> %04x a9 %02x ea' % (site, ride))
    # útržky, které si poznamenají směr a napočítají kroky
    e.cmd('> %04x %s' % (UP_STUB, ' '.join('%02x' % x for x in stub(1, UP_COUNT))))
    e.cmd('> %04x %s' % (DOWN_STUB, ' '.join('%02x' % x for x in stub(2, DOWN_COUNT))))
    e.cmd('> %04x 20 %02x %02x' % (UP_SITE, UP_STUB & 0xFF, UP_STUB >> 8))
    e.cmd('> %04x 20 %02x %02x' % (DOWN_SITE, DOWN_STUB & 0xFF, DOWN_STUB >> 8))
    e.cmd('> %04x %s' % (CABIN_STUB, ' '.join('%02x' % x for x in CABIN_CODE)))
    for site in CABIN_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, CABIN_STUB & 0xFF, CABIN_STUB >> 8))
    e.cmd('> %04x 00 00 00 00 00' % DIRECTION)
    # výchozí stav: celá paměť, barvy a VIC v okamžiku, kdy záznam začíná
    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    # past, která vypisuje stav a hned se vrací do hry — **jedno `g`**, jinak
    # by se log ztratil (`quit` v GTK buildu monitor neukončí)
    parts, bank = [], None
    for _name, lo, hi, want in DUMPS:
        if want != bank:
            parts.append('bank %s' % want)
            bank = want
        parts.append('m %04x %04x' % (lo, hi))
    dump = '; '.join(parts)
    e.brk(UP_DONE)                                     # #1
    e.on_break(1, '%s; g' % dump)
    e.brk(DOWN_DONE)                                   # #2
    e.on_break(2, '%s; g' % dump)
    e.go()

    # limit cyklů: rozjezd, kroky po dvou snímcích a rezerva
    frames = a.start + sum(n for _, _, n in lead) + a.steps*2 + 120
    r = e.run(cycles=150_000_000 + frames*CYCLES_PER_FRAME_PAL,
              screenshot='%s.png' % base, monlog='%s.log' % base,
              moncmds='%s.cmds' % base, timeout=a.timeout)

    steps = parse_log('%s.log' % base)
    if len(steps) > a.steps + 1:
        steps = steps[:a.steps + 1]
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead,
        'entropy': '%02X' % int(a.entropy, 16), 'start': a.start,
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'traps': {'up': '$%04X' % UP_DONE, 'down': '$%04X' % DOWN_DONE},
        'harness': {'direction': '$%04X' % DIRECTION, 'up': '$%04X' % UP_COUNT,
                    'down': '$%04X' % DOWN_COUNT, 'frames': '$%04X' % FRAME_COUNT,
                    'cabinFrame': '$%04X' % CABIN_E0},
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'steps': [{k: ''.join('%02x' % b for b in s[k]) for k in s} for s in steps],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(steps) >= 2
    print('traceelevator %s: %d kroků z %d, %s'
          % (a.name, len(steps), a.steps + 1, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
    return 0 if ok else 1


def record_set(a):
    import copy
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, lead, direction, steps = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.lead, args.script, args.steps = lead, direction, steps
        return name, record(args)

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, standard_set()))
    bad = [n for n, rc in res if rc]
    print('traceelevator --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='down', choices=('up', 'down'))
    ap.add_argument('--steps', type=int, default=60)
    ap.add_argument('--lead', default='', help='úseky `jméno:snímky`, které se '
                    'odehrají, ale nezaznamenají')
    ap.add_argument('--name', default='down')
    ap.add_argument('--dir', default='build/elevator')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M3)')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
