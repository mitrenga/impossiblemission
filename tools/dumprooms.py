#!/usr/bin/env python3
"""dumprooms — 32 místností pevnosti z obrazu paměti originálu.

★ Formát záznamu místnosti je odečtený ze stavitele místnosti `$A39C`
(`sources/docs/disasm_notes.md` §12). Ukazatele na záznamy jsou **`$0E70`,
32 položek po dvou bajtech**; `$20D6` (30 položek, generátor, §9) míří do
téhož záznamu, ale až na **seznam robotů**, ne na jeho začátek.

Záznam je proud sekcí, které stavitel čte jednu za druhou přes `($18),Y`:

| sekce | tvar | kdo ji čte |
|---|---|---|
| hlavička | 4 B: `$8D`, `$D022`, `$D023`, barva podlah | `$A3E0` |
| podlahy | `(lo, hi, délka)` … `$FF` | `$A3F6` |
| sloupy | `(lo, hi, znak)` … `$FF` | `$A45D` |
| vstup agenta | 6 B: x, y, MSIGX — **dvakrát**, zleva a zprava | `$ABDB` |
| roboti | `(druh, řádek, sloupec)` … `$FF` | `$A68B` |
| koule | `$FF`, nebo `(druh, x, y)` | `$A714` |
| sprajty | 5 B: `$D025`, `$D026`, barva 4–7, `$4C`, `$D015` | `$A492` |
| výtahy | `(řádek, sloupec, zastávek, …)` do bajtu `>= $80` | `$A4D3` |
| nábytek | `(řádek, sloupec, druh, slot)` do bajtu `>= $80` | `$A504` |

Adresa na obrazovce je `$C100 + řádek*40 + sloupec` (rutina `$AC1B`),
barva `$D800 + totéž`. Tvary nábytku jsou v tabulce **`$232C`** po pěti
bajtech (27 druhů) a bloky znaků a barev za ní, `$23B3`–`$26E2`.

Akceptace je v nástroji: záznamy se **složí zpátky na bajty** a porovnají
s originálem, k tomu dvě křížové kontroly na generátor — `$20D6` musí sedět
na začátky seznamů robotů a všech 128 slotů `$30F3` na **čtvrtý bajt**
záznamu nábytku.

    ./tools/dumprooms.py [--mem build/mem_unpacked.bin] [-o data/rooms.json]
"""
import argparse, json, os, sys

ROOM_PTRS = 0x0E70          # 32 ukazatelů na záznamy místností
GEN_PTRS = 0x20D6           # 30 ukazatelů generátoru (seznamy robotů)
SLOT_PTRS = 0x30F3          # 128 ukazatelů na sloty nábytku
SHAPES = 0x232C             # tabulka tvarů nábytku, 5 B na druh
SHAPE_COUNT = 27
LIFT_TILE = 0x0DB4          # tři znaky dlaždice šachty ($AEA6)
MSIGX_MASKS = 0x0E6C        # masky devátého bitu x sprajtů robotů ($A6E4)
MSIGX_COUNT = 4

# ★ řídicí místnosti ($11 a $1B) dostanou navrch konzoli: **záplatu znakové
# sady** ze `$3063` na glyfy `$00`-`$11` a čtyři sprajty ze `$A67B`
# (`disasm_notes.md` §12, rutina `$A5C9`)
CONTROL_ROOMS = [0x11, 0x1B]
CONTROL_PARTS = [('charsetPatch', 0x3063, 0x90, 0x5000, 'záplata sady místnosti'),
                 ('spritePointers', 0xA67B, 4, 0x43FC, 'ukazatele sprajtů 4-7'),
                 ('spritePositions', 0xA67F, 8, 0xD008, 'pozice sprajtů 4-7'),
                 ('spriteColors', 0xA687, 4, 0xD02B, 'barvy sprajtů 4-7')]
SCREEN = 0xC100             # obrazová paměť místnosti
COLOR = 0xD800


class Reader:
    """Proud bajtů se stejným krokem, jakým ho čte stavitel přes ($18),Y."""

    def __init__(self, mem, at):
        self.mem, self.at, self.start = mem, at, at

    def byte(self):
        b = self.mem[self.at]; self.at += 1; return b

    def bytes(self, n):
        out = list(self.mem[self.at:self.at + n]); self.at += n; return out

    def peek(self):
        return self.mem[self.at]

    def list3(self):
        """Trojice až po `$FF` (podlahy, sloupy, roboti)."""
        out = []
        while self.peek() != 0xFF:
            out.append(self.bytes(3))
        self.byte()
        return out


def cell(addr):
    """Adresa na obrazovce → (řádek, sloupec)."""
    off = addr - SCREEN
    return off // 40, off % 40


def parse_room(mem, addr):
    r = Reader(mem, addr)
    split, bg1, bg2, floor_color = r.bytes(4)
    floors = []
    for lo, hi, length in r.list3():
        row, col = cell(lo | hi << 8)
        floors.append({'addr': lo | hi << 8, 'row': row, 'col': col, 'len': length})
    walls = []
    for lo, hi, char in r.list3():
        row, col = cell(lo | hi << 8)
        walls.append({'addr': lo | hi << 8, 'row': row, 'col': col, 'char': char})
    xl, xr, yl, yr, ml, mr = r.bytes(6)
    robots = [{'type': t, 'row': row, 'col': col} for t, row, col in r.list3()]
    if r.peek() == 0xFF:
        r.byte(); ball = None
    else:
        t, x, y = r.bytes(3)
        ball = {'type': t, 'x': x, 'y': y}
    mc0, mc1, sprcol, unknown4c, enable = r.bytes(5)
    lifts = []
    while r.peek() < 0x80:
        row, col, stops = r.bytes(3)
        tail = []
        while r.peek() < 0x80:
            tail.append(r.byte())
        lifts.append({'row': row, 'col': col, 'stops': stops,
                      'tail': tail, 'term': r.byte()})
    r.byte()                                  # terminátor seznamu výtahů
    furniture = []
    while r.peek() < 0x80:
        at = r.at
        row, col, kind, slot = r.bytes(4)
        furniture.append({'at': at, 'row': row, 'col': col, 'kind': kind, 'slot': slot})
    return {
        'addr': addr, 'split': split, 'bg1': bg1, 'bg2': bg2,
        'floorColor': floor_color, 'floors': floors, 'walls': walls,
        'entry': {'xLeft': xl, 'xRight': xr, 'yLeft': yl, 'yRight': yr,
                  'msigLeft': ml, 'msigRight': mr},
        'robots': robots, 'ball': ball,
        'sprite': {'mc0': mc0, 'mc1': mc1, 'color47': sprcol, 'z4c': unknown4c,
                   'enable': enable},
        'lifts': lifts, 'furniture': furniture, 'end': r.at,
    }


def encode_room(room):
    """Zpátky na bajty — proti tomuhle se měří."""
    out = [room['split'], room['bg1'], room['bg2'], room['floorColor']]
    for f in room['floors']:
        out += [f['addr'] & 0xFF, f['addr'] >> 8, f['len']]
    out.append(0xFF)
    for w in room['walls']:
        out += [w['addr'] & 0xFF, w['addr'] >> 8, w['char']]
    out.append(0xFF)
    e = room['entry']
    out += [e['xLeft'], e['xRight'], e['yLeft'], e['yRight'], e['msigLeft'], e['msigRight']]
    for b in room['robots']:
        out += [b['type'], b['row'], b['col']]
    out.append(0xFF)
    out += [0xFF] if room['ball'] is None else [room['ball']['type'], room['ball']['x'], room['ball']['y']]
    s = room['sprite']
    out += [s['mc0'], s['mc1'], s['color47'], s['z4c'], s['enable']]
    for lift in room['lifts']:
        out += [lift['row'], lift['col'], lift['stops']] + lift['tail'] + [lift['term']]
    out.append(0xFF)
    for f in room['furniture']:
        out += [f['row'], f['col'], f['kind'], f['slot']]
    return out


def parse_shapes(mem):
    """Tvary nábytku: tabulka `$232C` a bloky barev a znaků za ní."""
    shapes = []
    for kind in range(SHAPE_COUNT):
        b = SHAPES + 5 * kind
        lo, hi, size, width, flag = mem[b:b + 5]
        color_at = lo | hi << 8
        chars_at = color_at + size + 1     # ★ `SEC` před `ADC` na $A52C
        shapes.append({'kind': kind, 'at': b, 'colorAddr': color_at,
                       'charAddr': chars_at, 'cells': size + 1, 'width': width + 1,
                       'flag': flag,
                       'colors': list(mem[color_at:color_at + size + 1]),
                       'chars': list(mem[chars_at:chars_at + size + 1])})
    return shapes


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--mem', default='build/mem_unpacked.bin')
    ap.add_argument('-o', dest='out', default='data/rooms.json')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read()
    if len(mem) != 65536:
        raise SystemExit('%s: %d B, čekal jsem obraz 64 KB (tools/unpack.py)' % (a.mem, len(mem)))

    starts = [mem[ROOM_PTRS + 2 * i] | mem[ROOM_PTRS + 2 * i + 1] << 8 for i in range(32)]
    rooms = [parse_room(mem, s) for s in starts]
    shapes = parse_shapes(mem)

    checks = diffs = 0

    # 1. složit zpátky a porovnat bajt po bajtu
    for i, room in enumerate(rooms):
        raw = encode_room(room)
        orig = list(mem[room['addr']:room['addr'] + len(raw)])
        for k, (x, y) in enumerate(zip(raw, orig)):
            checks += 1
            if x != y:
                diffs += 1
                print('místnost %2d, bajt %d ($%04X): %02X != %02X'
                      % (i, k, room['addr'] + k, x, y))

    # 2. záznamy na sebe navazují (poslední končí na konci dat místností)
    order = sorted(range(32), key=lambda i: rooms[i]['addr'])
    for k in range(31):
        checks += 1
        end, nxt = rooms[order[k]]['end'] + 1, rooms[order[k + 1]]['addr']
        if end != nxt:
            diffs += 1
            print('místnost %2d končí na $%04X, další začíná na $%04X'
                  % (order[k], end, nxt))

    # 3. `$20D6` generátoru sedí na začátky seznamů robotů (§9)
    gen = sorted(mem[GEN_PTRS + 2 * i] | mem[GEN_PTRS + 2 * i + 1] << 8 for i in range(30))
    robot_at = {}
    for i, room in enumerate(rooms):
        # začátek seznamu robotů: hlavička + podlahy + sloupy + vstup
        at = room['addr'] + 4 + 3 * len(room['floors']) + 1 + 3 * len(room['walls']) + 1 + 6
        robot_at[at] = i
    for p in gen:
        checks += 1
        if p not in robot_at:
            diffs += 1
            print('$20D6: $%04X není začátek seznamu robotů' % p)

    # 4. dlaždice šachty a masky devátého bitu x jsou v programu, ne v záznamu
    lift = list(mem[LIFT_TILE:LIFT_TILE + 3])
    checks += 1
    if lift != [0x49, 0x4A, 0x4B]:
        diffs += 1
        print('$0DB4: dlaždice šachty je %s' % lift)
    masks = list(mem[MSIGX_MASKS:MSIGX_MASKS + MSIGX_COUNT])
    for k, want in enumerate([0x10, 0x20, 0x40, 0x80]):
        checks += 1
        if masks[k] != want:
            diffs += 1
            print('$0E6C[%d]: $%02X != $%02X' % (k, masks[k], want))

    # 5. podklady řídicí místnosti — bajty, které `$A5C9` kopíruje
    control = {'rooms': CONTROL_ROOMS, 'routine': '$A5C9', 'parts': []}
    for name, src, length, dst, what in CONTROL_PARTS:
        control['parts'].append({'name': name, 'from': src, 'at': dst, 'what': what,
                                 'bytes': list(mem[src:src + length])})
    checks += 1
    if len(control['parts'][0]['bytes']) != 0x90:
        diffs += 1
        print('záplata sady řídicí místnosti nemá 144 B')

    # 6. všech 128 slotů `$30F3` míří na čtvrtý bajt záznamu nábytku (§9 fáze 6)
    furn_at = {f['at']: (i, f) for i, room in enumerate(rooms) for f in room['furniture']}
    for i in range(128):
        p = mem[SLOT_PTRS + 2 * i] | mem[SLOT_PTRS + 2 * i + 1] << 8
        checks += 1
        if p - 3 not in furn_at:
            diffs += 1
            print('$30F3[%d]: $%04X není slot nábytku' % (i, p))
    for at, (_, f) in furn_at.items():
        f['searchable'] = any((mem[SLOT_PTRS + 2 * i] | mem[SLOT_PTRS + 2 * i + 1] << 8) == at + 3
                              for i in range(128))
        del f['at']

    out = {
        'note': 'místnosti pevnosti z obrazu paměti originálu; formát viz '
                'sources/docs/disasm_notes.md §12 (stavitel $A39C)',
        'screen': SCREEN, 'color': COLOR, 'pointers': ROOM_PTRS,
        'tiles': {'floorLeft': 0x45, 'floorRight': 0x46, 'wallLeft': 0x47,
                  'wallRight': 0x48, 'blank': 0x53, 'lift': lift,
                  'liftAt': LIFT_TILE},
        'masks': {'at': MSIGX_MASKS, 'bytes': masks,
                  'what': 'devátý bit x sprajtu robota ($A6E4)'},
        'codeRoom': control,
        'shapes': shapes, 'rooms': rooms,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, 'w'), separators=(',', ':'))
    total_f = sum(len(r['furniture']) for r in rooms)
    print('%s: 32 místností, %d robotů, %d kusů nábytku (%d k prohledání), %d tvarů'
          % (a.out, sum(len(r['robots']) for r in rooms), total_f,
             sum(1 for r in rooms for f in r['furniture'] if f['searchable']), len(shapes)))
    print('dumprooms: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
