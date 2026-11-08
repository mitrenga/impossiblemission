#!/usr/bin/env python3
"""imlib — čtení obrazů Impossible Mission (D64) a stavba obrazu paměti.

Protějšek `boulderdash/tools/bdlib.py` pro Commodore 64. Umí:

    from imlib import D64, program_image
    d = D64('sources/disk/impossible_mission_clean.d64')
    d.entries()                  # adresář: (jméno, typ, bloky, stopa, sektor)
    d.read('im.data')            # PRG i s dvěma bajty zaváděcí adresy
    mem = program_image(d)       # 64 KB paměti s nahranými soubory

D64 je 35 stop, 683 sektorů po 256 B (174 848 B), adresář na stopě 18.
Soubor je řetěz sektorů: první dva bajty každého sektoru ukazují na další
(stopa 0 = poslední, druhý bajt je pak počet platných bajtů).
"""
import sys

SECTORS_PER_TRACK = [21]*17 + [19]*7 + [18]*6 + [17]*5      # stopy 1..35
FILE_TYPES = {0: 'del', 1: 'seq', 2: 'prg', 3: 'usr', 4: 'rel'}


def track_offset(track):
    return sum(SECTORS_PER_TRACK[:track-1]) * 256


def petscii(b):
    return ''.join(chr(c) if 32 <= c < 127 else '' for c in b).strip()


class D64:
    def __init__(self, path):
        self.path = path
        self.data = open(path, 'rb').read()
        if len(self.data) not in (174848, 175531):
            raise SystemExit('%s: %d B, to není D64 (35 stop = 174 848 B)' % (path, len(self.data)))

    def sector(self, track, sec):
        off = track_offset(track) + sec*256
        return self.data[off:off+256]

    def name(self):
        s = self.sector(18, 0)
        return petscii(s[0x90:0xA0]), petscii(s[0xA2:0xA4])

    def entries(self):
        """Adresář jako seznam dictů."""
        out, track, sec, seen = [], 18, 1, set()
        while track and (track, sec) not in seen:
            seen.add((track, sec))
            s = self.sector(track, sec)
            for i in range(8):
                e = s[i*32:(i+1)*32]
                if not e[2]:
                    continue
                out.append({'name': petscii(e[5:21]), 'type': FILE_TYPES.get(e[2] & 7, '?'),
                            'closed': bool(e[2] & 0x80), 'track': e[3], 'sector': e[4],
                            'blocks': e[0x1E] | e[0x1F] << 8})
            track, sec = s[0], s[1]
        return out

    def read(self, name):
        """Obsah souboru (u PRG včetně dvou bajtů zaváděcí adresy)."""
        for e in self.entries():
            if e['name'] == name.strip():
                return self._chain(e['track'], e['sector'])
        raise KeyError('%s: v obrazu není soubor %r' % (self.path, name))

    def _chain(self, track, sec):
        out, seen = bytearray(), set()
        while track:
            if (track, sec) in seen:
                raise SystemExit('smyčka v řetězu sektorů na %d/%d' % (track, sec))
            seen.add((track, sec))
            s = self.sector(track, sec)
            nt, ns = s[0], s[1]
            out += s[2:256] if nt else s[2:2+ns-1]
            track, sec = nt, ns
        return bytes(out)


def load_address(prg):
    return prg[0] | prg[1] << 8


def program_image(d64, names=None):
    """64 KB paměti s nahranými PRG soubory; vrací (paměť, [(jméno, od, do)])."""
    mem, spans = bytearray(65536), []
    for e in d64.entries():
        if e['type'] != 'prg' or (names and e['name'] not in names):
            continue
        prg = d64.read(e['name'])
        lo = load_address(prg)
        body = prg[2:]
        mem[lo:lo+len(body)] = body
        spans.append((e['name'], lo, lo+len(body)-1))
    return bytes(mem), spans


if __name__ == '__main__':
    for path in sys.argv[1:] or ['sources/disk/impossible_mission_clean.d64']:
        d = D64(path)
        title, did = d.name()
        print('%s   "%s" %s' % (path, title, did))
        for e in d.entries():
            prg = d.read(e['name'])
            lo = load_address(prg)
            print('  %-18s %s %4d bloků  %6d B  $%04X-$%04X' %
                  (e['name'], e['type'], e['blocks'], len(prg)-2, lo, lo+len(prg)-3))
