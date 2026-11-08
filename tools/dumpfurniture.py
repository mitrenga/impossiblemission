#!/usr/bin/env python3
"""dumpfurniture — tabulky a okna prohledávání nábytku do data/furniture.json.

★ **Prohledávání není animace, je to překreslení znakové sady.** Když agent
zabere nahoru nad kusem nábytku, `$97F1` mu nad hlavou otevře okno 8 × 4
znaků — a to okno **není obrázek**: hra do něj sází znaky `$00`–`$1F`
a jejich **glyfy v tu chvíli přepisuje** na `$5000` (`sources/docs/
disasm_notes.md` §27). Proto jsou tabulky tady, a proto jich je tolik.

| adresa | délka | co to je | kdo ji čte |
|---|---|---|---|
| `$99ED` | 4 | **čtyři fáze ukazatele postupu** (`$FF`, `$3F`, `$0F`, `$03`) | `$9894`, `$98E5` |
| `$99F1` | 32 | rozvržení okna **s nálezem** (8 × 4 znaky) | `$9B92` → `$9B96` |
| `$9A11` | 32 | rozvržení okna **„nic"** | `$99D6` → `$9B96` |
| `$9A31` | 32 | rozvržení okna **s ukazatelem postupu** | `$989C` → `$9B96` |
| `$9A51` | 64 | **glyfy ukazatele postupu** do `$5000` | `$9850` |
| `$9A91` | 3 | tři glyfy zarážky do `$5078` | `$9860` |
| `$9A94` | 144 | **okno „nic jsi nenašel"** do `$5000` | `$99DF` |
| `$9B24`/`$9B26` | 2+2 | ukazatele na **dvě okna terminálu** | `$9930` |
| `$31F3` | 144 | okno terminálu **lift reset** (`$FD`) | `$993C` |
| `$3283` | 144 | okno terminálu **snooze** (`$FC`) | `$993C` |
| `$A21A` | 2 | kam v panelu šachty leží **počitadla** `$3439` | `$9948` |

★ A **jsou to data programu**, ne nic vylosovaného: v remaku je nikdo do
paměti nedá, pokud se sem nevytáhnou. Je to táž past jako u proudu programů
robotů (§24) — každé `match*` začíná z výpisu paměti originálu, kde ty
tabulky jsou, takže na jejich chybění žádné měřidlo nepřijde.

★ **Záznam nábytku je jinde**: šest bajtů na kus na `$4F55`, a ty staví
**stavitel místnosti** z vylosované pevnosti (`$A4F7`, §12) — v datech tedy
nejsou, jen se tu popisuje jejich tvar, protože podle nich `$97F1` hledá.

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`), takže k vytažení není potřeba emulátor.

    ./tools/dumpfurniture.py               # → data/furniture.json
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# ★ Všechno od `$99ED` do `$9B27` je **jeden souvislý pás dat** a vozí se
# celý: rozdělit ho na kusy, o kterých se ví, k čemu jsou, by znamenalo
# tiše zahodit to, o čem se to zatím neví.
BLOCK, BLOCK_END = 0x99ED, 0x9B28

# (jméno, adresa, délka, kdo ji čte, co to je) — pohledy do toho pásu
TABLES = [
    ('progress', 0x99ED, 4, '$9894, $98E5',
     'čtyři fáze ukazatele postupu, index je (čítač >> 3) & 3'),
    ('windowFound', 0x99F1, 32, '$9B92 → $9B96',
     'rozvržení okna s nálezem: 32 znaků 8 × 4'),
    ('windowEmpty', 0x9A11, 32, '$99D6 → $9B96', 'rozvržení okna „nic"'),
    ('windowSearching', 0x9A31, 32, '$989C → $9B96',
     'rozvržení okna s ukazatelem postupu'),
    ('progressGlyphs', 0x9A51, 64, '$9850',
     'glyfy ukazatele postupu: 64 bajtů na $5000, a $5040 se zaplní $FF'),
    ('progressStop', 0x9A91, 3, '$9860', 'tři glyfy zarážky na $5078'),
    ('emptyWindow', 0x9A94, 144, '$99DF',
     'okno „nic jsi nenašel": 18 glyfů po osmi bajtech na $5000'),
    ('terminalPtrLo', 0x9B24, 2, '$9930', 'ukazatele na okna terminálu, dolní bajt'),
    ('terminalPtrHi', 0x9B26, 2, '$9935', 'a horní bajt'),
]
# a jedna tabulka, která v pásu neleží
COUNTER_SPOTS = (0xA21A, 2, '$9948, $7296',
                 'kam v panelu šachty ($3439) leží počitadla snooze a lift resetů')
# okna terminálu — adresy plynou z ukazatelů, kontroluje se to
TERMINAL_WINDOW = 144

# záznam nábytku: šest bajtů na kus, staví ho stavitel místnosti
RECORD = [
    ('screenLo', '+0', 'levý horní roh na obrazovce, dolní bajt'),
    ('screenHi', '+1', 'a horní bajt'),
    ('endLo', '+2', 'pravý dolní roh, dolní bajt'),
    ('endHi', '+3', 'a horní bajt'),
    ('search', '+4', 'jak dlouho se prohledává; $00 hned hotovo, $FF kapesní počítač'),
    ('holds', '+5', 'co v něm je: $FF nic, $FE lift reset, $FB řídicí místnost, '
                    '$FC/$FD terminál, jinak číslo dílku 0-35; $F0 = prohledáno'),
]
RECORDS_AT = 0x4F55
FOUND_LIST = 0x4EF5      # seznam nalezených dílků, zakončený $FF
FOUND_COLORS = 0x4F25    # barva pozadí, ve které se dílek našel
COUNTERS = 0x3439        # počitadla v panelu šachty (leží v $3313, data/shaft.json)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo diskety')
    ap.add_argument('-o', default='data/furniture.json')
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)

    checks, diffs = 0, 0
    block = list(mem[BLOCK:BLOCK_END])
    tables = {}
    for name, at, length, reader, what in TABLES:
        tables[name] = {'addr': '$%04X' % at, 'bytes': length,
                        'reader': reader, 'what': what}
        checks += 1
        if at < BLOCK or at + length > BLOCK_END:
            diffs += 1
            print('  tabulka %s leží mimo pás $%04X-$%04X' % (name, BLOCK, BLOCK_END - 1))
    at, length, reader, what = COUNTER_SPOTS
    tables['counterSpots'] = {'addr': '$%04X' % at, 'bytes': length,
                              'reader': reader, 'what': what,
                              'values': list(mem[at:at + length])}

    def view(name):
        t = tables[name]
        start = int(t['addr'][1:], 16) - BLOCK
        return block[start:start + t['bytes']]

    # ★ okna terminálu se **neberou natvrdo**: adresy plynou z ukazatelů,
    # které hra sama čte, a že to vyšlo na data, je kontrola sama o sobě
    windows = []
    lo, hi = view('terminalPtrLo'), view('terminalPtrHi')
    for i in range(2):
        at = lo[i] | (hi[i] << 8)
        window = list(mem[at:at + TERMINAL_WINDOW])
        checks += 2
        if len(window) != TERMINAL_WINDOW:
            diffs += 1
        if not any(window):
            diffs += 1
            print('  okno terminálu %d na $%04X je prázdné' % (i, at))
        windows.append({'addr': '$%04X' % at, 'holds': '$%02X' % (0xFC + i),
                        'values': window})

    # ★ a jedna kontrola navíc: fáze ukazatele postupu musí ubývat po bitech
    wanted = [0xFF, 0x3F, 0x0F, 0x03]
    phases = view('progress')
    checks += len(wanted)
    for i, v in enumerate(wanted):
        if phases[i] != v:
            diffs += 1
            print('  fáze %d ukazatele je $%02X, ne $%02X' % (i, phases[i], v))
    # ★ a že jsou to opravdu tři **různá** rozvržení okna, ne třikrát totéž
    checks += 1
    if len({tuple(view(n)) for n in ('windowFound', 'windowEmpty', 'windowSearching')}) != 3:
        diffs += 1
        print('  rozvržení oken nejsou tři různá')

    data = {
        'source': __doc__.split('\n')[0],
        'note': ('★ Okno prohledávání není obrázek — hra do něj sází znaky '
                 '$00-$1F a jejich glyfy v tu chvíli přepisuje na $5000 (§27). '
                 '★ Tabulky jsou **data programu**: bez nich se neotevře okno '
                 'ani neběží ukazatel postupu, a žádné match* na to nepřijde, '
                 'protože všechna začínají z výpisu paměti originálu.'),
        'block': {'addr': '$%04X' % BLOCK, 'bytes': len(block), 'values': block},
        'tables': tables,
        'terminalWindows': windows,
        'record': {'addr': '$%04X' % RECORDS_AT, 'bytes': 6,
                   'builtBy': '$A4F7 (stavitel místnosti, §12)',
                   'fields': [{'name': n, 'at': o, 'what': w} for n, o, w in RECORD]},
        'found': {'list': '$%04X' % FOUND_LIST, 'colors': '$%04X' % FOUND_COLORS,
                  'note': 'seznam nalezených dílků zakončený $FF a barva pozadí '
                          'místnosti, ve které se každý našel'},
        'counters': {'addr': '$%04X' % COUNTERS,
                     'note': 'počitadla snooze a lift resetů leží v panelu šachty '
                             '($3313, data/shaft.json) a prohledaný terminál je '
                             'zvedne o jedna, nejvýš na $88 ($994F)'},
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    if a.show:
        for name, t in tables.items():
            print('%-16s %s %d B  %s' % (name, t['addr'], t['bytes'], t['what']))
        for w in windows:
            print('okno %s na %s' % (w['holds'], w['addr']))

    print('%s: pás %d B, %d tabulek v něm, %d oken terminálu'
          % (a.o, len(block), len(tables), len(windows)))
    print('dumpfurniture: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
