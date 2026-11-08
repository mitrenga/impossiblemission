#!/usr/bin/env python3
"""matchimage — obraz postavený z diskety proti paměti běžícího originálu.

Akceptační měřidlo M0 (`../METHODOLOGY.md`): z média se **kódem zavaděče
originálu** (`tools/unpack.py`, rozebraný v `sources/docs/disasm_notes.md`
§4) postaví obraz paměti a porovná se s dumpem z emulátoru
(`tools/c64emu.py`) **bajt po bajtu**. Co se liší, musí být vyjmenované
a vysvětlené — jinak program není doložený.

    ./tools/matchimage.py                     # všechny rozsahy, výchozí dumpy
    ./tools/matchimage.py --verbose           # vypsat i neshodné úseky
    ./tools/matchimage.py --naive             # srovnání proti naivnímu nahrání

Vysvětlené rozdíly (`EXPLAINED`) se počítají zvlášť; nula **nevysvětlených**
rozdílů je to, co milník požaduje.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imlib import D64, program_image
from unpack import build

# dump z emulátoru → rozsah v paměti
RANGES = [('build/run/mem_full.bin', 0x0880, 0xCFFF, 'program a data po rozbalení'),
          ('build/run/mem_words.bin', 0xE000, 0xF77F, 'řeč (IM.WORDS) pod ROM KERNALu')]

# rozdíly, které jsou vysvětlené — (od, do, proč)
EXPLAINED = [
    (0x3855, 0x3865, 'vstupní rutina hry: nastaví $DD03 a vektor NMI na $3854 '
                     'a pak se sama vynuluje (v paměti jsou tu nuly)'),
    (0xCF00, 0xCFE7, 'živý stav hry: $CF00-$CF7F je oblast, kterou crack Bytebreaker '
                     'ukládá jako samostatný soubor HI (nejvyšší skóre), zbytek jsou '
                     'proměnné, které do prvního přerušení už běží'),
]


def explained(addr):
    return next((e for e in EXPLAINED if e[0] <= addr <= e[1]), None)


def runs_of(addrs):
    out = []
    if not addrs:
        return out
    s = p = addrs[0]
    for a in addrs[1:]:
        if a == p + 1:
            p = a
        else:
            out.append((s, p)); s = p = a
    out.append((s, p))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--naive', action='store_true',
                    help='proti naivnímu nahrání souborů (ukáže, proč zavaděč nejde obejít)')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    if a.naive:
        mem, spans = program_image(D64(a.disk))
        print('obraz: naivní nahrání souborů z %s' % a.disk)
    else:
        mem = build(a.disk, verbose=False)
        print('obraz: %s → tools/unpack.py (zavaděč originálu)' % a.disk)

    checks = diffs = unexplained = 0
    bad_runs = []
    for path, lo, hi, what in RANGES:
        if not os.path.exists(path):
            print('  CHYBÍ %s — dump z emulátoru (tools/c64emu.py)' % path)
            continue
        run = open(path, 'rb').read()
        if len(run) != hi - lo + 1:
            sys.exit('%s má %d B, rozsah $%04X-$%04X chce %d B' % (path, len(run), lo, hi, hi - lo + 1))
        bad = [lo + i for i in range(len(run)) if mem[lo + i] != run[i]]
        checks += len(run)
        diffs += len(bad)
        unexplained += sum(1 for x in bad if not explained(x))
        for s, e in runs_of(bad):
            bad_runs.append((s, e, explained(s)))
        print('  $%04X-$%04X  %6d B  %-34s  rozdílů %d' % (lo, hi, len(run), what, len(bad)))

    print('\nkontrol: %d   rozdílů: %d   **nevysvětlených: %d**' % (checks, diffs, unexplained))
    if bad_runs and (a.verbose or unexplained):
        print('\nneshodné úseky:')
        for s, e, why in bad_runs:
            tag = ('vysvětleno: ' + why[2]) if why else '*** NEVYSVĚTLENO ***'
            print('  $%04X-$%04X (%4d B)  %s' % (s, e, e - s + 1, tag))
    return 1 if unexplained else 0


if __name__ == '__main__':
    sys.exit(main())
