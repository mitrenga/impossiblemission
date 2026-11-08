#!/usr/bin/env python3
"""dumpcharset — znaková sada z doloženého obrazu paměti do data/*.json.

Sada leží tam, kam ukazuje `$D018` (v bance podle `$DD00`). Doložené jsou
dvě:

- `--title`: **sada titulky** z `$C800` ze stavu, kdy titulka v paměti
  existuje; obraz je ověřený pixel po pixelu proti emulátoru
  (`tools/matchscreen.mjs`, 64 000 / 0).
- `--room`: ★ **sada místnosti z `$5000`**. Není to dohad z `$D018` při
  prvním přerušení (ten dal `$0800` a nesmysl) — stavitel místnosti sám
  nastavuje `$D018 = (staré & $F0) | $04` (`$A3C6`, `disasm_notes.md` §12),
  a to je v bance 1 (`$4000`) právě `$5000`. Sedí to i na znacích, které
  stavitel sází: `$45`/`$46` podlaha, `$47`/`$48` stěny, `$49`–`$4B`
  dlaždice šachty, `$53` prázdno.

★ **Řídicí místnosti (`$11` a `$1B`) sadu přepisují za běhu**: `$A649`
nakopíruje **144 bajtů z `$3063` na `$5000`**, tedy glyfy `$00`–`$11`, které
jsou v základní sadě prázdné. Proto je v `charset_room.json` základní sada
i ta záplata, a `tools/matchcharset.mjs` měří obojí proti běžící hře.

- `--shaft` a `--computer`: ★ **sady šachty (`$4800`) a kapesního počítače
  (`$5800`)** (`disasm_notes.md` §14). Dlouho vypadaly, že statické nejsou —
  a ono se liší jen to, co **nejsou glyfy**:

  1. **Záplata z Char ROM.** `$39AA`–`$39D6` si přepne `$01 = $21` (Char ROM
     místo I/O) a nakopíruje **26 písmen a 10 číslic** do **obou sad naráz**:
     `$D008` → `$4B88` i `$5B30` (208 B, glyfy `$71`–`$8A`, resp. `$66`–`$7F`)
     a `$D180` → `$4C58` i `$5C00` (80 B, číslice). Bajt po bajtu to sedí
     s `sources/rom/characters.901225-01.bin`.
  2. **Okno do obrázku mapy pevnosti.** `$5C50`–`$5FAF` (864 B) je výřez
     obrázku, který losování mapy postavilo na `$FC00` (§11); posouvá ho
     `$7B32` po 48 bajtech. Losuje se, takže to data nejsou.
  3. **Tři nárazníky přes nepoužité glyfy sady šachty**: `$4D80`–`$4E3F`
     odložená kopie sprajtů agenta (`$9720`, §13), `$4F55`–`$4F91` záznamy
     nábytku místnosti (`$A504`, §12) a **`$4FB5`–`$4FBD` vylosované heslo**
     (`$B0D7` je zapíše, `$80FF` čte). Ve statickém obrazu jsou všechna tři
     místa nulová, takže žádný glyf nepřepisují.

Obraz paměti staví `tools/unpack.py` kódem
zavaděče originálu a je doložený proti stroji (`tools/matchimage.py`:
57 088 kontrol, 0 nevysvětlených), takže k vytažení sady není potřeba
emulátor.

    ./tools/dumpcharset.py --room                     # → data/charset_room.json
    ./tools/dumpcharset.py --room --png build/charset_room.png   # + obrázek
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

SET_BYTES = 2048
ROOM_SET = 0x5000            # sada místnosti (banka 1, `$D018 = ..|$04`)
CONTROL_PATCH = 0x3063       # 144 B, které si na ni přepíše řídicí místnost
CONTROL_GLYPHS = 18

# ★ hra má tři sady v bance 1 a čtvrtou má titulka; která kde, je změřené
# na běžícím stroji (`data/elevator.json`, `data/room.json`)
GAME_SETS = {
    'shaft': (0x4800, 'šachta a chodby — horní půlka obrazovky ve výtahu'),
    'room': (ROOM_SET, 'místnost — celá obrazovka, nastavuje ji stavitel $A3C6'),
    'computer': (0x5800, 'kapesní počítač — dolní půlka obrazovky ve výtahu'),
}

# ★ záplata z Char ROM: `$39AA`-`$39D6` ji nakopíruje do obou sad naráz
CHAR_ROM = 'sources/rom/characters.901225-01.bin'
ROM_COPY = (
    # (odkud v Char ROM, kolik, kam v šachtě, kam v počítači, čím se to dělá)
    (0x0008, 208, 0x4B88, 0x5B30, 'A-Z, 26 glyfů — $39B1'),
    (0x0180, 80, 0x4C58, 0x5C00, '0-9, 10 glyfů — $39C6'),
)

# ★ co v té 2 KB sady **nejsou glyfy**: nárazníky, které si hra položila
# přes prázdná místa (všechna jsou v obrazu nulová, viz kontrola v nástroji)
OVERLAYS = {
    'shaft': (
        (0x4D80, 0xC0, 'odložená kopie tří živých bloků sprajtů agenta ($9720, §13)'),
        (0x4EF5, 0x60, '★ dílky skládačky v paměti kapesního počítače (§15): dvě '
                       'tabulky po 48 — $4EF5 čísla dílků ($FF = prázdno, '
                       '$39C1 je tak nastaví, $7F82 je čte), $4F25 ? druhá k nim '
                       '($7B41); že je krok 48, plyne z $7B41/$7B46 nad týmž Y'),
        (0x4F55, 0x3D, 'záznamy nábytku postavené místnosti ($A504, §12); '
                       'v 32 naměřených místnostech nejdál na $4F91'),
        (0x4FB5, 9, '★ vylosované heslo ($B0D7 zapíše, $80FF čte) — devět '
                    'písmen, a = $66 (§9)'),
    ),
    'computer': (
        (0x5C50, 0x360, '★ okno do obrázku mapy pevnosti z $FC00 (§11); '
                        'posouvá ho $7B32 po 48 bajtech — losuje se, data to nejsou'),
    ),
}


def glyph_rows(bytes_, code):
    return list(bytes_[code*8:code*8+8])


# paleta VIC-II, měřená Peptem — táž čísla jako `svision/.../c64Color.js`
VIC_PALETTE = [
    (0x00, 0x00, 0x00), (0xFF, 0xFF, 0xFF), (0x68, 0x37, 0x2B), (0x70, 0xA4, 0xB2),
    (0x6F, 0x3D, 0x86), (0x58, 0x8D, 0x43), (0x35, 0x28, 0x79), (0xB8, 0xC7, 0x6F),
    (0x6F, 0x4F, 0x25), (0x43, 0x39, 0x00), (0x9A, 0x67, 0x59), (0x44, 0x44, 0x44),
    (0x6C, 0x6C, 0x6C), (0x9A, 0xD2, 0x84), (0x6C, 0x5E, 0xB5), (0x95, 0x95, 0x95),
]


def multicolor_palette(a):
    """Čtyři barvy, ve kterých se glyf místnosti opravdu kreslí.

    Dvojice bitů jde na `$D021`, `$D022`, `$D023` a na barvu buňky
    (v multicoloru se z ní bere spodní trojice bitů). Bere se z místnosti,
    kterou nachytal `tools/tracerooms.py`; když záznam není, vezmou se
    barvy z `data/rooms.json` a černé pozadí."""
    bg = 0
    try:
        vic = open('%s/r%02d_vic.bin' % (a.trace_dir, a.png_room), 'rb').read()
        bg, bg1, bg2 = vic[0x21] & 15, vic[0x22] & 15, vic[0x23] & 15
    except OSError:
        rooms = json.load(open('data/rooms.json'))['rooms'][a.png_room]
        bg1, bg2 = rooms['bg1'] & 15, rooms['bg2'] & 15
    cell = json.load(open('data/rooms.json'))['rooms'][a.png_room]['floorColor'] & 7
    return [VIC_PALETTE[bg], VIC_PALETTE[bg1], VIC_PALETTE[bg2], VIC_PALETTE[cell]]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--addr', default='0800', help='adresa sady (hex, výchozí 0800)')
    ap.add_argument('-o', default=None)
    ap.add_argument('--png', help='napsat i mřížku 16x16 glyfů jako PNG')
    ap.add_argument('--title', action='store_true',
                    help='sada titulky ($C800) ze stavu, kdy titulka v paměti existuje')
    ap.add_argument('--room', action='store_true',
                    help='sada místnosti ($5000) i se záplatou řídicí místnosti ($3063)')
    ap.add_argument('--shaft', action='store_true',
                    help='sada šachty a chodeb ($4800) ke studiu do build/ — hra si ji přepisuje')
    ap.add_argument('--computer', action='store_true',
                    help='sada počítače ($5800) ke studiu do build/ — hra si ji přepisuje')
    ap.add_argument('--png-room', type=int, default=0, metavar='N',
                    help='z které místnosti vzít barvy do obrázku (výchozí 0)')
    ap.add_argument('--trace-dir', default='build/rooms')
    a = ap.parse_args()

    mem = build(a.disk, verbose=False, stop_after='title' if a.title else None)
    if a.title and a.addr == '0800':
        a.addr = 'c800'
    for name in ('room', 'shaft', 'computer'):
        if getattr(a, name) and a.addr == '0800':
            a.addr = '%04x' % GAME_SETS[name][0]
    at = int(a.addr, 16)
    bytes_ = mem[at:at+SET_BYTES]

    checks = diffs = 0
    used = [c for c in range(256) if any(bytes_[c*8:c*8+8])]
    data = {
        'source': 'rozbalený obraz originálu (tools/unpack.py), $%04X-$%04X' % (at, at+SET_BYTES-1),
        'addr': at, 'glyphs': 256, 'nonEmpty': len(used),
        'bytes': list(bytes_),
    }
    if a.shaft or a.computer:
        which = 'shaft' if a.shaft else 'computer'
        rom = open(CHAR_ROM, 'rb').read()
        parts = []
        for src, length, to_shaft, to_computer, what in ROM_COPY:
            to = to_shaft if a.shaft else to_computer
            parts.append({'addr': to, 'firstGlyph': (to - at)//8, 'glyphs': length//8,
                          'romAddr': src, 'what': what, 'bytes': list(rom[src:src+length])})
            # ★ do sady se kopíruje **prázdné místo** — kdyby tam glyfy byly,
            # záplata by je přepsala a statický výpis by nebyl úplný
            for i in range(length):
                checks += 1
                if bytes_[to - at + i]:
                    diffs += 1
                    print('  ROZDÍL: $%04X pod záplatou z Char ROM není prázdné' % (to + i))
        data['charRom'] = {
            'note': '$39AA-$39D6 přepne $01 = $21 (Char ROM místo I/O) a nakopíruje '
                    'písmena a číslice do sady šachty i počítače naráz',
            'file': CHAR_ROM, 'parts': parts,
        }
        overlays = []
        for addr, length, what in OVERLAYS[which]:
            overlays.append({'addr': addr, 'bytes': length, 'what': what,
                             'firstGlyph': (addr - at)//8, 'glyphs': length/8})
            for i in range(length):
                checks += 1
                if bytes_[addr - at + i]:
                    diffs += 1
                    print('  ROZDÍL: $%04X pod nárazníkem není prázdné' % (addr + i))
        data['overlays'] = overlays

    if a.room:
        patch = mem[CONTROL_PATCH:CONTROL_PATCH+CONTROL_GLYPHS*8]
        data['controlRoom'] = {
            'note': 'řídicí místnosti $11 a $1B si glyfy $00-$11 přepíšou ($A649)',
            'addr': CONTROL_PATCH, 'firstGlyph': 0, 'glyphs': CONTROL_GLYPHS,
            'bytes': list(patch),
        }
        data['tiles'] = {'floorLeft': 0x45, 'floorRight': 0x46, 'wallLeft': 0x47,
                         'wallRight': 0x48, 'blank': 0x53, 'lift': [0x49, 0x4A, 0x4B]}
    out = a.o or ('data/charset_title.json' if a.title
                  else 'data/charset_room.json' if a.room
                  # ★ sady šachty a počítače se v běžící hře liší jen tam, kde
                  # **nejsou glyfy**: záplata z Char ROM, okno do obrázku mapy
                  # a tři nárazníky (`disasm_notes.md` §14) — a to je v datech
                  # pojmenované, takže sem patří stejně jako sada místnosti
                  else 'data/charset_shaft.json' if a.shaft
                  else 'data/charset_computer.json' if a.computer
                  else 'data/charset.json')
    for name in ('room', 'shaft', 'computer'):
        if getattr(a, name):
            data['set'] = name
            data['note'] = GAME_SETS[name][1]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    json.dump(data, open(out, 'w'), indent=1)
    open(out, 'a').write('\n')
    print('%s: 256 glyfů z $%04X, %d neprázdných%s'
          % (out, at, len(used),
             ', + %d glyfů řídicí místnosti z $%04X' % (CONTROL_GLYPHS, CONTROL_PATCH)
             if a.room else ''))
    if checks:
        print('dumpcharset: %d kontrol, %d rozdílů' % (checks, diffs))

    if a.png:
        # 16x16 glyfů po 8x8 pixelech. ★ Sada místnosti je **multicolor**,
        # takže po bitech načernobíle vypadá jako šum — kreslí se proto po
        # dvojicích bitů ve čtyřech barvách místnosti ($D021, $D022, $D023
        # a barva buňky), stejně jako to dělá VIC.
        w = h = 128
        rgba = bytearray(w*h*4)
        colors = multicolor_palette(a) if a.room else None
        for code in range(256):
            gx, gy = (code % 16)*8, (code//16)*8
            rows = glyph_rows(bytes_, code)
            for y in range(8):
                for x in range(8):
                    if colors:
                        rgb = colors[(rows[y] >> (6 - (x & 6))) & 3]
                    else:
                        v = 255 if rows[y] & (0x80 >> x) else 0
                        rgb = (v, v, v)
                    o = ((gy+y)*w+gx+x)*4
                    rgba[o], rgba[o+1], rgba[o+2] = rgb
                    rgba[o+3] = 255
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'svision', 'tools', 'retro'))
        import zlib, struct
        def chunk(tag, payload):
            return (struct.pack('>I', len(payload)) + tag + payload
                    + struct.pack('>I', zlib.crc32(tag+payload) & 0xFFFFFFFF))
        raw = b''.join(b'\x00' + bytes(rgba[y*w*4:(y+1)*w*4]) for y in range(h))
        png = (b'\x89PNG\r\n\x1a\n'
               + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
        os.makedirs(os.path.dirname(os.path.abspath(a.png)), exist_ok=True)
        open(a.png, 'wb').write(png)
        print('%s: mřížka 16x16 glyfů' % a.png)


if __name__ == '__main__':
    main()
