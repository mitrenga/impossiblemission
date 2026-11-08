#!/usr/bin/env python3
"""unpack — z diskety udělá obraz paměti tak, jak to dělá zavaděč originálu.

★ Kód zavaděče je rozebraný v `sources/docs/disasm_notes.md` §4. Postup je
přesně jeho:

1. `IM.TITLE` se nahraje na `$4000` a **rozbalí** na `$C000`–`$CFFF`
   (rozbalovač `$052F`, volání s X=2 na `$B032`).
2. `IM.DATA` se nahraje na `$0800` a **přesune po stránkách nahoru**:
   163 stránek od `$AA00` dolů na `$D200` dolů (`$B0B7`), takže data
   skončí na `$3000`–`$D2FF`.
3. Odtud se **rozbalí** na `$0880`–`$CFFF` (volání s X=0 na `$B0E2`).
4. `IM.WORDS` (řeč) se nahraje rovnou na `$E000`–`$F77F`, nerozbaluje se.

Formát rozbalovače (`$052F`, smyčka `$054F`):

| bajt | co to je |
|---|---|
| `$BF n` | *n* nulových bajtů |
| `$CF n b` | *n* opakování bajtu *b* |
| cokoli jiného | ten bajt doslova |

Konec je dán koncovým ukazatelem (`$D000` pro obě úlohy), ne značkou.

    ./tools/unpack.py [--disk D64] -o build/mem_unpacked.bin
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imlib import D64

# tabulky z $0593/$0597/$059B (v souboru $B193/$B197/$B19B), viz disasm_notes §4
JOBS = {2: {'src': 0x4000, 'dst': 0xC000, 'end': 0xD000, 'what': 'IM.TITLE'},
        0: {'src': 0x3000, 'dst': 0x0880, 'end': 0xD000, 'what': 'IM.DATA (po přesunu)'}}


def rle_unpack(mem, src, dst, end):
    """Rozbalovač $052F: $BF n = n nul, $CF n b = n×b, jinak doslovný bajt."""
    s, d, lit, runs, zeros = src, dst, 0, 0, 0
    while d < end:
        c = mem[s]; s += 1
        if c == 0xBF:
            n = mem[s]; s += 1
            mem[d:d + n] = b'\x00' * n; d += n; zeros += 1
        elif c == 0xCF:
            n = mem[s]; s += 1
            b = mem[s]; s += 1
            mem[d:d + n] = bytes([b]) * n; d += n; runs += 1
        else:
            mem[d] = c; d += 1; lit += 1
    return s, d, lit, runs, zeros


def build(disk, verbose=True, stop_after=None):
    d = D64(disk)
    mem = bytearray(65536)

    def load(name):
        prg = d.read(name)
        lo = prg[0] | prg[1] << 8
        mem[lo:lo + len(prg) - 2] = prg[2:]
        return lo, lo + len(prg) - 3

    # 1. titulka: $4000 → rozbalit na $C000
    load('IM.TITLE')
    j = JOBS[2]
    s, e, lit, runs, zeros = rle_unpack(mem, j['src'], j['dst'], j['end'])
    if verbose:
        print('IM.TITLE : $%04X → $%04X-$%04X   (%d doslovných, %d opakování, %d nul, zdroj do $%04X)'
              % (j['src'], j['dst'], e - 1, lit, runs, zeros, s))

    if stop_after == 'title':
        # stav, ve kterém stroj titulku ukazuje: data hry se teprve nahrávají
        return bytes(mem)

    # 2. data: $0800, přesun 163 stránek od $AA00 dolů na $D200 dolů
    load('IM.DATA')
    for page in range(163):
        src_page, dst_page = 0xAA00 - page * 256, 0xD200 - page * 256
        mem[dst_page:dst_page + 256] = mem[src_page:src_page + 256]
    if verbose:
        print('IM.DATA  : $0800-$AAFF → $3000-$D2FF   (163 stránek, po stránkách dolů)')

    # 3. rozbalit data
    j = JOBS[0]
    s, e, lit, runs, zeros = rle_unpack(mem, j['src'], j['dst'], j['end'])
    if verbose:
        print('IM.DATA  : $%04X → $%04X-$%04X   (%d doslovných, %d opakování, %d nul, zdroj do $%04X)'
              % (j['src'], j['dst'], e - 1, lit, runs, zeros, s))

    # 4. řeč beze změny
    lo, hi = load('IM.WORDS')
    if verbose:
        print('IM.WORDS : $%04X-$%04X   (nerozbaluje se, leží pod ROM KERNALu)' % (lo, hi))
    return bytes(mem)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('-o', default='build/mem_unpacked.bin')
    ap.add_argument('--stop-after', choices=['title'],
                    help='vrátit paměť hned po rozbalení titulky (než ji přepíše hra)')
    a = ap.parse_args()
    mem = build(a.disk, stop_after=a.stop_after)
    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    open(a.o, 'wb').write(mem)
    print('\nobraz paměti: %s (64 KB)' % a.o)


if __name__ == '__main__':
    main()
