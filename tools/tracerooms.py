#!/usr/bin/env python3
"""tracerooms — stavitel místností originálu pro všech 32 místností.

Místnost staví **`$A39C`**, volá ho `$8B9E` hned po tom, co `$8B96` vezme
číslo místnosti z mřížky `$FF96` do `$7E` (`sources/docs/disasm_notes.md`
§12). Nástroj se na `$8B9E` zastaví, **dosadí číslo místnosti** a pustí jen
ten jeden `JSR`; pak uloží paměť před a po. Proti té dvojici měří
`tools/matchrooms.mjs` přepis `app/roomBuild.js`.

Aby byl jeden `JSR` opakovatelný, jsou dvě záplaty, obě doložené:

- **`$7F6B` → `RTS`**: je to čekání na `$E0`, počitadlo snímků obsluhy
  přerušení (`$A3C3  JSR $7F6B`). Nic nezapisuje, jen zdržuje, a bez
  přerušení by se zacyklilo.
- **přerušení vypnutá** (`$D01A = 0`, `$DC0D`/`$DD0D` = `$7F`, `$D019` = `$FF`):
  jinak obsluha hry mezi zastávkami hýbe sprajty a pamětí, a rozdíl
  před/po by nebyl jen prací stavitele.

Do místnosti se hra nejdřív musí dostat — joystick se podstrčí na **všech
18 místech**, kde hra čte `$DC00` (§7 mluví o dvou, to je jen výtah).

    ./tools/tracerooms.py [--entropy 42] [--dir build/rooms] [--rooms 0-31]
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME

BUILD_CALL = 0x8B9E          # JSR $A39C
BUILD_DONE = 0x8BA1          # hned za ním
ROOM_NO = 0x7E               # číslo místnosti
ENTRY_SIDE = 0x7F            # 0 = zleva, 1 = zprava
ENTROPY_SITE = 0x82E3
DELAY = 0x7F6B               # čekání na $E0
# ★ všech 18 čtení `LDA $DC00` v herním kódu (mimo obsluhu klávesnice $BEB2)
JOY_SITES = (0x3A3C, 0x3A7C, 0x3A85, 0x3AA4, 0x3B1E, 0x3E17, 0x7263, 0x81EA,
             0x81F1, 0x87F1, 0x8849, 0x98B8, 0x99C7, 0x9F5D, 0x9F68, 0x9F89,
             0xA808, 0xACCF)
RIGHT = 0x77


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--dir', default='build/rooms')
    ap.add_argument('--rooms', default='0-31')
    ap.add_argument('--side', type=int, default=0, help='0 = vstup zleva, 1 = zprava')
    ap.add_argument('--start', type=int, default=14000, help='snímků, než se hra rozjede')
    ap.add_argument('--walk', type=int, default=300, help='snímků doprava do místnosti')
    ap.add_argument('--fast', action='store_true')
    a = ap.parse_args()

    lo, hi = (a.rooms.split('-') + [a.rooms])[:2]
    rooms = list(range(int(lo), int(hi) + 1))
    os.makedirs(a.dir, exist_ok=True)

    e = C64Emu(a.image, fast=a.fast)
    e.cmd('break exec $%04x' % 0x3855)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
    e.cmd('del 1')
    e.brk(GAME_IRQ)                                  # #1
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('disable 1')
    for site in JOY_SITES:                           # doprava, do místnosti
        e.cmd('> %04x a9 %02x ea' % (site, RIGHT))
    e.brk(BUILD_CALL)                                # #2
    e.go()
    # ★ checkpoint na volání se musí vypnout: po `r pc=8b9e` by zabral hned
    # znovu a další `g` by tím pádem místnost nepostavil (stalo se 2026-09-19)
    e.cmd('disable 2')
    # od téhle chvíle je stroj v klidu: bez přerušení a bez čekání na $E0
    e.cmd('> %04x 60' % DELAY)
    e.cmd('bank io')
    e.cmd('> d01a 00')
    e.cmd('> d019 ff')
    e.cmd('> dc0d 7f')
    e.cmd('> dd0d 7f')
    e.brk(BUILD_DONE)                                # #3
    for room in rooms:
        e.cmd('bank ram')
        e.cmd('> %04x %02x' % (ROOM_NO, room))
        e.cmd('> %04x %02x' % (ENTRY_SIDE, a.side))
        e.bsave('%s/r%02d_pre.bin' % (a.dir, room), 0x0000, 0xFFFF)
        e.cmd('bank io')
        e.bsave('%s/r%02d_pre_col.bin' % (a.dir, room), 0xD800, 0xDBFF)
        e.bsave('%s/r%02d_pre_vic.bin' % (a.dir, room), 0xD000, 0xD02E)
        e.go()                                       # jeden JSR $A39C
        e.cmd('bank ram')
        e.bsave('%s/r%02d_post.bin' % (a.dir, room), 0x0000, 0xFFFF)
        e.cmd('bank io')
        e.bsave('%s/r%02d_col.bin' % (a.dir, room), 0xD800, 0xDBFF)
        e.bsave('%s/r%02d_vic.bin' % (a.dir, room), 0xD000, 0xD02E)
        e.cmd('r pc=%04x' % BUILD_CALL)              # zpátky před volání
    r = e.run(cycles=900_000_000, monlog='%s/trace.log' % a.dir,
              moncmds='%s/trace.cmds' % a.dir, timeout=3600)
    ok = all(os.path.exists('%s/r%02d_post.bin' % (a.dir, x)) for x in rooms)
    print('tracerooms: %d místností do %s, %s' % (len(rooms), a.dir,
          'hotovo' if ok else 'NĚCO CHYBÍ — koukni do trace.log'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
