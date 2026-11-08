#!/usr/bin/env python3
"""tracepuzzle — originál složí každý z 36 dílků skládačky, my si to uložíme.

★ Dílek se **nekreslí z obrázku, počítá se** (`sources/docs/disasm_notes.md`
§15). Staví ho **`$9C3A`**: z vylosovaného záznamu dílku (`$BFC0 + dílek*4`)
vezme číslo skládačky a dva tvary, `AND`em je složí přes kartu skládačky
(`$C9F0 + skládačka*144`) do `$5000`, orámuje toutéž rutinou `$B12D`, jakou
použil generátor, a překlopí to do okna kapesního počítače na `$5C50`.

Nástroj je obdoba `tools/tracerooms.py`: dojede do hry, zastaví se na místě,
kde je stroj v klidu, a pak **pro každý dílek pustí jen ten jeden `JSR`** —
`r pc=$9C3A` s číslem dílku v `A`, zastávka na **`$9C79`** — tam je dílek
v `$5000` hotový a ještě ho nikdo nepřeklopil do okna. Ukládá `$4F00`–`$5FFF`
(postavený dílek na `$5000`) a jednou celou paměť,
aby měl přepis z čeho brát záznamy a karty.

Dvě záplaty, obě stejné jako u `tracerooms.py` a ze stejného důvodu:
**`$7F6B` → `RTS`** (čekání na počitadlo snímků `$E0`) a **vypnutá
přerušení**, aby mezi zastávkami nikdo nehýbal pamětí.

    ./tools/tracepuzzle.py [--entropy 42] [--dir build/puzzle] [--pieces 0-35]
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME
from tracerooms import BUILD_CALL, ENTROPY_SITE, DELAY, JOY_SITES, RIGHT

BUILD_PIECE = 0x9C3A         # staví dílek z jeho záznamu
# ★ zastávka je **`$9C79`**, ne až na konci: `$9C7D` totiž obrázek z `$5000`
# do okna počítače nekopíruje, ale **prohazuje** (`$7934` je `swap`), takže po
# něm `$5000` drží starý obsah okna. Na `$9C79` je v `$5000` hotový dílek
# i s rámečkem a nic dalšího se s ním nestalo.
BUILD_DONE = 0x9C79
PIECES = 36
LO, HI = 0x4F00, 0x5FFF      # co se ukládá: $5000 (dílek) a $5C50 (okno)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--dir', default='build/puzzle')
    ap.add_argument('--pieces', default='0-%d' % (PIECES - 1))
    ap.add_argument('--start', type=int, default=14000, help='snímků, než se hra rozjede')
    ap.add_argument('--fast', action='store_true')
    a = ap.parse_args()

    lo, hi = (a.pieces.split('-') + [a.pieces])[:2]
    pieces = list(range(int(lo), int(hi) + 1))
    os.makedirs(a.dir, exist_ok=True)

    e = C64Emu(a.image, fast=a.fast)
    e.cmd('break exec $3855')
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
    e.cmd('del 1')
    e.brk(GAME_IRQ)                                  # #1
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('disable 1')
    for site in JOY_SITES:                           # doprava, do místnosti
        e.cmd('> %04x a9 %02x ea' % (site, RIGHT))
    e.brk(BUILD_CALL)                                # #2 — místo, kde je stroj v klidu
    e.go()
    e.cmd('disable 2')
    e.cmd('> %04x 60' % DELAY)                       # čekání na $E0 pryč
    e.cmd('bank io')
    e.cmd('> d01a 00')
    e.cmd('> d019 ff')
    e.cmd('> dc0d 7f')
    e.cmd('> dd0d 7f')
    e.cmd('bank ram')
    e.bsave('%s/mem.bin' % a.dir, 0x0000, 0xFFFF)    # záznamy dílků a karty
    e.brk(BUILD_DONE)                                # #3
    for piece in pieces:
        e.cmd('r pc=%04x' % BUILD_PIECE)
        e.cmd('r a=%02x' % piece)
        e.go()                                       # jeden JSR $9C3A
        e.cmd('bank ram')
        e.bsave('%s/p%02d.bin' % (a.dir, piece), LO, HI)
    r = e.run(cycles=900_000_000, monlog='%s/trace.log' % a.dir,
              moncmds='%s/trace.cmds' % a.dir, timeout=3600)
    ok = all(os.path.exists('%s/p%02d.bin' % (a.dir, x)) for x in pieces)
    print('tracepuzzle: %d dílků do %s, %s' % (len(pieces), a.dir,
          'hotovo' if ok else 'NĚCO CHYBÍ — koukni do trace.log'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
