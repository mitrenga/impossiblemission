#!/usr/bin/env python3
"""dumpvic — registry VIC-II, SID a CIA po snímcích z běžícího originálu.

Obdoba `boulderdash/tools/dumpdisplaylist.py`: řekne, v jakém režimu hra
běží, kde má obrazovou paměť a znakovou sadu, jestli mění registry uprostřed
snímku (dělené rastrové přerušení) a co dělá se sprajty. Výstup se zapisuje
do `sources/docs/vic_state.md`.

Krok po snímcích je `break exec $838c` (obsluha přerušení hry, viz
`sources/docs/disasm_notes.md` §1) plus `ignore`, takže N-tý zásah = N-tý
snímek hry.

    ./tools/dumpvic.py --frames 1,2,60,300 -o build/vic.md
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu

from c64emu import GAME_IRQ as IRQ
VIC = [(0xD011, 'SCROLY  režim/rastr'), (0xD012, 'RASTER'), (0xD015, 'SPENA   sprajty'),
       (0xD016, 'SCROLX  multicolor'), (0xD017, 'YXPAND'), (0xD018, 'VMCSB   paměť'),
       (0xD019, 'VICIRQ'), (0xD01A, 'IRQMASK'), (0xD01B, 'SPBGPR  priorita'),
       (0xD01C, 'SPMC'), (0xD01D, 'XXPAND'), (0xD020, 'EXTCOL  rámeček'),
       (0xD021, 'BGCOL0'), (0xD022, 'BGCOL1'), (0xD023, 'BGCOL2'), (0xD024, 'BGCOL3'),
       (0xD025, 'SPMC0'), (0xD026, 'SPMC1')]


def snapshot(frame, image, cycles, outdir='build/vic'):
    """Dump registrů a zajímavé paměti na začátku N-tého snímku hry."""
    os.makedirs(outdir, exist_ok=True)
    e = C64Emu(image)
    e.frames_after(IRQ, frame)
    e.cmd('registers')
    e.bsave('%s/f%04d_vic.bin' % (outdir, frame), 0xD000, 0xD02E)
    e.bsave('%s/f%04d_sid.bin' % (outdir, frame), 0xD400, 0xD41C)
    e.bsave('%s/f%04d_cia.bin' % (outdir, frame), 0xDC00, 0xDD0F)
    e.bsave('%s/f%04d_ptr.bin' % (outdir, frame), 0x07F8, 0x07FF)   # ukazatele sprajtů
    e.bsave('%s/f%04d_zp.bin' % (outdir, frame), 0x0000, 0x00FF)
    r = e.run(cycles=cycles, screenshot='%s/f%04d.png' % (outdir, frame),
              monlog='%s/f%04d.log' % (outdir, frame),
              moncmds='%s/f%04d.cmds' % (outdir, frame))
    return r


def report(frames, outdir='build/vic', out=sys.stdout):
    out.write('# vic_state — registry z běhu originálu\n\n')
    out.write('Měřeno `tools/dumpvic.py` na začátku obsluhy přerušení hry '
              '(`$838C`), tedy vždy na rastrovém řádku `$AA`.\n\n')
    rows = []
    for f in frames:
        p = '%s/f%04d_vic.bin' % (outdir, f)
        if not os.path.exists(p):
            continue
        rows.append((f, open(p, 'rb').read()))
    if not rows:
        out.write('(zatím nic změřeno)\n'); return
    out.write('| registr | ' + ' | '.join('snímek %d' % f for f, _ in rows) + ' |\n')
    out.write('|---|' + '---|' * len(rows) + '\n')
    for addr, name in VIC:
        vals = ['$%02X' % r[addr - 0xD000] for _, r in rows]
        out.write('| `$%04X` %s | %s |\n' % (addr, name, ' | '.join(vals)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--frames', default='1', help='čárkami oddělené snímky hry')
    ap.add_argument('--cycles', type=int, default=400_000_000)
    ap.add_argument('-o', default='-')
    a = ap.parse_args()
    frames = [int(x) for x in a.frames.split(',')]
    for f in frames:
        r = snapshot(f, a.image, a.cycles)
        print('snímek %d: %s' % (f, 'zastaveno na $838C' if r.hit() else 'NEZASTAVENO'),
              file=sys.stderr)
    out = sys.stdout if a.o == '-' else open(a.o, 'w')
    report(frames, out=out)


if __name__ == '__main__':
    main()
