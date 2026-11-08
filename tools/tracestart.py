#!/usr/bin/env python3
"""tracestart — rozběh hry v šachtě, zastávka po zastávce.

★ **Rozběh je jediná část přepisu, na kterou žádné `match*` nedosáhne**:
každý záznam začíná z výpisu paměti, ve kterém hra dávno běží
(`sources/docs/disasm_notes.md` §22). A právě v něm se schovaly dvě vady,
které nahlásil operátor 2026-09-21 — mapa pevnosti kreslená plnými čtverci
a panel, který se objevil dřív, než domluvila úvodní řeč.

Nástroj proto zastaví originál na pěti místech mezi `$39F1` a `$3A15`
a z každého vypíše paměť, barvy a VIC:

| zastávka | co už proběhlo |
|---|---|
| `$39F1` | ★ nic z toho, co následuje — obrazovka je hotová šachta, řádky 0-14 |
| `$39F4` | `$731C`: **šachta pod oknem**, řádky 15-24, a obraz se rozsvítil |
| `$3A0B` | `$72E5`: **spodní panel** (tohle už je za oběma větami) |
| `$B644` | `$7218` dvakrát a obě čekání na snímek uvnitř `$B63B` |
| `$3A15` | `$B63B` celé: okno sady, mapa a značka kabiny |

★ Mezi `$B644` a `$3A15` **není čekání na snímek**, takže se ty dvě
zastávky dají srovnat bez ohledu na obsluhu přerušení; mezi `$39F1`
a `$39F4` je jedno (`$73B7`), ale to jen zvedne čítače.

Entropie je pevná (`$82E3`, §8), jako u všech ostatních záznamů.

    ./tools/tracestart.py --entropy 42        # → build/start/
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu

GAME_ENTRY = 0x3855
ENTROPY_SITE = 0x82E3

# (jméno, adresa, co už proběhlo)
STOPS = (
    ('pre', 0x39F1, 'hotová šachta, řádky 0-14'),
    ('bottom', 0x39F4, '$731C — šachta pod oknem a rozsvícený obraz'),
    ('panel', 0x3A0B, '$72E5 — spodní panel, už za řečí'),
    ('window', 0xB644, '$7218 a obě čekání uvnitř $B63B'),
    ('map', 0x3A15, '$B63B celé — okno sady, mapa a značka kabiny'),
)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--entropy', default='42')
    ap.add_argument('--dir', default='build/start')
    ap.add_argument('--timeout', type=int, default=900)
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)

    e = C64Emu(a.image, fast=True)
    e.cmd('break exec $%04x' % GAME_ENTRY)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
    e.cmd('del 1')
    # ★ Zastávky se berou **po pořadí**, jedna po druhé: `$B644` leží uvnitř
    # `$B63B`, takže by jako trvalý checkpoint padla i při otevření mapy
    # v kapesním počítači, kdyby záznam běžel dál.
    for name, addr, _what in STOPS:
        e.cmd('break exec $%04x' % addr)
        e.go()
        e.cmd('del 1')
        base = os.path.join(a.dir, name)
        e.cmd('bank ram')
        e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
        e.cmd('bank io')
        e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
        e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
        e.cmd('bank ram')
    r = e.run(cycles=400_000_000, monlog=os.path.join(a.dir, 'start.log'),
              moncmds=os.path.join(a.dir, 'start.cmds'), timeout=a.timeout)
    if not r.hit():
        raise SystemExit('záznam nedoběhl — monitor v %s/start.log' % a.dir)

    index = {
        'name': 'start', 'entropy': '%02X' % int(a.entropy, 16), 'image': a.image,
        'stops': [{'name': n, 'at': '$%04X' % addr, 'what': w,
                   'ram': os.path.relpath(os.path.join(a.dir, '%s_ram.bin' % n)),
                   'color': os.path.relpath(os.path.join(a.dir, '%s_color.bin' % n)),
                   'vic': os.path.relpath(os.path.join(a.dir, '%s_vic.bin' % n))}
                  for n, addr, w in STOPS]
    }
    out = os.path.join(a.dir, 'start.json')
    json.dump(index, open(out, 'w'), indent=1, ensure_ascii=False)
    missing = [s['name'] for s in index['stops'] if not os.path.exists(s['ram'])]
    if missing:
        raise SystemExit('chybí výpis zastávek: %s' % ', '.join(missing))
    print('tracestart: %d zastávek → %s' % (len(STOPS), out))


if __name__ == '__main__':
    main()
