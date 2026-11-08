#!/usr/bin/env python3
"""dumpsprites — sprajty z doloženého obrazu paměti do data/sprites.json.

★ **Sprajty jsou statická data** (`sources/docs/disasm_notes.md` §13). Leží
v bance 1, hned za znakovými sadami, a nic je za běhu nepřepisuje — kromě
jediné věci, a ta je popsaná níž. Kdo je kde, se **nehádá z obrázku**:
plyne to z tabulek, které čte kód.

| adresa | ukazatele | co to je | kdo to nastavuje |
|---|---|---|---|
| `$6000`–`$6FFF` | `$80`–`$BF` | **agent**, 28 stavů | `$8731` z tabulek `$8D41`/`$8D5D`/`$8D95` |
| `$7000`–`$71BF` | `$C0`–`$C6` | **robot**, 7 fází | `$A68B` (sprajty 4–7), krok `$90C3` |
| `$47C0` | `$1F` | **koule** | `$A729` (sprajt 0, multicolor) |
| `$4400`–`$45FF`, `$4780`, `$4CC0`–`$4D40` | jednotlivé | ? drobnosti | jmenované místem v kódu |

**Agent.** Stav agenta je `$3F`. Obsluha `$8731` z něj vezme základ
ukazatele z **`$8D41`** a posadí ho na sprajty: `$43FA` = základ,
`$43FB` = +1, `$43F9` = +2 (u stavů `$07`–`$0D` +3). Tatáž věc podruhé:
**`$8D5D`** je táž tabulka jako adresa (slovo na stav) a nástroj tím obě
proti sobě kontroluje — `$4000 + ukazatel*64` musí dát adresu. Kolik bloků
stav zabírá, říká **`$8D95`**: `$FC` = 4 bloky, `$BC` = 3, `$7C` = 2.
Sjednocení všech stavů je přesně **64 bloků `$6000`–`$6FFF`, bez děr**.

★ **Jediný zápis do sprajtů za běhu je zrcadlení.** Agent má v datech jen
jedno natočení; když se otočí, rutina **`$8795`** blok **převrátí na místě**:
bajty 0 a 2 každého řádku prohodí a všechny tři obrátí po bitech tabulkou
**`$C500`** (256 B, staví ji `$3939` při inicializaci — `A` se osmkrát
protočí přes `ASL $E4`/`ROR A`). Natočení si blok pamatuje v **63. bajtu**
(nevyužitém, VIC ho nečte): `$80` vlevo, `$01` vpravo, a jedno je obrácením
druhého. Proto smí být v datech `$80` u všech 64 bloků agenta — a je.
Robot je multicolor a nezrcadlí se (63. bajt má nulu, má vlastní fáze).

Obraz paměti staví `tools/unpack.py` kódem zavaděče originálu a je doložený
proti stroji (`tools/matchimage.py`: 57 088 kontrol, 0 nevysvětlených),
takže k vytažení sprajtů není potřeba emulátor. Že to jsou opravdu bajty,
které má stroj, měří `tools/matchsprites.mjs` — a to i přes zrcadlení.

    ./tools/dumpsprites.py                 # → data/sprites.json
    ./tools/dumpsprites.py --print 128     # + výpis bloku po pixelech
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

BANK = 1
BANK_BASE = BANK * 0x4000
BLOCK = 64                      # bajtů na blok sprajtu (63 obrazových + 1)
ROWS, BYTES_PER_ROW = 21, 3

AGENT_PTRS = 0x8D41             # 28 B: základ ukazatele na stav agenta
AGENT_SRC = 0x8D5D              # 28 slov: tatáž věc jako adresa
AGENT_SPAN = 0x8D95             # 28 B: $FC = 4 bloky, $BC = 3, $7C = 2
AGENT_STATES = 28
FACING_BYTE = 63                # 63. bajt bloku = natočení ($80 vlevo, $01 vpravo)
FACING_LEFT = 0x80
MIRROR_TABLE = 0xC500           # 256 B obrácených bajtů, staví je $3939

ROBOT_FIRST, ROBOT_LAST = 0xC0, 0xC6     # $A68B nastaví $C0, krok $90C3 mezi $C0 a $C6

# ★ ostatní bloky, na které kód ukazuje; pojmenované **místem v kódu**, ne
# tím, jak vypadají — co není doložené, je `?`
SINGLES = [
    (0x10, '$3EBA — sprajt 4, barva 1'),
    (0x11, '$AFEF — sprajt 7, barva 1'),
    (0x12, '$B025 — sprajt 0, zdvojený Y'),
    (0x13, '$3EE7 — sprajt 6, zdvojený X, barva 8'),
    (0x14, '$8FA9 — sprajt 0, losovaný ze čtyř ($14-$17), hires, zdvojený X'),
    (0x15, '$8FA9 — druhý ze čtyř'),
    (0x16, '$8FA9 — třetí ze čtyř'),
    (0x17, '$8FA9 — čtvrtý ze čtyř'),
    # ★ osm bloků, kterými se zdobí **bezpečnostní terminál** (§29): `$9DC6`
    # je sází rovnou do `$43F8`-`$43FF`, tedy **všech osm sprajtů naráz**,
    # a tabulka `$9EF9` je pojmenovává v pořadí sprajtů
    (0x18, '$9EF9 — bezpečnostní terminál, sprajt 0'),
    (0x19, '$9EF9 — terminál, sprajt 1'),
    (0x1A, '$9EF9 — terminál, sprajt 2'),
    (0x1B, '$9EF9 — terminál, sprajt 3'),
    (0x1C, '$9EF9 — terminál, sprajty 4 a 7'),
    (0x1D, '$9EF9 — terminál, sprajty 5 a 6'),
    (0x1E, '$A675 — sprajt 0, $D01C = $80'),
    (0x1F, '$A729 — sprajt 0, multicolor: ★ koule'),
    (0x33, '$A656 — sprajty 4-7 z tabulky $A67B'),
    (0x34, '$A656 — totéž, druhý'),
    (0x35, '$A656 — totéž, třetí'),
]
# ★ $36-$38 ($4D80-$4E00) **nejsou data**: `$9720` tam odloží tři živé bloky
# agenta a přepne na ně ukazatele; obsah je pokaždé jiný
BUFFER = (0x36, 0x38, '$9720 — odložená kopie tří živých bloků agenta')


def rows_of(mem, addr):
    """Blok po řádcích jako trojice bajtů — tak, jak ho čte VIC."""
    return [list(mem[addr + r*BYTES_PER_ROW:addr + (r + 1)*BYTES_PER_ROW]) for r in range(ROWS)]


def render(mem, addr):
    """Blok po pixelech, hires — jen pro oko, do dat to nejde."""
    out = []
    for row in rows_of(mem, addr):
        out.append(''.join('#' if (b >> bit) & 1 else '.' for b in row for bit in range(7, -1, -1)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo rozbalení diskety')
    ap.add_argument('-o', default='data/sprites.json')
    ap.add_argument('--print', dest='show', type=lambda x: int(x, 0), action='append',
                    default=[], metavar='PTR', help='vypsat blok po pixelech')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)

    checks = diffs = 0

    def check(ok, what):
        nonlocal checks, diffs
        checks += 1
        if not ok:
            diffs += 1
            print('  ROZDÍL: %s' % what)

    # --- agent: dvě tabulky, které musí říkat totéž ----------------------
    states, agent_blocks = [], set()
    for s in range(AGENT_STATES):
        ptr = mem[AGENT_PTRS + s]
        src = mem[AGENT_SRC + 2*s] | mem[AGENT_SRC + 2*s + 1] << 8
        span = mem[AGENT_SPAN + s]
        count = span // BLOCK + 1
        check(BANK_BASE + ptr*BLOCK == src,
              'stav %d: $8D41 dá $%04X, $8D5D $%04X' % (s, BANK_BASE + ptr*BLOCK, src))
        # ★ rozdání na sprajty je doslova `$8731`: ukazatel se posouvá o jedna
        # za každý sprajt, který stav použije, a u stavů `$14`-`$19` sprajt 2
        # vůbec nejde ($873C vypne bit 2 v `$D015` a `$43FA` se nenastaví)
        y = ptr
        uses2 = not (0x14 <= s < 0x1A)
        sprite2 = y if uses2 else None
        if uses2:
            y += 1
        sprite3 = y
        y += 1
        if 0x07 <= s < 0x0E:            # $8753: tyhle stavy berou o blok dál
            y += 1
        sprite1 = y
        check(sprite1 - ptr < count,
              'stav %d sahá na blok +%d, ale $8D95 dává jen %d'
              % (s, sprite1 - ptr, count))
        states.append({'state': s, 'pointer': ptr, 'addr': '$%04X' % src,
                       'blocks': count, 'mirrorSpan': span,
                       'sprite1': sprite1, 'sprite2': sprite2, 'sprite3': sprite3})
        agent_blocks.update(range(ptr, ptr + count))

    first, last = min(agent_blocks), max(agent_blocks)
    check(sorted(agent_blocks) == list(range(first, last + 1)),
          'bloky agenta mají díru: %s' % sorted(set(range(first, last + 1)) - agent_blocks))

    # --- bloky ------------------------------------------------------------
    blocks = {}

    def take(ptr, what):
        addr = BANK_BASE + ptr*BLOCK
        blocks['$%04X' % addr] = {'pointer': ptr, 'what': what,
                                  'bytes': list(mem[addr:addr + BLOCK])}
        return addr

    for ptr in sorted(agent_blocks):
        addr = take(ptr, 'agent')
        check(mem[addr + FACING_BYTE] == FACING_LEFT,
              'blok agenta $%04X má v 63. bajtu $%02X, ne $%02X'
              % (addr, mem[addr + FACING_BYTE], FACING_LEFT))
    for ptr in range(ROBOT_FIRST, ROBOT_LAST + 1):
        addr = take(ptr, 'robot, fáze %d' % (ptr - ROBOT_FIRST))
        check(mem[addr + FACING_BYTE] == 0,
              'robot $%04X má v 63. bajtu $%02X, ne nulu' % (addr, mem[addr + FACING_BYTE]))
    for ptr, what in SINGLES:
        take(ptr, what)

    # --- tabulka obracení bajtů ------------------------------------------
    # ★ ve statickém obrazu ještě není — staví ji `$3939` při inicializaci,
    # a co na té adrese v obrazu leží, jsou zbytky titulky
    mirror = [int('{:08b}'.format(i)[::-1], 2) for i in range(256)]

    data = {
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': 'sprajty jsou statická data; jediný zápis za běhu je zrcadlení '
                'agenta rutinou $8795 (disasm_notes.md §13)',
        'bank': BANK, 'bankBase': '$%04X' % BANK_BASE, 'blockBytes': BLOCK,
        'agent': {
            'addr': '$%04X-$%04X' % (BANK_BASE + first*BLOCK, BANK_BASE + last*BLOCK + BLOCK - 1),
            'multicolor': False,
            'tables': {'pointers': '$%04X' % AGENT_PTRS, 'sources': '$%04X' % AGENT_SRC,
                       'spans': '$%04X' % AGENT_SPAN},
            'dispatch': '$8731 — $43FA = základ, $43FB = +1, $43F9 = +2 (stavy $07-$0D +3)',
            'facingByte': FACING_BYTE, 'facingLeft': '$%02X' % FACING_LEFT,
            'mirror': {'routine': '$8795', 'table': '$%04X' % MIRROR_TABLE,
                       'builtBy': '$3939', 'bytes': mirror},
            'states': states,
        },
        'robot': {
            'addr': '$%04X-$%04X' % (BANK_BASE + ROBOT_FIRST*BLOCK,
                                     BANK_BASE + ROBOT_LAST*BLOCK + BLOCK - 1),
            'multicolor': True, 'pointers': [ROBOT_FIRST, ROBOT_LAST],
            'setBy': '$A68B — sprajty 4-7, $D01C = $F0',
            'stepBy': '$90C3 — ukazatel o jedna nahoru nebo dolů mezi $C0 a $C6',
        },
        'buffer': {'pointers': [BUFFER[0], BUFFER[1]],
                   'addr': '$%04X-$%04X' % (BANK_BASE + BUFFER[0]*BLOCK,
                                            BANK_BASE + BUFFER[1]*BLOCK + BLOCK - 1),
                   'what': BUFFER[2], 'note': 'není to data, obsah je pokaždé jiný'},
        'blocks': blocks,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    for ptr in a.show:
        addr = BANK_BASE + ptr*BLOCK
        print('blok %d ($%04X):' % (ptr, addr))
        for line in render(mem, addr):
            print('  ' + line)

    print('%s: %d bloků (agent %d, robot %d, ostatní %d), 28 stavů agenta'
          % (a.o, len(blocks), len(agent_blocks), ROBOT_LAST - ROBOT_FIRST + 1, len(SINGLES)))
    print('dumpsprites: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
