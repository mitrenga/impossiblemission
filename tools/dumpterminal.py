#!/usr/bin/env python3
"""dumpterminal — obrazovka a tabulky bezpečnostního terminálu do
data/terminal.json.

★ **Terminál je celá obrazovka, ne okno** (`sources/docs/disasm_notes.md`
§29). Nábytek, který má v délce prohledávání `$FF`, nepustí `$97F1`, ale
`$9D09`: to si schová obrazovku a registry VIC **na zásobník**, zhasne obraz,
přepne `$D018` o dvě níž (ze sady místnosti na **sadu šachty**) a **rozbalí
obrazovku terminálu po délkách** — dvojice (kolik, co) zvlášť pro znaky
a zvlášť pro barvy.

| adresa | délka | co to je | kdo ji čte |
|---|---|---|---|
| `$3633` | 374 | **znaky obrazovky terminálu**, po délkách | `$9DFC` |
| `$37A9` | 172 | **barvy**, taky po délkách; `$80`+ znamená „vezmi `$E7`" | `$9E1F` |
| `$9EDA` | 14 | barvy `$D021`–`$D02E`, které si terminál nastaví | `$9DB0` |
| `$9EE8` | 17 | polohy osmi sprajtů | `$9DBB` |
| `$9EF9` | 8 | jejich ukazatele na `$43F8` | `$9DC6` |
| `$9FE0` | 2 | **rozestupy kurzoru** mezi položkami menu (o kolik řádků − 1) | `$9FB0`, `$9FCE` |
| `$9FED` | 3 | tři znaky **kurzoru** | `$9FE2` |
| `$9FF0` | 15 | odsazení řádků textu | `$9F3B` |
| `$A011` | 192 | **text terminálu**, osm řádků po 24 znacích | `$9FFF` |
| `$A216` | 4 | dvě adresy rámečku odpovědi | `$A19B` |
| `$A21A` | 2 | kam v panelu šachty leží **počitadla** | `$A1C0` |
| `$A21C` | 38 | dvě hlášky: „password required" a „password accepted" | `$A1DC` |
| `$A242` | 6 | odsazení tří položek menu | `$A206` |
| `$1D64` | 630 | **nedotčené seznamy výtahů** pro lift reset | `$A152` |
| `$1FDA` | 60 | kde ten seznam v záznamu místnosti je — **29 dvojic a zarážka `$FFFF`**, tedy přesně tolik, kolik místností výtah má (§23) | `$A130` |
| `$2016` | 60 | a odkud se bere čistá kopie | `$A143` |

★ **Zase data programu** (§24, §27): v paměti remaku nejsou, dokud je tam
někdo nepoloží, a žádné `match*` na to nepřijde, protože všechna začínají
z výpisu paměti originálu.

★ A **znaková sada terminálu žádná není** — je to sada šachty (`$4800`),
kterou už veze `data/charset_shaft.json`. Terminál si na ni jen přepne.

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`).

    ./tools/dumpterminal.py             # → data/terminal.json
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

SCREEN_CHARS, SCREEN_COLORS, SCREEN_END = 0x3633, 0x37A9, 0x3855
# ★ **25 řádků, ne 24**: `$9DE6` uloží do `$E4` číslo 24 a smyčka končí
# `DEC $E4 / BPL`, takže proběhne **pětadvacetkrát** — celá obrazovka C64
ROWS, COLUMNS = 25, 40

# (jméno, adresa, délka, kdo ji čte, co to je)
TABLES = [
    ('colors', 0x9EDA, 14, '$9DB0', 'barvy $D021-$D02E, které si terminál nastaví'),
    ('spritePos', 0x9EE8, 17, '$9DBB', 'polohy osmi sprajtů'),
    ('spritePtr', 0x9EF9, 8, '$9DC6', 'jejich ukazatele na $43F8 — **osm**, `LDX #$07`'),
    # ★ Bez téhle dvojice se kurzor posouvá **o jeden řádek** místo o tři
    # a sedm, a nesedí na text, na který ukazuje (nahlásil operátor
    # 2026-09-20). Leží mimo pás `$99ED`-`$9B27`, tak se snadno přehlédne.
    ('cursorSteps', 0x9FE0, 2, '$9FB0, $9FCE',
     'o kolik řádků − 1 kurzor skočí mezi položkami menu'),
    ('cursor', 0x9FED, 3, '$9FE2', 'tři znaky kurzoru'),
    ('rowOffsets', 0x9FF0, 15, '$9F3B', 'odsazení řádků textu v $A011'),
    ('text', 0xA011, 192, '$9FFF', 'text terminálu, osm řádků po 24 znacích'),
    ('answerAt', 0xA216, 4, '$A19B', 'dvě adresy rámečku odpovědi'),
    ('counterSpots', 0xA21A, 2, '$A1C0', 'kam v panelu šachty leží počitadla'),
    ('answers', 0xA21C, 38, '$A1DC', 'dvě hlášky po devatenácti znacích'),
    ('menuOffsets', 0xA242, 6, '$A206', 'odsazení tří položek menu'),
    ('liftLists', 0x1D64, 0x1FDA - 0x1D64, '$A152', 'nedotčené seznamy výtahů'),
    ('liftWhere', 0x1FDA, 60, '$A130', 'kde ten seznam v záznamu místnosti je'),
    ('liftFrom', 0x2016, 60, '$A143', 'a odkud se bere čistá kopie'),
]


def unpack_runs(mem, at, end, cells):
    """Rozbalí proud dvojic (kolik, co), jak to dělá `$9DF8`: **`kolik` je
    o jedna menší, než kolik se jich napíše** (`DEX` / `BPL`), a řádek končí,
    až se jich napíše 40."""
    out, i = [], at
    for _row in range(ROWS):
        y = 0
        while y < COLUMNS:
            if i + 1 >= end:
                return out, i
            count, value = mem[i], mem[i + 1]
            i += 2
            for _ in range(count + 1):
                out.append(value)
                y += 1
    return out, i


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo diskety')
    ap.add_argument('-o', default='data/terminal.json')
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)
    checks, diffs = 0, 0

    # ★ Rozbalení se tu **dělá**, ne jen opisuje: je to nejlevnější důkaz, že
    # je formát přečtený správně — z obou proudů musí vyjít přesně 24 × 40
    # buněk a ani jeden nesmí přetéct do toho druhého.
    chars, charsEnd = unpack_runs(mem, SCREEN_CHARS, SCREEN_COLORS, ROWS * COLUMNS)
    colors, colorsEnd = unpack_runs(mem, SCREEN_COLORS, SCREEN_END, ROWS * COLUMNS)
    for what, got, end, limit in (('znaky', chars, charsEnd, SCREEN_COLORS),
                                  ('barvy', colors, colorsEnd, SCREEN_END)):
        checks += 2
        if len(got) != ROWS * COLUMNS:
            diffs += 1
            print('  %s: rozbalilo se %d buněk, ne %d' % (what, len(got), ROWS * COLUMNS))
        if end > limit:
            diffs += 1
            print('  %s: proud přetekl na $%04X, za $%04X' % (what, end, limit))

    tables = {}
    for name, at, length, reader, what in TABLES:
        tables[name] = {'addr': '$%04X' % at, 'reader': reader, 'what': what,
                        'values': list(mem[at:at + length])}
        checks += 1
        if len(tables[name]['values']) != length:
            diffs += 1

    # ★ a jedna kontrola navíc: obě tabulky lift resetu musí být stejně dlouhé
    # a ukazovat tam, kde doopravdy něco je
    where = tables['liftWhere']['values']
    frm = tables['liftFrom']['values']
    checks += 1
    if len(where) != len(frm):
        diffs += 1
    pairs = 0
    for i in range(0, len(where) - 2, 2):
        target = frm[i] | (frm[i + 1] << 8)
        record = where[i] | (where[i + 1] << 8)
        checks += 2
        if not (0x1D64 <= target < 0x1FDA):
            diffs += 1
            print('  lift reset %d: kopie na $%04X leží mimo $1D64-$1FD9' % (i // 2, target))
        elif not (0x0EB0 <= record <= 0x1D63):
            diffs += 1
            print('  lift reset %d: záznam na $%04X leží mimo záznamy místností' % (i // 2, record))
        else:
            pairs += 1
    # ★ Poslední dvojice je **zarážka** `$FFFF` — `$A130` se ptá, dokud se
    # netrefí, takže kdyby se hledal výtah místnosti, která žádný nemá,
    # skončilo by to tam. ★ A dvojic je **29**, což je přesně tolik, kolik
    # místností výtah má (§23) — nezávislá kontrola obojího.
    checks += 2
    if (frm[-2] | (frm[-1] << 8)) != 0xFFFF:
        diffs += 1
        print('  tabulka lift resetu nekončí zarážkou $FFFF')
    if pairs != 29:
        diffs += 1
        print('  dvojic lift resetu je %d, ne 29 (kolik místností má výtah, §23)' % pairs)

    data = {
        'source': __doc__.split('\n')[0],
        'note': ('★ Terminál je celá obrazovka, ne okno (§29): `$9D09` si schová '
                 'obrazovku a registry VIC na zásobník a rozbalí obrazovku '
                 'terminálu po délkách. ★ Znakovou sadu má společnou se šachtou '
                 '($4800, data/charset_shaft.json) — jen si na ni přepne $D018.'),
        'screen': {'chars': {'addr': '$%04X' % SCREEN_CHARS, 'runsTo': '$%04X' % charsEnd},
                   'colors': {'addr': '$%04X' % SCREEN_COLORS, 'runsTo': '$%04X' % colorsEnd},
                   'rows': ROWS, 'columns': COLUMNS,
                   'note': 'dvojice (kolik−1, co); rozbalené je to tady, zabalené '
                           'v `runs`, a nástroj kontroluje, že z obou vyjde 24 × 40',
                   'runs': {'chars': list(mem[SCREEN_CHARS:charsEnd]),
                            'colors': list(mem[SCREEN_COLORS:colorsEnd])},
                   'values': chars, 'colorValues': colors,
                   'colorNote': '★ barvy jsou **syrové**: hodnota se sedmým bitem '
                                'znamená „vezmi $E7" (`$9E22`), což je pozadí '
                                'místnosti | $08 — terminál se tím obarví podle '
                                'toho, odkud se do něj vešlo'},
        'tables': tables,
        'liftResetPairs': pairs,
        'zeroPage': {'$8A': 'kurzor v menu, 0 lift reset, 1 snooze, 2 odchod',
                     '$E7': 'barva pozadí místnosti | $08, kterou se doplní barvy',
                     '$E8': 'ukazatel zásobníku, přes který se sahá na návratovou adresu'},
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    if a.show:
        letters = {}
        for i, ch in enumerate('abcdefghijklmnopqrstuvwxyz'):
            letters[0x71 + i] = ch
        for row in range(ROWS):
            line = ''.join(letters.get(c, ' ' if c == 0x53 else '?')
                           for c in chars[row*COLUMNS:(row + 1)*COLUMNS])
            if line.strip():
                print('%2d |%s|' % (row, line))

    print('%s: obrazovka %d × %d, %d tabulek, %d dvojic lift resetu'
          % (a.o, ROWS, COLUMNS, len(tables), pairs))
    print('dumpterminal: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
