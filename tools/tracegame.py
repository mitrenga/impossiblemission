#!/usr/bin/env python3
"""tracegame — hraní originálu ze skriptu: vstupy podstrčené místo joysticku.

Hra čte joystick na dvou místech (`$3A3C` a `$3A7C`, obě `LDA $DC00` —
`sources/docs/disasm_notes.md` §7). Harness je přepíše na `LDA #imm` + `NOP`,
takže **přesně tři bajty**, a mezi úseky skriptu se mění jen ten immediate
bajt. Je to obdoba 6502 harnessu, který Boulder Dash sází do paměti
originálu; tady stačí dvě instrukce.

Hodnoty joysticku v portu 2 jsou **aktivní v nule**:

| bit | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| směr | nahoru | dolů | vlevo | vpravo | tlačítko |

`$7F` je klid, `$7E` nahoru, `$7D` dolů, `$7B` vlevo, `$77` vpravo,
`$6F` tlačítko; dá se i kombinovat (`$6D` = dolů + tlačítko).

    ./tools/tracegame.py --script 'idle:600,down:900,fire:60' --name lift
    ./tools/tracegame.py --script '7d:900,6f:60' --dump 4000:43e7 --name lift

Skript je posloupnost `jméno:snímky` nebo `hex:snímky`. Před ním se čeká,
až se hra rozběhne (`--start`, výchozí 14 000 snímků = zhruba výtah).
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME

READ_SITES = (0x3A3C, 0x3A7C)      # obě `LDA $DC00`
ENTROPY_SITE = 0x82E3              # `EOR $D012` v generátoru (disasm_notes §8)
NAMES = {'idle': 0x7F, 'up': 0x7E, 'down': 0x7D, 'left': 0x7B, 'right': 0x77,
         'fire': 0x6F, 'upfire': 0x6E, 'downfire': 0x6D, 'leftfire': 0x6B,
         'rightfire': 0x67}


def value_of(token):
    if token in NAMES:
        return NAMES[token]
    return int(token, 16)


def patch(e, value):
    """Obě čtení joysticku na `LDA #value` + `NOP` (tři bajty jako original)."""
    for site in READ_SITES:
        e.cmd('> %04x a9 %02x ea' % (site, value))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='idle:60',
                    help='úseky `jméno:snímky` oddělené čárkou')
    ap.add_argument('--start', type=int, default=14000, help='snímků, než skript začne')
    ap.add_argument('--name', default='game')
    ap.add_argument('--dir', default='build/trace')
    ap.add_argument('--dump', action='append', default=[], metavar='OD:DO',
                    help='rozsah paměti k uložení na konci (hex), i vícekrát')
    ap.add_argument('--cycles', type=int, default=900_000_000)
    ap.add_argument('--fast', action='store_true', help='x64 místo cyklově přesného x64sc')
    ap.add_argument('--entropy', metavar='HEX',
                    help='dosadit pevnou hodnotu místo rastru v generátoru ($82E3) — '
                         'tím je průlet opakovatelný (disasm_notes §8)')
    a = ap.parse_args()

    os.makedirs(a.dir, exist_ok=True)
    segments = []
    for part in a.script.split(','):
        token, frames = part.split(':')
        segments.append((value_of(token.strip()), int(frames)))

    e = C64Emu(a.image, fast=a.fast)
    if a.entropy is not None:
        # entropie se dosadí dřív, než se pevnost losuje: `EOR $D012` → `EOR #imm` + NOP
        e.cmd('break exec $3855')
        e.go()
        e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
        e.cmd('del 1')
    e.brk(GAME_IRQ)
    e.ignore(1, a.start*IRQ_PER_FRAME)
    e.go()                                   # rozběhnutá hra
    for value, frames in segments:
        patch(e, value)
        hits = max(1, frames*IRQ_PER_FRAME)
        e.ignore(1, hits)
        e.go()
    e.regs()
    e.cmd('bank ram')
    e.bsave('%s/%s_ram.bin' % (a.dir, a.name), 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s/%s_vic.bin' % (a.dir, a.name), 0xD000, 0xD02E)
    e.bsave('%s/%s_color.bin' % (a.dir, a.name), 0xD800, 0xDBFF)
    e.bsave('%s/%s_cia.bin' % (a.dir, a.name), 0xDC00, 0xDD0F)
    for rng in a.dump:
        lo, hi = [int(x, 16) for x in rng.split(':')]
        e.bsave('%s/%s_%04x.bin' % (a.dir, a.name, lo), lo, hi)

    r = e.run(cycles=a.cycles, screenshot='%s/%s.png' % (a.dir, a.name),
              monlog='%s/%s.log' % (a.dir, a.name), moncmds='%s/%s.cmds' % (a.dir, a.name),
              timeout=3600)
    print('%s: %d úseků, %s' % (a.name, len(segments),
                                'zastaveno' if r.hit() else 'NEZASTAVENO — víc cyklů?'))
    return 0 if r.hit() else 1


if __name__ == '__main__':
    sys.exit(main())
