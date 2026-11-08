#!/usr/bin/env python3
"""traceroomlift — záznam jízdy výtahem **v místnosti**, snímek po snímku.

M3 měří výtahy dva a nejsou to dva pohledy na totéž. Ten v šachtě posouvá
okno znakových řádků (§20, `traceelevator.py`); ten **v místnosti** je
`$AC81` → `$ACEB`/`$AD7A` (§25) a dělá něco jiného: nechá stát obrazovku
a **překresluje sloupec plošin**, o jeden znakový řádek za dva snímky, a
s nimi hýbe třemi sprajty agenta po čtyřech pixelech za snímek.

Jednotka je proto **snímek**, jako u `traceplayer.py`, a tenhle nástroj je
jeho nástavba: tatáž záplatovaná hra (pevná entropie na `$82E3`, joystick na
všech osmnácti místech, roboti a koule vypnuté), týž výpis na `$8361` —
jen se k němu přidává **celá obrazovka místnosti a její barvy**, protože
jízda je vidět jenom tam. Bez nich by nula u `matchplayer` dokazovala jen to,
že se agent hýbe, ne že se pod ním hýbe výtah.

★ Skripty sady jsou **vyzkoumané přepisem**: aby záznam něco natočil, musí
agent stát přesně na sloupci výtahu (`$52` na některé z plošin, `$53` v jeho
dvou sloupcích), a to je v každé pevnosti jinde. Čísla v `SET_RUNS` vyšla
z `app/player.js` nad záznamy `build/player`, takže nejsou hádaná — a jestli
sedí, řekne měřidlo.

★ A **jen některé místnosti se dají měřit**: v místnosti s hodně nábytkem
originál jeden průchod smyčkou do snímku nevejde (§19) a výpis stavu padne
doprostřed rozdělané práce. Sada proto jede v místnostech, o kterých je ze
`traceplayer --set` vidět, že se v nich smyčka stíhá.

    ./tools/traceroomlift.py --name down42 --lead 'right:200' \
        --script 'right:8,idle:6,down:16,idle:10'
    ./tools/traceroomlift.py --set          # celá sada pro akceptaci

Měří to `tools/matchroomlift.mjs` proti `app/roomLift.js`.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, ROBOTS, BALL,
                         SPRITE_COLL, STUB, STUB_CODE, TICK_STUB, TICK_CODE,
                         TICK_SITE, LOOP_STUB, LOOP_CODE, LOOP_SITES, COUNTER,
                         TABLE, MAX_FRAMES, JOY_SITES, parse_script, parse_log)

# co se vypisuje na každém snímku; blok `zp` musí zůstat první, protože jím
# parser pozná nový snímek
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('ptr', 0x43F8, 0x43FF, 'ram'),
         ('harness', 0x0320, 0x0333, 'ram'),
         # ★ celá obrazovka místnosti, ne jen pás výtahu: sloupec plošin je
         # v každé místnosti jinde a jízda kreslí i tam, kde plošina nebyla
         ('screen', 0x4000, 0x43E7, 'ram'),
         ('color', 0xD800, 0xDBE7, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))

# (jméno, semínko, rozjezd, skript)
# ★ Každý skript dojde na sloupec výtahu, pustí páku (jinak by druhá jízda
# nezačala — `$83`, §25) a pak jezdí: dolů na dno, **dolů ještě raz** (to
# `$AD92` odmítne), a nahoru zpátky až na strop, kde ho odmítne `$AD07`.
SET_RUNS = (
    ('lift42a', '42', 'right:200',
     'right:8,idle:6,down:16,idle:6,down:10,idle:6,up:16,idle:6,up:10,idle:8'),
    ('lift07a', '07', 'right:200',
     'left:14,idle:6,down:16,idle:6,down:16,idle:6,down:10,idle:6,'
     'up:16,idle:6,up:16,idle:6,up:10,idle:8'),
    ('lift42b', '42', 'down:400,idle:10,right:200,idle:60',
     'right:22,idle:6,down:16,idle:6,down:10,idle:6,up:16,idle:6,up:10,idle:8'),
)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script)
    lead = parse_script(a.lead) if a.lead else []
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d' % (total, MAX_FRAMES))
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
    e.brk(GAME_IRQ)                                    # #1 — krok po snímcích
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('del 1')
    e.cmd('bank ram')
    for site in (ROBOTS, BALL, SPRITE_COLL):
        e.cmd('> %04x 60' % site)
    for at in range(0, 256, 16):
        e.cmd('> %04x %s' % (TABLE + at, ' '.join('%02x' % x for x in table[at:at+16])))
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
    for site in JOY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, STUB & 0xFF, STUB >> 8))
    e.cmd('> %04x %02x' % (COUNTER, 0xFE if lead else 0xFF))
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
    e.cmd('command 1 "%s"' % '; '.join(parts + ['g']))
    e.go()

    cycles = (150_000_000
              + (a.start + sum(n for _, _, n in lead) + total + 60)*CYCLES_PER_FRAME_PAL)
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    frames = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in DUMPS])
    if len(frames) > total + 1:
        frames = frames[:total + 1]
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead,
        'entropy': '%02X' % int(a.entropy, 16), 'start': a.start, 'robots': False,
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        'place': (frames[0]['zp'][0x1A] if frames else None),
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in frames],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    ok = len(frames) >= total + 1
    print('traceroomlift %s: %d snímků z %d, %s'
          % (a.name, len(frames), total + 1, 'ok' if ok else 'CHYBÍ — víc cyklů?'))
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
    print('traceroomlift --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='right:8,idle:6,down:16,idle:10')
    ap.add_argument('--lead', default='right:200')
    ap.add_argument('--name', default='lift42a')
    ap.add_argument('--dir', default='build/roomlift')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M3)')
    ap.add_argument('--jobs', type=int, default=3)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
