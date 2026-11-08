#!/usr/bin/env python3
"""dumpcomputer — tabulky a texty kapesního počítače do data/computer.json.

★ **Kapesní počítač je `$3AC6`** a jeho smyčka `$3AF5`
(`sources/docs/disasm_notes.md` §34). Šest přihrádek, ve kterých se skládá
skládačka, **nejsou obrázky ani sprajty — je to znaková sada**: `$82AB`
udělá z čísla přihrádky adresu `$5C50 + $90*n`, tedy přesně to okno do sady
počítače, o kterém mluví §14.

Co z programu potřebuje přepis, a co na disketě je, ale v paměti remaku ne:

| adresa | délka | co to je | kdo ji čte |
|---|---|---|---|
| `$720C` | 6 | X šesti přihrádek pro sprajt ruky a značky | `$3EA8`, `$3EF4` |
| `$7212` | 6 | a jejich Y | `$3EA8`, `$3EFA` |
| `$7A55` | 6 | dolní půlka adresy barevné paměti přihrádky | `$7A37` |
| `$7A5B` | 6 | a horní | `$7A37` |
| `$7C3C` | 8 | barvy osmi řádků obrazovky telefonu | `$7C05` |
| `$7C44` | 176 | **znaky obrazovky telefonu**, osm řádků po 22 | `$7BE9` |
| `$7CF4` | 88 | **čtyři věty telefonu** po 22 znacích | `$7FFE` |
| `$7E36` | 14 | dvě melodie po sedmi tónech (`0` znamená `$0B`) | `$7DCD` |
| `$7E6D` | 48 | čtyři tabulky frekvencí hlasu na druhém konci | `$7E44` |
| `$81FB` | 176 | **osm hlášek počítače** po 22 znacích, v jednom pásu | `$81CD` |
| `$B563` | 48 | legenda, kterou mapa prohodí do `$5F80` | `$B686` |

★ **Šestnáct tvarů dílku `$2763` tu není** a je to schválně: veze je
`data/puzzle.json` od M2, jen je do paměti dosud nikdo nesypal, protože
`$9C3A` se do M5 nevolalo. Dosadí je `pocketComputer.seedMemory`.

★ A **hlášky se překrývají po dvaadvaceti bajtech**, takže je to jeden pás,
ne osm řetězců: `$81B8` dostane adresu a opíše od ní dvaadvacet znaků. Osm
adres, které v kódu opravdu jsou, se tu proto **dohledá v kódu** a vypíše,
a kontrola je, že každá sedí na násobek dvaadvaceti od `$81FB`.

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`).

    ./tools/dumpcomputer.py             # → data/computer.json
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# (jméno, adresa, délka, kdo ji čte, co to je)
TABLES = [
    ('slotX', 0x720C, 6, '$3EA8, $3EF4', 'X šesti přihrádek'),
    ('slotY', 0x7212, 6, '$3EA8, $3EFA', 'Y šesti přihrádek'),
    ('slotColorLo', 0x7A55, 6, '$7A37', 'dolní půlka adresy barevné paměti přihrádky'),
    ('slotColorHi', 0x7A5B, 6, '$7A37', 'a horní'),
    ('phoneRowColors', 0x7C3C, 8, '$7C05', 'barvy osmi řádků obrazovky telefonu'),
    ('phoneScreen', 0x7C44, 176, '$7BE9', 'znaky obrazovky telefonu, 8 × 22'),
    ('phoneTexts', 0x7CF4, 88, '$7FFE', 'čtyři věty telefonu po 22 znacích'),
    ('phoneTune', 0x7E36, 14, '$7DCD', 'dvě melodie po sedmi tónech'),
    ('phoneNotes', 0x7E6D, 48, '$7E44', 'čtyři tabulky frekvencí, index 1..$0B'),
    ('messages', 0x81FB, 176, '$81CD', 'osm hlášek počítače po 22 znacích'),
    ('mapLegend', 0xB563, 48, '$B686', 'legenda, kterou mapa prohodí do $5F80'),
]

MESSAGES_AT, MESSAGE_LEN, MESSAGES = 0x81FB, 22, 8
# osm volání `$81B8` v programu: (adresa volajícího, co se říká)
SAYS = [
    (0x3BB4, 0x8211, 'colors must match'),
    (0x3BBF, 0x8227, "images can't overlap"),
    (0x3DC1, 0x827F, 'time is suspended'),
    (0x7905, 0x823D, 'no image selected'),
    (0x7A65, 0x8269, "can't undo"),
    (0x7AAC, 0x8253, 'end of memory'),
    (0x7B36, 0x8253, 'end of memory'),
    (0x80F3, 0x8295, 'we just did this one'),
]
# čtyři věty telefonu: index je **kde opis končí** (`$7FFC LDY #$15`)
PHONE_SAYS = [(0x15, 'a solution exists.'), (0x2B, 'need more pieces.'),
              (0x41, 'orientation corrected'), (0x57, 'nothing in memory')]

# ★ písmena sady počítače: `a` = $66, mezera = $53, tečka = $FE (§16)
def text(codes):
    out = ''
    for c in codes:
        if c == 0x53:
            out += ' '
        elif 0x66 <= c <= 0x7F:
            out += chr(ord('a') + c - 0x66)
        elif 0x80 <= c <= 0x89:
            out += chr(ord('0') + c - 0x80)
        elif c == 0xFE:
            out += '.'
        elif c == 0xF7:
            out += '.'
        elif c in (0xF8, 0xF9):
            out += '"'
        elif c == 0xFA:
            out += "'"
        elif c == 0x1B:
            out += '?'
        else:
            out += '~'
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo diskety')
    ap.add_argument('-o', default='data/computer.json')
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)
    checks, diffs = 0, 0

    tables = {}
    for name, at, length, reader, what in TABLES:
        values = list(mem[at:at + length])
        tables[name] = {'addr': '$%04X' % at, 'reader': reader, 'what': what,
                        'values': values}
        checks += 1
        if len(values) != length:
            diffs += 1
            print('  %s: %d bajtů místo %d' % (name, len(values), length))

    # ★ kontrola 1: šest přihrádek musí být **tři sloupce a dva řádky** a jejich
    # adresy barevné paměti musí ležet v `$D800`-`$DBFF` a na správných řádcích
    lo, hi = tables['slotColorLo']['values'], tables['slotColorHi']['values']
    rows = []
    for i in range(6):
        at = lo[i] | (hi[i] << 8)
        checks += 2
        if not (0xD800 <= at <= 0xDBFF):
            diffs += 1
            print('  přihrádka %d: barevná paměť na $%04X' % (i, at))
        cell = at - 0xD800
        rows.append((cell // 40, cell % 40))
        if (cell // 40) not in (16, 19):
            diffs += 1
            print('  přihrádka %d: řádek %d, čekalo se 16 nebo 19' % (i, cell // 40))
    checks += 1
    if [r for r, _c in rows] != [16, 16, 16, 19, 19, 19]:
        diffs += 1
        print('  přihrádky nejsou tři a tři: %r' % (rows,))

    # ★ kontrola 2: osm hlášek musí sedět na násobek 22 od `$81FB` a musí se
    # dát přečíst — tím padá podezření, že je to osm samostatných řetězců
    says = []
    for caller, at, what in SAYS:
        checks += 2
        if (at - MESSAGES_AT) % MESSAGE_LEN:
            diffs += 1
            print('  hláška $%04X není násobek %d od $%04X' % (at, MESSAGE_LEN, MESSAGES_AT))
        codes = list(mem[at:at + MESSAGE_LEN])
        got = text(codes).strip()
        if got != what:
            diffs += 1
            print('  hláška $%04X: %r, čekalo se %r' % (at, got, what))
        says.append({'addr': '$%04X' % at, 'from': '$%04X' % caller,
                     'text': got, 'codes': codes})

    # ★ kontrola 3: totéž na čtyři věty telefonu, kde je index **konec** opisu
    phone = []
    for end, what in PHONE_SAYS:
        checks += 1
        codes = list(mem[0x7CF4 + end - 0x15:0x7CF4 + end + 1])
        got = text(codes).strip()
        if got != what:
            diffs += 1
            print('  věta telefonu $%02X: %r, čekalo se %r' % (end, got, what))
        phone.append({'end': '$%02X' % end, 'text': got, 'codes': codes})

    # ★ kontrola 4: melodie telefonu se indexují do `$7E6D`, tedy 1..$0B —
    # nula je v tabulce dovolená a `$7DD2` ji mění na `$0B`
    for i, note in enumerate(tables['phoneTune']['values']):
        checks += 1
        if note > 0x0B:
            diffs += 1
            print('  tón %d melodie je %d, mimo 0..$0B' % (i, note))

    out = {
        'note': 'tabulky a texty kapesního počítače (tools/dumpcomputer.py, §34)',
        'from': a.mem or a.disk,
        'geometry': {'window': '$5C50', 'slot': '$90', 'slots': 6,
                     'parked': '$C690',
                     'what': 'šest přihrádek je okno do sady počítače (§14)'},
        'tables': tables,
        'says': says,
        'phoneSays': phone,
    }
    json.dump(out, open(a.o, 'w'), indent=1)
    if a.show:
        for s in says:
            print('  %s  %s' % (s['addr'], s['text']))
        for s in phone:
            print('  telefon %s  %s' % (s['end'], s['text']))
    print('dumpcomputer: %d kontrol, %d rozdílů → %s' % (checks, diffs, a.o))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
