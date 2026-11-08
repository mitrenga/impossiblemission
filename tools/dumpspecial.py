#!/usr/bin/env python3
"""dumpspecial — tabulky a obrázek **dvou zvláštních místností** do
data/special.json.

★ **Nábytek, který není nábytek** (`sources/docs/disasm_notes.md` §35).
`$98F3` se podívá, co ten kus drží, a dvě hodnoty nevedou na prohledávání:

| drží | kdo to obslouží | kde v pevnosti |
|---|---|---|
| `$FE` | `$AA40` **řídicí místnost** — `JSR`, takže se vrátí | místnost **5**, jeden kus |
| `$FB` | `$A771` **kódová místnost** — `JMP`, takže se nevrátí | místnosti **17** a **27** |

★ A obojí je **ve statických záznamech místností**, ne z losování: generátor
(`$B263`) všech 128 slotů vyprázdní a pak do nich sází dílky a terminály,
takže `$FB` a `$FE` musí být v záznamu od začátku — a jsou (kontrola níž).

Co z programu potřebuje přepis:

| adresa | délka | co to je | kdo ji čte |
|---|---|---|---|
| `$A9F8` | 8 | dolní půlka frekvence osmi tónů | `$A97C` |
| `$AA00` | 8 | horní | `$A981` |
| `$AA08` | 8 | barva sprajtu k tónu | `$A986` |
| `$A21A` | 2 | která dvě počitadla v panelu šachty se dají vyhrát | `$A871` |
| `$25F3` | 30 | barvy konzole řídicí místnosti | `$AAA7` |
| `$2611` | 30 | a její znaky | `$AAAD` |
| `$AB67` | 7 | jak dlouhá je která bouře blikání | `$AB2A` |
| `$AB8C` | 13 | první tvář panelu | `$AB7F` |
| `$AB99` | 13 | druhá | `$AB70` |
| `$ABA6` | 13 | kam se sázejí | `$AB73` |
| `$C400` | 1024 | **obrazovka řídicí místnosti** | `$AB0F` (z `$DC00`) |
| `$C000` | 1024 | a její barvy | `$AB20` (z `$F800`) |

★ **Obrázek není tam, kde ho program má.** Vstup hry (`$3868 JSR $71C0`)
odstěhuje tři bloky zpod sebe — `$C800`-`$CFFF` na `$D000`, `$C000`-`$C3FF`
na `$F800` a `$C400`-`$C7FF` na `$DC00` — protože `$C100`, `$C220`, `$C500`
i `$C690` jsou potřeba na něco jiného (§29, §34, §13, §34). Data proto nesou
obrázek **tak, jak ho zná rozbalený obraz**, a `controlRoom.seedMemory` ho
položí na místo, kam ho vstup hry odstěhoval.

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`).

    ./tools/dumpspecial.py             # → data/special.json
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# (jméno, adresa, délka, kdo ji čte, co to je) — kódová místnost
CODE_TABLES = [
    ('freqLo', 0xA9F8, 8, '$A97C', 'dolní půlka frekvence osmi tónů'),
    ('freqHi', 0xAA00, 8, '$A981', 'horní půlka'),
    ('toneColors', 0xAA08, 8, '$A986', 'barva sprajtu k tónu'),
    ('counterSpots', 0xA21A, 2, '$A871', 'která počitadla v panelu šachty se vyhrávají'),
]
# … a řídicí místnost
CONTROL_TABLES = [
    ('consoleColors', 0x25F3, 30, '$AAA7', 'barvy konzole, pět řad po šesti'),
    ('consoleChars', 0x2611, 30, '$AAAD', 'a její znaky'),
    ('rounds', 0xAB67, 7, '$AB2A', 'jak dlouhá je která bouře blikání'),
    ('panelA', 0xAB8C, 13, '$AB7F', 'první tvář panelu'),
    ('panelB', 0xAB99, 13, '$AB70', 'druhá tvář panelu'),
    ('panelSpots', 0xABA6, 13, '$AB73', 'kam se do $C2B6 sázejí'),
]
PICTURE_SCREEN, PICTURE_COLORS, PICTURE_BYTES = 0xC400, 0xC000, 0x400
# kam je vstup hry odstěhuje (`$71C0`)
MOVED_SCREEN, MOVED_COLORS = 0xDC00, 0xF800
PANEL_AT = 0xC2B6
CONTROL_HOLDS, CODE_HOLDS = 0xFE, 0xFB
CONTROL_ROOMS, CODE_ROOMS = [5], [17, 27]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo diskety')
    ap.add_argument('--rooms', default='data/rooms.json')
    ap.add_argument('-o', default='data/special.json')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)
    checks, diffs = 0, 0

    def grab(spec):
        out = {}
        for name, at, length, reader, what in spec:
            values = list(mem[at:at + length])
            out[name] = {'addr': '$%04X' % at, 'reader': reader, 'what': what,
                         'values': values}
        return out

    code, control = grab(CODE_TABLES), grab(CONTROL_TABLES)

    # ★ kontrola 1: osm tónů musí stoupat — je to stupnice, ne náhodná osmice,
    # a `$A98D` z každého dělá dvě oktávy
    lo, hi = code['freqLo']['values'], code['freqHi']['values']
    freq = [(hi[i] << 8) | lo[i] for i in range(8)]
    checks += 1
    if freq != sorted(freq):
        diffs += 1
        print('  osm tónů nestoupá: %r' % ([hex(f) for f in freq],))
    for i in range(1, 8):
        checks += 1
        if not (1.0 < freq[i]/freq[i-1] < 1.3):
            diffs += 1
            print('  tón %d není půltón nad předchozím (%.3f)' % (i, freq[i]/freq[i-1]))

    # ★ kontrola 2: třináct míst panelu musí ležet v obrazovce řídicí místnosti
    for i, spot in enumerate(control['panelSpots']['values']):
        checks += 1
        if not (0xC000 <= PANEL_AT + spot < 0xC400):
            diffs += 1
            print('  místo %d panelu míří na $%04X' % (i, PANEL_AT + spot))

    # ★ kontrola 3: obrázek **není** tam, kam ho hra kopíruje — je o kus níž,
    # protože ho vstup hry odstěhoval (`$71C0`). Tím se čte, odkud pochází.
    screen = list(mem[PICTURE_SCREEN:PICTURE_SCREEN + PICTURE_BYTES])
    colors = list(mem[PICTURE_COLORS:PICTURE_COLORS + PICTURE_BYTES])
    checks += 2
    if not any(screen):
        diffs += 1
        print('  obrazovka řídicí místnosti na $%04X je prázdná' % PICTURE_SCREEN)
    if not any(colors):
        diffs += 1
        print('  barvy řídicí místnosti na $%04X jsou prázdné' % PICTURE_COLORS)
    # ★ Barvy mají **horní půlbajt nenulový** (`$18`, `$19`) a je to v pořádku:
    # barevná paměť C64 má čtyři bity a horní půlku hardware zahodí. Kontroluje
    # se proto, že je to obrázek — víc než jedna barva na spodních čtyřech bitech.
    checks += 1
    if len({c & 0x0F for c in colors}) < 4:
        diffs += 1
        print('  barvy nevypadají jako obrázek: %r' % sorted({c & 0x0F for c in colors}))

    # ★ kontrola 4: v záznamech místností je **jeden** kus s `$FE` a **dva**
    # s `$FB`, a leží tam, kde má §35 napsáno
    rooms = json.load(open(a.rooms))['rooms']
    where = {CONTROL_HOLDS: [], CODE_HOLDS: []}
    for number, room in enumerate(rooms):
        for piece in room['furniture']:
            if piece['slot'] in where:
                where[piece['slot']].append(number)
    checks += 2
    if where[CONTROL_HOLDS] != CONTROL_ROOMS:
        diffs += 1
        print('  řídicí místnost je v %r, čekalo se %r' % (where[CONTROL_HOLDS], CONTROL_ROOMS))
    if where[CODE_HOLDS] != CODE_ROOMS:
        diffs += 1
        print('  kódové místnosti jsou v %r, čekalo se %r' % (where[CODE_HOLDS], CODE_ROOMS))

    out = {
        'note': 'tabulky dvou zvláštních místností (tools/dumpspecial.py, §35)',
        'from': a.mem or a.disk,
        'rooms': {'control': where[CONTROL_HOLDS], 'code': where[CODE_HOLDS],
                  'holds': {'control': '$%02X' % CONTROL_HOLDS,
                            'code': '$%02X' % CODE_HOLDS}},
        'tables': code,
        'control': control,
        'picture': {
            'what': 'obrazovka a barvy řídicí místnosti, jak je zná rozbalený obraz',
            'movedBy': '$71C0 při vstupu hry ($3868)',
            'screen': {'from': '$%04X' % PICTURE_SCREEN, 'to': '$%04X' % MOVED_SCREEN},
            'colors': {'from': '$%04X' % PICTURE_COLORS, 'to': '$%04X' % MOVED_COLORS},
        },
    }
    # obrázek se veze zvlášť, ať se `tables` dá číst okem
    out['picture']['screenBytes'] = screen
    out['picture']['colorBytes'] = colors
    json.dump(out, open(a.o, 'w'), indent=1)
    print('dumpspecial: %d kontrol, %d rozdílů → %s' % (checks, diffs, a.o))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
