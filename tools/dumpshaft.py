#!/usr/bin/env python3
"""dumpshaft — tabulky šachty s výtahem do data/shaft.json.

★ **Šachta se neposouvá po pixelech, staví se po znakových řádcích**
(`sources/docs/disasm_notes.md` §20). Jeden krok výtahu přesune celé okno
šachty (řádky 0–14) o **jeden znakový řádek** a na uvolněný okraj složí
nový řádek z pár statických tabulek. Ty tabulky jsou tady.

| adresa | co to je | kdo ji čte |
|---|---|---|
| `$0D00` | 6 znaků horní zarážky, které `$744B` vrací na `$4011` | `$744B` |
| `$0DBD` | **tři fáze lana** (`$20`, `$24`, `$25`), index je `$1B` | `$7707`, `$782C` |
| `$0DC0` | 8 znaků **stropu šachty** na `$4010` | `$7857` |
| `$0DC8` | 8 znaků **dna šachty** na `$4240` | `$773B` |
| `$0DD0` | sloupec **veřeje** vedle šachty: `$17` vpravo, `$10` vlevo | `$7689`, `$77AD` |
| `$0DD2` | vnější sloupec pro **šestnáctku**: `$27` a `$0F` | oba generátory |
| `$0DD4` | vnější sloupec pro **sedmnáctku**: `$27` a `$10` | `$7659`, `$777A` |
| `$0DD6` | maska, která rozhoduje, kdy začnou dveře: `$07` a `$E0` | `$76BF`, `$77E3` |
| `$0DD8` | 40 znaků **otevřených dveří** | `$7678`, `$7799` |
| `$0E00` | 40 znaků **překladu dveří** | `$76CF`, `$77BA` |
| `$0E28` | 40 znaků **prahu dveří** | `$765E`, `$777F` |
| `$0E50`/`$0E5E` | 14 adres **barevných řádků** `$D828`–`$DA30` | `$75F2`, `$7612` |
| `$78A4` | 6 ukazatelů do **obrázku pevnosti** `$FC08`+`$88`·řádek | `$788C` |
| `$0D00`/`$0D5A` | **sloupec šachty**, 15 řádků po 6 znacích a jeho barvy | `$72A2` |
| `$3313`/`$34A3` | **spodní panel** šachty, 400 znaků a 400 barev na `$4258` | `$72E5` |
| `$741F` | osm barev, kterými bliká **značka kabiny na mapě** | `$73E4` |
| `$B02B`/`$B033` | barvy kabiny podle sloupce pevnosti | `$AF6B` |

★ Prostřední položky čtyřicetibajtových tabulek jsou **nulové a nikdy se
nečtou**: to je samotná šachta, která se neposouvá (`$744B` i `$74C0`
kopírují jen sloupce 0–16 a 23–39). Kolik jich je, řídí rozpětí: tabulky
čtené po šestnácti (`$0DD2`) nechávají ležet sloupce `$10`–`$17`, tabulka
čtená po sedmnácti (`$0DD4`) jen `$11`–`$16`. Nástroj to kontroluje, protože
je to nejlevnější důkaz, že jsou ty tabulky přečtené správně.

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`), takže k vytažení není potřeba emulátor.

    ./tools/dumpshaft.py                   # → data/shaft.json
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# 40 sloupců obrazovky, z toho $10-$17 je šachta a ta se neposouvá
COLUMNS = 40
# sloupce, které tabulka nikdy nedostane pod ruku: šestnáctka čte $27-$18
# a $0F-$00, sedmnáctka $27-$17 a $10-$00 (viz $0DD2 a $0DD4)
UNUSED = {16: range(0x10, 0x18), 17: range(0x11, 0x17)}

SHAFT_ROWS, SHAFT_COLS = 15, 6          # okno šachty: 15 řádků po 6 sloupcích
PANEL_CELLS = 400                       # spodní panel: řádky 15-24

TABLES = (
    ('column', 0x0D00, SHAFT_ROWS*SHAFT_COLS, 'sloupec šachty, 15 řádků po 6 ($72A2)'),
    ('columnColor', 0x0D5A, SHAFT_ROWS*SHAFT_COLS, 'jeho barvy ($72A2)'),
    ('topRestore', 0x0D00, 6, 'prvních šest z `column` — to vrací $744B na $4011'),
    ('cable', 0x0DBD, 3, 'tři fáze lana, index je $1B'),
    ('ceiling', 0x0DC0, 8, 'strop šachty na $4010 ($7857)'),
    ('floor', 0x0DC8, 8, 'dno šachty na $4240 ($773B)'),
    ('postColumn', 0x0DD0, 2, 'sloupec veřeje: X=0 vpravo, X=1 vlevo'),
    ('outerColumn', 0x0DD2, 2, 'vnější sloupec, šestnáctka'),
    ('spanColumn', 0x0DD4, 2, 'vnější sloupec, sedmnáctka'),
    ('doorMask', 0x0DD6, 2, 'kdy smí začít nová dvojice dveří'),
    ('doorOpen', 0x0DD8, COLUMNS, 'otevřené dveře', 16),
    ('doorLintel', 0x0E00, COLUMNS, 'překlad dveří', 16),
    ('doorSill', 0x0E28, COLUMNS, 'práh dveří', 17),
    ('panel', 0x3313, PANEL_CELLS, 'spodní panel šachty na $4258 ($72E5)'),
    ('panelColor', 0x34A3, PANEL_CELLS, 'jeho barvy na $DA58 ($72E5)'),
    # ★ deset znaků **stěny šachty pod oknem**: `$731C` je sází do sloupců
    # `$10` a `$17` deseti řádků pod oknem, tedy tam, kde za řeči šachta
    # pokračuje a kde je později panel (§22)
    ('bottomWall', 0x73C0, 10, 'stěna šachty pod oknem, sloupce $10 a $17 ($731C)'),
    # ★ osm barev, kterými `$73E4` **bliká značce kabiny na mapě**: index je
    # `($E0 >> 2) & 7`, tedy čtyři snímky na barvu a 32 na celé kolo, a je to
    # průběh `$00 $0B $0C $0F $01 $0F $0C $0B` — z černé do bílé a zpátky
    ('cabinFlash', 0x741F, 8, 'barvy blikající značky kabiny na mapě ($73E4)'),
    ('cabinColor', 0xB02B, 8, 'barva kabiny podle sloupce pevnosti ($AF6B)'),
    ('cabinMulti', 0xB033, 8, 'a její druhá barva ($AF70)'),
)
COLOR_LO, COLOR_HI, COLOR_ROWS = 0x0E50, 0x0E5E, 14
PICTURE_PTRS, PICTURE_COUNT = 0x78A4, 6
COLOR_BASE, ROW_BYTES = 0xD800, 40


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('-o', default='data/shaft.json')
    a = ap.parse_args()

    mem = build(a.disk, verbose=False)
    checks = diffs = 0

    def fail(what):
        nonlocal diffs
        diffs += 1
        print('  %s' % what)

    tables = {}
    for entry in TABLES:
        name, addr, count, note = entry[:4]
        span = entry[4] if len(entry) > 4 else 0
        values = list(mem[addr:addr + count])
        tables[name] = {'addr': '$%04X' % addr, 'values': values, 'note': note}
        if span:
            tables[name]['span'] = span
            # ★ sloupce šachty se neposouvají, takže v tabulce nemají co dělat
            for col in UNUSED[span]:
                checks += 1
                if values[col]:
                    fail('%s: sloupec $%02X není nula, ale $%02X' % (name, col, values[col]))

    # barevné řádky: $0E50/$0E5E musí dát $D800 + 40*(řádek+1), řádky 1..14
    rows = []
    for i in range(COLOR_ROWS):
        addr = mem[COLOR_LO + i] | mem[COLOR_HI + i] << 8
        rows.append(addr)
        checks += 1
        want = COLOR_BASE + ROW_BYTES*(i + 1)
        if addr != want:
            fail('barevný řádek %d je $%04X, čekalo se $%04X' % (i, addr, want))

    # obrázek pevnosti: šest řádků po $88 bajtech od $FC08 ($788C)
    picture = []
    for i in range(PICTURE_COUNT):
        addr = mem[PICTURE_PTRS + 2*i] | mem[PICTURE_PTRS + 2*i + 1] << 8
        picture.append(addr)
        checks += 1
        want = 0xFC08 + 0x88*i
        if addr != want:
            fail('řádek obrázku %d je $%04X, čekalo se $%04X' % (i, addr, want))

    # sloupec šachty je šest znaků široký a panel má přesně deset řádků
    checks += 2
    if len(tables['column']['values']) != len(tables['columnColor']['values']):
        fail('sloupec šachty a jeho barvy nemají stejnou délku')
    if PANEL_CELLS != COLUMNS*10:
        fail('spodní panel není deset řádků po čtyřiceti')

    # veřej musí sousedit se šachtou: vpravo $17, vlevo $10
    checks += 2
    if tables['postColumn']['values'] != [0x17, 0x10]:
        fail('veřeje nejsou $17/$10, ale %s' % tables['postColumn']['values'])

    data = {
        'name': 'shaft',
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': ('okno šachty jsou řádky 0-14 obrazovky $4000; krok výtahu je '
                 'jeden znakový řádek (disasm_notes.md §20)'),
        'window': {'rows': 15, 'screen': '$4000', 'newRowUp': '$4000',
                   'newRowDown': '$4230', 'color': '$D800',
                   'keptColumns': '$10-$17 (šachta se neposouvá)'},
        'routines': {
            'up': '$855A — čeká na rastr $A3, pak $74C0 + $75A5 + $7749 + $85B3',
            'down': '$8590 — čeká na rastr $3B, pak $744B + $7631 + $85B3 + $73CA',
            'scrollDown': '$74C0', 'scrollUp': '$744B',
            'colors': '$75A5', 'newRowUp': '$7749', 'newRowDown': '$7631',
            'tone': '$85B3', 'advance': '$73CA', 'cabin': '$73E4 → $B757',
            'step': '2 snímky (PLA; ADC #$02; CMP $E0)',
        },
        'zeroPage': {
            '$1B': 'fáze lana, 0-2', '$1C': 'podřádek, 0-5',
            '$1D': 'nahoře ($7857 ji zvedne, $744B shodí)',
            '$1E': 'dole ($773B ji zvedne, $74C0 shodí)',
            '$1F/$20': 'fáze dveří vpravo a vlevo, $00-$15 nebo $FF',
            '$23/$24': 'barva místnosti za dveřmi (první bajt záznamu)',
            '$25/$26': 'tón výtahu, roste k $20 a $18',
            '$27/$28': 'kabina v pevnosti = sprajt 6',
        },
        'colorRows': {'addrLo': '$%04X' % COLOR_LO, 'addrHi': '$%04X' % COLOR_HI,
                      'rows': ['$%04X' % x for x in rows]},
        'picture': {'addr': '$%04X' % PICTURE_PTRS, 'stride': 0x88,
                    'rows': ['$%04X' % x for x in picture],
                    'note': 'obrázek pevnosti, který losuje $B2B3 (§11)'},
        'tables': tables,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    print('%s: %d tabulek, %d barevných řádků, %d řádků obrázku'
          % (a.o, len(tables), len(rows), len(picture)))
    print('dumpshaft: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
