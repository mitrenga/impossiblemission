#!/usr/bin/env python3
"""tracefortressgen — losování pevnosti z běžícího originálu, fáze po fázi.

★ Generátor pevnosti je `$7236` (volá ho `$39D7` při rozběhu hry) a je to
**šest podrutin za sebou** (`disasm_notes.md` §9):

    7236  JSR $B07E   7239  JSR $B03B   723C  JSR $B0C3
    723F  JSR $B0E9   7242  JSR $B176   7245  JSR $B263   7248  RTS

Nástroj zastaví na `$7236` a pak postupně na `$7239`…`$7248`, po každém
zastavení uloží **celou RAM**, a z rozdílů se pozná, co která fáze zapsala.
Entropie (`EOR $D012` na `$82E3`) se přebije pevnou hodnotou, takže je běh
opakovatelný — to je celá podmínka toho, aby `matchfortressgen` měl o co
opřít otisk (`disasm_notes.md` §8).

    ./tools/tracefortressgen.py --entropy 42                 # jedno semínko, fáze
    ./tools/tracefortressgen.py --seeds 00-ff --out build/fortress/seeds.json

Pozor: `$82E3` není semínko generátoru, je to **vstup entropie**. Stav
PRNG je `$EB`/`$EC`; s konstantním vstupem je posloupnost dál určená tím,
kolikrát se rutina zavolala.
"""
import argparse, json, os, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu

# Dvě losování, obě před první obrazovkou hry a obě ze stejné míchačky:
# mapa pevnosti (`$398F`, rozvržení místností do mřížky 9x6 a její obrázek
# pro kapesní počítač) a pak vlastní pevnost (`$7236`, šest fází).
GENERATORS = {
    'fortress': {'entry': 0x7236,
                 'stops': (0x7236, 0x7239, 0x723C, 0x723F, 0x7242, 0x7245, 0x7248),
                 'phases': ('B07E', 'B03B', 'B0C3', 'B0E9', 'B176', 'B263')},
    'map': {'entry': 0x398F, 'stops': (0x398F, 0x3992), 'phases': ('B2B3',)},
}
GEN_ENTRY = GENERATORS['fortress']['entry']
GEN_STOPS = GENERATORS['fortress']['stops']
GEN_PHASES = GENERATORS['fortress']['phases']
ENTROPY_SITE = 0x82E3
GAME_ENTRY = 0x3855


def run_phases(image, entropy, outdir, name, cycles, timeout, fast=False,
               stops=GEN_STOPS):
    """Uloží RAM při každé zastávce generátoru; vrátí seznam cest."""
    os.makedirs(outdir, exist_ok=True)
    e = C64Emu(image, fast=fast)
    e.cmd('break exec $%04x' % GAME_ENTRY)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, entropy))
    e.cmd('del 1')
    paths = []
    for i, stop in enumerate(stops):
        e.cmd('break exec $%04x' % stop)
        e.go()
        e.cmd('bank ram')
        p = '%s/%s_p%d.bin' % (outdir, name, i)
        e.bsave(p, 0x0000, 0xFFFF)
        e.cmd('del %d' % (i + 2))
        paths.append(p)
    e.regs()
    r = e.run(cycles=cycles, monlog='%s/%s.log' % (outdir, name),
              moncmds='%s/%s.cmds' % (outdir, name), timeout=timeout)
    return paths, r


def ranges(diff, gap=16):
    """Souvislé úseky adres (s mezerou do `gap` bajtů slepenou dohromady)."""
    out = []
    for a in diff:
        if out and a - out[-1][1] <= gap:
            out[-1][1] = a
        else:
            out.append([a, a])
    return out


def parse_seeds(spec):
    """`00-1f`, `00,05,42` nebo kombinace; vrací seznam bajtů."""
    out = []
    for part in spec.split(','):
        part = part.strip()
        if '-' in part:
            lo, hi = [int(x, 16) for x in part.split('-')]
            out += list(range(lo, hi + 1))
        else:
            out.append(int(part, 16))
    return out


def sweep(a, seeds):
    """Každé semínko = vlastní běh emulátoru; běží jich `--jobs` naráz."""
    gen = GENERATORS[a.gen]

    def one(seed):
        name = '%s%02x' % (a.name, seed)
        paths, r = run_phases(a.image, seed, a.dir, name, a.cycles, a.timeout, a.fast,
                              stops=gen['stops'])
        ok = all(os.path.exists(x) for x in paths)
        print('  $%02X %s' % (seed, 'ok' if ok else 'NEDOBĚHLO'), flush=True)
        return seed, ok, paths

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, seeds))

    index = {'entropy_site': '%04X' % ENTROPY_SITE, 'generator': '%04X' % gen['entry'],
             'stops': ['%04X' % x for x in gen['stops']], 'phases': list(gen['phases']),
             'seeds': []}
    for seed, ok, paths in res:
        if not ok:
            continue
        before, after = open(paths[0], 'rb').read(), open(paths[-1], 'rb').read()
        diff = [x for x in range(0x10000) if before[x] != after[x]]
        index['seeds'].append({
            'entropy': '%02X' % seed,
            'before': os.path.relpath(paths[0]), 'after': os.path.relpath(paths[-1]),
            'phase_dumps': [os.path.relpath(x) for x in paths],
            'changed': len(diff),
            # stav míchačky při vstupu do generátoru — bez něj se běh nedá zopakovat
            'prng': {'EB': '%02X' % before[0xEB], 'EC': '%02X' % before[0xEC]},
        })
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(index, open(a.out, 'w'), indent=1)
    print('%d/%d semínek, index %s' % (len(index['seeds']), len(seeds), a.out))
    return 0 if len(index['seeds']) == len(seeds) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--name', default='gen')
    ap.add_argument('--dir', default='build/fortress')
    ap.add_argument('--cycles', type=int, default=900_000_000)
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--seeds', metavar='SPEC',
                    help='dávka hodnot entropie, `00-1f` nebo `00,05,42`')
    ap.add_argument('--jobs', type=int, default=4, help='kolik emulátorů naráz')
    ap.add_argument('--gen', choices=sorted(GENERATORS), default='fortress',
                    help='které losování: `fortress` ($7236) nebo `map` ($398F)')
    ap.add_argument('--out', default='build/fortress/seeds.json')
    a = ap.parse_args()

    if a.seeds:
        seeds = parse_seeds(a.seeds)
        print('losování pevnosti pro %d hodnot entropie, %d naráz:' % (len(seeds), a.jobs))
        return sweep(a, seeds)

    gen = GENERATORS[a.gen]
    paths, r = run_phases(a.image, int(a.entropy, 16), a.dir, a.name, a.cycles,
                          a.timeout, a.fast, stops=gen['stops'])
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        print('nedoběhlo: chybí %d dumpů (%s)' % (len(missing), missing[0]), file=sys.stderr)
        print(r.log[-800:], file=sys.stderr)
        return 1
    mems = [open(p, 'rb').read() for p in paths]
    print('losování `%s`, entropie $%s — co která fáze zapsala:' % (a.gen, a.entropy))
    total = set()
    for i, sub in enumerate(gen['phases']):
        before, after = mems[i], mems[i + 1]
        diff = [x for x in range(0x10000) if before[x] != after[x]]
        total.update(diff)
        rs = ranges(diff)
        print('  %d. JSR $%s — %5d bajtů v %d úsecích: %s'
              % (i + 1, sub, len(diff), len(rs),
                 ', '.join('$%04X-$%04X' % (lo, hi) for lo, hi in rs[:8])
                 + (' …' if len(rs) > 8 else '')))
    print('  celkem %d bajtů v %d úsecích' % (len(total), len(ranges(sorted(total)))))
    for lo, hi in ranges(sorted(total)):
        print('    $%04X-$%04X  (%d B)' % (lo, hi, hi - lo + 1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
