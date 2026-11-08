#!/usr/bin/env python3
"""dumppuzzle — skládačka kapesního počítače z obrazu paměti do data/puzzle.json.

★ **Dílek skládačky není obrázek, počítá se** (`sources/docs/disasm_notes.md`
§15). Staticky jsou v programu jen dvě tabulky, a obě mají přesně dané hranice:

| adresa | co to je |
|---|---|
| `$26E3`–`$2762` | **16 dlaždic po 8 bajtech**, ze kterých generátor staví karty skládaček (fáze 4, `$B0E9`) |
| `$2763`–`$3062` | ★ **16 tvarů dílku po 144 bajtech** — 6 glyfů na řádek, 3 řádky, tedy 48 × 21 pixelů |
| `$208E`–`$20D5` | **8 hesel po 9 písmenech** (fáze 3, `$B0C3`) |
| `$7CF4`–`$7D4B` | **4 hlášky počítače po 22 znacích** (`$7FFC` je sází na `$4376`) |

Že tvarů je šestnáct a že jsou po 144 bajtech, není odhad: násobí to `$82AB`
(`n*16 + n*128`) a základ `$2763` je v `$9CF1`. Sedí to i na hranice —
`$26E3 + 16*8` je přesně `$2763` a `$2763 + 16*144` přesně `$3063`, kde
začíná záplata řídicí místnosti (§12).

★ **Karta skládačky je `$C9F0 + skládačka*144`, devět karet.** To, co §9
četla jako „mřížku pevnosti", jsou tyhle karty: fáze 4 nasype 162 × 8 bajtů
z tabulky dlaždic a `$B12D` na každou ze **devíti** karet otiskne rámeček.
Adresu potvrzuje `$9CDB` (`ADC #$F0` / `ADC #$C9`) a nultý bajt záznamu
dílku, který je 0–8.

**Záznam dílku** je 4 bajty na `$BFC0 + dílek*4` (fáze 5, `$B176`):

| bajt | co je |
|---|---|
| `+0` | číslo skládačky 0–8 |
| `+1` | tvar A (0–15); jeho **spodní dva bity** jsou zároveň příznaky převrácení masky |
| `+2` | tvar B (0–15) |
| `+3` | ? protějšek, a `$7F8F` z něj bere natočení (`AND #$03` ho srovná) |

**Skládání** (`$9C3A`): `dílek = (tvarA ^ invA) & karta & (tvarB ^ invB)`,
pak rámeček toutéž `$B12D` a pak překlopení do okna počítače na `$5C50`
(vodorovně přes tabulku `$C500`, tedy tutéž, kterou se zrcadlí sprajty, §13).

**Znaky hlášek** jsou screen codes sady počítače (§14): `$53` mezera,
`$66`–`$7F` a–z, `$80`–`$89` 0–9 a ★ `$F7` tečka.

    ./tools/dumppuzzle.py                 # → data/puzzle.json
    ./tools/dumppuzzle.py --print 0       # + výpis tvaru po pixelech
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

TILES = 0x26E3               # 16 dlaždic po 8 B, ze kterých se staví karty
TILE_BYTES, TILE_COUNT = 8, 16
SHAPES = 0x2763              # 16 tvarů dílku po 144 B
SHAPE_BYTES, SHAPE_COUNT = 144, 16
CONTROL_PATCH = 0x3063       # §12 — sem sahá tabulka tvarů a ani o bajt dál
PASSWORDS = 0x208E           # 8 hesel po 9 písmenech
PASSWORD_LEN, PASSWORD_COUNT = 9, 8
TEXTS = 0x7CF4               # 4 hlášky po 22 znacích
TEXT_LEN, TEXT_COUNT = 22, 4
TEXT_AT = 0x4376             # kam je $7FFC sází na obrazovku
CARDS = 0xC9F0               # 9 karet po 144 B, losuje je fáze 4
CARD_COUNT = 9
RECORDS = 0xBFC0             # 36 záznamů dílků po 4 B, losuje je fáze 5
RECORD_COUNT = 36

COLUMNS, ROWS_OF_GLYPHS = 6, 3      # 6 glyfů na řádek, 3 řádky glyfů
PIXELS_WIDE, PIXELS_HIGH = 48, 21   # ★ spodní řádek glyfů je využitý jen z pěti osmin

# ★ kódování znaků sady počítače (§14: písmena a číslice jsou z Char ROM)
SPACE, LETTER_A, DIGIT_0, PERIOD = 0x53, 0x66, 0x80, 0xF7


def text(codes):
    """Screen codes sady počítače na písmena."""
    out = ''
    for c in codes:
        if c == SPACE: out += ' '
        elif LETTER_A <= c < LETTER_A + 26: out += chr(ord('a') + c - LETTER_A)
        elif DIGIT_0 <= c < DIGIT_0 + 10: out += chr(ord('0') + c - DIGIT_0)
        elif c == PERIOD: out += '.'
        else: out += '[%02X]' % c
    return out


def frame(card):
    """Rámeček `$B12D` na jedné kartě nebo dílku (144 B, na místě).

    Tři kusy, všechny odečtené z kódu: vodorovná čára navrch (`$FF` na
    nultém řádku všech šesti glyfů), svislé okraje (`|= $C0` vlevo,
    `|= $03` vpravo, třikrát po 48 bajtech) a spodek — v posledním řádku
    glyfů se řádky 5–7 vynulují a řádek 4 je `$FF`, takže karta je vysoká
    **21 pixelů**, ne 24.
    """
    for off in range(0, COLUMNS*8, 8):
        card[off] = 0xFF
    for band in range(ROWS_OF_GLYPHS):
        at = band*COLUMNS*8
        for y in range(8):
            card[at + y] |= 0xC0
            card[at + 0x28 + y] |= 0x03
    at, y = (ROWS_OF_GLYPHS - 1)*COLUMNS*8, COLUMNS*8 - 1
    while y >= 0:
        for k in range(3):
            card[at + y - k] = 0x00
        card[at + y - 3] = 0xFF
        y -= 8
    return card


def render(block):
    """144 bajtů po pixelech — jen pro oko, do dat to nejde."""
    out = []
    for band in range(ROWS_OF_GLYPHS):
        for y in range(8):
            out.append(''.join('#' if (block[(band*COLUMNS + col)*8 + y] >> bit) & 1 else '.'
                               for col in range(COLUMNS) for bit in range(7, -1, -1)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo rozbalení diskety')
    ap.add_argument('-o', default='data/puzzle.json')
    ap.add_argument('--print', dest='show', type=lambda x: int(x, 0), action='append',
                    default=[], metavar='N', help='vypsat tvar po pixelech')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)

    checks = diffs = 0

    def check(ok, what):
        nonlocal checks, diffs
        checks += 1
        if not ok:
            diffs += 1
            print('  ROZDÍL: %s' % what)

    # --- hranice, které tabulky drží zevnitř i zvenku --------------------
    check(TILES + TILE_COUNT*TILE_BYTES == SHAPES,
          'dlaždice nekončí tam, kde začínají tvary')
    check(SHAPES + SHAPE_COUNT*SHAPE_BYTES == CONTROL_PATCH,
          'tvary nekončí na $3063, kde začíná záplata řídicí místnosti')
    check(COLUMNS*ROWS_OF_GLYPHS*8 == SHAPE_BYTES, 'geometrie tvaru nedá 144 bajtů')

    shapes = []
    for i in range(SHAPE_COUNT):
        at = SHAPES + i*SHAPE_BYTES
        block = list(mem[at:at + SHAPE_BYTES])
        # ★ pozorování, ne zákon: rámeček `$B12D` už v tvaru je u 14 z 16
        framed = bytes(frame(bytearray(block))) == bytes(block)
        shapes.append({'shape': i, 'addr': '$%04X' % at, 'framed': framed, 'bytes': block})

    tiles = []
    for i in range(TILE_COUNT):
        at = TILES + i*TILE_BYTES
        tiles.append({'tile': i, 'addr': '$%04X' % at, 'bytes': list(mem[at:at + TILE_BYTES])})

    passwords = []
    for i in range(PASSWORD_COUNT):
        at = PASSWORDS + i*PASSWORD_LEN
        codes = list(mem[at:at + PASSWORD_LEN])
        check(all(LETTER_A <= c < LETTER_A + 26 for c in codes),
              'heslo %d není z písmen' % i)
        passwords.append({'addr': '$%04X' % at, 'codes': codes, 'text': text(codes)})

    texts = []
    for i in range(TEXT_COUNT):
        at = TEXTS + i*TEXT_LEN
        codes = list(mem[at:at + TEXT_LEN])
        texts.append({'addr': '$%04X' % at, 'codes': codes, 'text': text(codes)})

    data = {
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': 'dílek se počítá, ne kreslí — $9C3A z karty a dvou tvarů '
                '(disasm_notes.md §15)',
        'geometry': {'columns': COLUMNS, 'glyphRows': ROWS_OF_GLYPHS,
                     'bytes': SHAPE_BYTES, 'width': PIXELS_WIDE, 'height': PIXELS_HIGH},
        'shapes': shapes,
        'tiles': {'addr': '$%04X' % TILES, 'note': 'fáze 4 generátoru ($B0E9) z nich '
                  'nasype 162 osmic na karty', 'list': tiles},
        'cards': {'addr': '$%04X' % CARDS, 'count': CARD_COUNT, 'bytes': SHAPE_BYTES,
                  'note': '★ losuje se — to, co §9 četla jako mřížku pevnosti, '
                          'je devět karet skládaček; rámeček otiskne $B12D'},
        'records': {'addr': '$%04X' % RECORDS, 'count': RECORD_COUNT, 'bytes': 4,
                    'note': 'losuje fáze 5 ($B176); +0 skládačka 0-8, +1 tvar A '
                            '(spodní dva bity jsou příznaky převrácení), +2 tvar B, '
                            '+3 ? protějšek a natočení'},
        'build': {'routine': '$9C3A', 'scratch': '$5000', 'window': '$5C50',
                  'rule': 'dílek = (tvarA ^ invA) & karta & (tvarB ^ invB), pak $B12D',
                  'mirrorTable': '$C500'},
        'passwords': passwords,
        'texts': {'at': '$%04X' % TEXT_AT, 'length': TEXT_LEN, 'list': texts},
        'charcodes': {'space': '$%02X' % SPACE, 'a': '$%02X' % LETTER_A,
                      'zero': '$%02X' % DIGIT_0, 'period': '$%02X' % PERIOD},
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    for i in a.show:
        print('tvar %d ($%04X):' % (i, SHAPES + i*SHAPE_BYTES))
        for line in render(shapes[i]['bytes']):
            print('  ' + line)

    print('%s: %d tvarů po %d B, %d dlaždic, %d hesel, %d hlášek'
          % (a.o, SHAPE_COUNT, SHAPE_BYTES, TILE_COUNT, PASSWORD_COUNT, TEXT_COUNT))
    print('   hesla: %s' % ', '.join(p['text'] for p in passwords))
    print('   hlášky: %s' % ' | '.join(t['text'].strip() for t in texts))
    print('   tvarů s rámečkem $B12D: %d z %d'
          % (sum(1 for s in shapes if s['framed']), SHAPE_COUNT))
    print('dumppuzzle: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
