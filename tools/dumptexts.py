#!/usr/bin/env python3
"""dumptexts — texty hry z obrazu paměti do data/texts.json.

★ Hra má **dvě kódování písmen**, a obě plynou ze záplaty z Char ROM
(`sources/docs/disasm_notes.md` §14): do sady šachty se písmena kopírují od
glyfu **`$71`**, do sady kapesního počítače od **`$66`**. Text se tedy čte
podle toho, ve které půlce obrazovky se kreslí — horní jede po sadě šachty,
dolní po sadě počítače.

| kódování | mezera | a–z | 0–9 | tečka | další |
|---|---|---|---|---|---|
| **šachta** (`$4800`) | `$53` | `$71`–`$8A` | `$8B`–`$94` | `$FE` | `$DD` lomítko, `$95` hvězdička |
| **počítač** (`$5800`) | `$53` | `$66`–`$7F` | `$80`–`$89` | `$F7` | `$F6` dvojtečka, `$F8`/`$F9` závorky, `$FA` apostrof |

Bloky se **nehádají z obrázku**: každý má v kódu svou tiskárnu a z ní plyne
délka řádku i počet řádků.

| blok | řádek | řádků | sada | tiskne | co to je |
|---|---|---|---|---|---|
| `$3431` | 62 | 1 | počítač | `$8018` (barvy `$35C1`) | stavový řádek počítače (`SNOOZES:`, `LIFT INITS:`, `PSW:`) |
| `$7C44` | 22 | 8 | počítač | `$7BE9` | otázky počítače |
| `$7CF4` | 22 | 4 | počítač | `$7FFC` | odpovědi počítače |
| `$81FB` | 22 | 8 | počítač | `$81B8` | hlášky; **nultý řádek je ten druhý**, který `$81B8` přisadí ke každé |
| `$A011` | 24 | 8 | šachta | `$9FFF` | terminál řídicí místnosti |
| `$A21C` | 19 | 2 | šachta | `$A1DC` | heslo vyžádáno / přijato |
| `$B89A`… | různě | 7 | šachta | `$B844` přes ukazatele `$B96D` a délky `$B97B` | konec hry a síň slávy |
| `$B900` | 29 | 2 | šachta | `$BC42` | nejlepší skóre (★ koncové mezery druhého řádku sdílí se `$B933`) |
| `$BD8F` | 36 | 1 | šachta | `$BCEA` | zadání kódu |
| `$BDB3` | 36 | 1 | šachta | `$B87E` (barvy `$BDD7`) | RESTORE / RUN-STOP |

Bajty, které nejsou písmeno, číslice ani pojmenovaná interpunkce, jsou
**grafické glyfy** (rámečky a ikony počítače) a nechávají se jako čísla.

    ./tools/dumptexts.py                  # → data/texts.json
    ./tools/dumptexts.py --show           # + výpis všech řádků
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

SPACE = 0x53
# ★ základy písmen jsou adresy záplaty z Char ROM (§14): $4B88 = glyf $71,
# $5B30 = glyf $66; číslice jdou hned za abecedou ($4C58, $5C00)
CHARSETS = {
    'shaft': {'letter': 0x71, 'digit': 0x8B,
              'punct': {0xFE: '.', 0xDD: '/', 0x95: '*'}},
    'computer': {'letter': 0x66, 'digit': 0x80,
                 'punct': {0xF7: '.', 0xF6: ':', 0xF8: '(', 0xF9: ')', 0xFA: "'"}},
}

# ★ (adresa, bajtů na řádek, řádků, sada, tiskárna, co to je, tabulka barev)
BLOCKS = [
    (0x3431, 62, 1, 'computer', '$8018', 'stavový řádek počítače, na obrazovku $4376', 0x35C1),
    (0x7C44, 22, 8, 'computer', '$7BE9', 'otázky počítače', None),
    (0x7CF4, 22, 4, 'computer', '$7FFC', 'odpovědi počítače, na obrazovku $4376', None),
    (0x81FB, 22, 8, 'computer', '$81B8',
     'hlášky počítače; nultý řádek přisadí $81B8 ke každé na $439E, barvy natvrdo $07 a $01', None),
    (0xA011, 24, 8, 'shaft', '$9FFF', 'terminál řídicí místnosti', None),
    (0xA21C, 19, 2, 'shaft', '$A1DC', 'heslo vyžádáno / přijato', None),
    (0xB900, 29, 2, 'shaft', '$BC42',
     'nejlepší skóre, na obrazovku $420A a $4232; ★ koncové mezery druhého řádku '
     'sdílí s „hall of fame" na $B933', None),
    (0xBD8F, 36, 1, 'shaft', '$BCEA', 'zadání kódu, na obrazovku $42AA, barva natvrdo $07', None),
    (0xBDB3, 36, 1, 'shaft', '$B87E', 'RESTORE / RUN-STOP, na obrazovku $42AA', 0xBDD7),
]
# konec hry: řádky nestejně dlouhé, adresy i délky má kód v tabulkách
ENDGAME_PTRS, ENDGAME_LENS, ENDGAME_COUNT = 0xB96D, 0xB97B, 7


def decode(codes, charset):
    """Screen codes jedné sady na písmena; co není znak, zůstane číslem."""
    cs = CHARSETS[charset]
    out = ''
    for c in codes:
        if c == SPACE: out += ' '
        elif cs['letter'] <= c < cs['letter'] + 26: out += chr(ord('a') + c - cs['letter'])
        elif cs['digit'] <= c < cs['digit'] + 10: out += chr(ord('0') + c - cs['digit'])
        elif c in cs['punct']: out += cs['punct'][c]
        else: out += '{%02X}' % c
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo rozbalení diskety')
    ap.add_argument('-o', default='data/texts.json')
    ap.add_argument('--show', action='store_true', help='vypsat všechny řádky')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)

    checks = diffs = 0

    def check(ok, what):
        nonlocal checks, diffs
        checks += 1
        if not ok:
            diffs += 1
            print('  ROZDÍL: %s' % what)

    blocks, spans = [], []
    for at, width, count, charset, printer, what, colors in BLOCKS:
        lines = []
        for i in range(count):
            codes = list(mem[at + i*width:at + (i + 1)*width])
            lines.append({'addr': '$%04X' % (at + i*width), 'codes': codes,
                          'text': decode(codes, charset)})
        block = {'addr': '$%04X' % at, 'width': width, 'count': count,
                 'charset': charset, 'printer': printer, 'what': what, 'lines': lines}
        if colors is not None:
            # ★ tiskárna kope barvy z vedlejší tabulky stejně dlouhé jako text
            block['colors'] = {'addr': '$%04X' % colors,
                               'bytes': list(mem[colors:colors + width*count])}
        blocks.append(block)
        spans.append((at, at + width*count - 1, '$%04X' % at))

    # konec hry — adresy a délky z tabulek, ne z odhadu
    endgame = []
    prev_end = None
    for i in range(ENDGAME_COUNT):
        at = mem[ENDGAME_PTRS + 2*i] | mem[ENDGAME_PTRS + 2*i + 1] << 8
        width = mem[ENDGAME_LENS + i] + 1          # $B85A kopíruje Y..0
        codes = list(mem[at:at + width])
        check(0xB89A <= at < 0xB96D, 'řádek konce hry %d míří mimo blok ($%04X)' % (i, at))
        if prev_end is not None:
            check(at >= prev_end, 'řádky konce hry se překrývají u %d' % i)
        prev_end = at + width
        endgame.append({'addr': '$%04X' % at, 'width': width, 'codes': codes,
                        'text': decode(codes, 'shaft')})
    blocks.append({'addr': '$%04X' % 0xB89A, 'width': None, 'count': ENDGAME_COUNT,
                   'charset': 'shaft', 'printer': '$B844',
                   'what': 'konec hry a síň slávy; adresy $B96D, délky $B97B',
                   'pointers': '$%04X' % ENDGAME_PTRS, 'lengths': '$%04X' % ENDGAME_LENS,
                   'lines': endgame})

    # ★ bloky se smí překrývat jen v mezerách — a jeden se překrývá:
    # „hall of fame" na `$B933` leží v koncových mezerách řádku `$B91D`
    for line in endgame:
        spans.append((int(line['addr'][1:], 16),
                      int(line['addr'][1:], 16) + line['width'] - 1, line['addr']))
    spans.sort()
    overlap = 0
    for (s1, e1, n1), (s2, e2, n2) in zip(spans, spans[1:]):
        if e1 < s2:
            continue
        for at in range(s2, min(e1, e2) + 1):
            checks += 1
            overlap += 1
            if mem[at] != SPACE:
                diffs += 1
                print('  ROZDÍL: bloky %s a %s se překrývají na $%04X, a není tam mezera'
                      % (n1, n2, at))

    # ★ obě kódování musí sedět na záplatu z Char ROM: 26 písmen a za nimi
    # 10 číslic, a mezi sadami je pevný posun
    for name, cs in CHARSETS.items():
        check(cs['digit'] == cs['letter'] + 26, 'v sadě %s nejsou číslice hned za abecedou' % name)
    check(CHARSETS['shaft']['letter'] - CHARSETS['computer']['letter'] == 0x0B,
          'posun mezi sadami není $0B')

    data = {
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': 'dvě kódování písmen podle sady, obě ze záplaty z Char ROM '
                '(disasm_notes.md §14, §16)',
        'charsets': {name: {'space': '$%02X' % SPACE, 'a': '$%02X' % cs['letter'],
                            'zero': '$%02X' % cs['digit'],
                            'punct': {'$%02X' % k: v for k, v in cs['punct'].items()}}
                     for name, cs in CHARSETS.items()},
        'blocks': blocks,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write('\n')

    if a.show:
        for block in blocks:
            print('%s (%s, %s):' % (block['addr'], block['charset'], block['what']))
            for line in block['lines']:
                print('  %s |%s|' % (line['addr'], line['text']))

    total = sum(len(b['lines']) for b in blocks)
    print('%s: %d bloků, %d řádků' % (a.o, len(blocks), total))
    if overlap:
        print('   překryv bloků: %d bajtů, všechno mezery' % overlap)
    print('dumptexts: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
