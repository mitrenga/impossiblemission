#!/usr/bin/env python3
"""tracesound — co originál napíše do SID: vzorky řeči a zápisy do registrů.

M6 měří **zvuk po zápisech**.

`--speech` — **řeč** (`sources/docs/disasm_notes.md` §18, §32). Ovladač
`$0880` sype vzorky z **NMI časovače B CIA2**, tedy po **101 cyklech**, a do
`$D418` je dává na čtyřech místech: `$0888` a `$08A9` (rámec dopředu
a pozpátku), `$08C8` (ticho náběhu) a `$08E9` (poslední `$07` na konci).
★ Páté místo **nic nepíše** — fáze `$08D9` jen počítá a hladina drží; bez ní
by se posloupnost vzorků nedala porovnat, takže se sleduje taky.

★ **A měřit se to nesmí záplatou.** První pokus přepsal těch pět míst na
`JSR` na stub, který vzorek uložil do paměti — a záznam vyšel o šest vzorků
delší než přepis. Důvod: **NMI se na 6502 nemaskuje**, takže když doplnění
(`$08F2` a rozbalovač) trvá déle než 101 cyklů, **NMI se zanoří** a zahraje
vzorek doprostřed rozbalování. Kde přesně, to závisí na cyklech — a stub
jich přidával 28, tedy měnil právě to, co měl změřit. (Druhý běh s `--pad 4`
dal 2 088 vzorků místo 2 089: důkaz, že jde o cykly.) Nástroj proto vzorky
**nesbírá v paměti stroje, ale checkpointy monitoru**: `break` + `command
"g"` emulaci zastaví a pustí dál, aniž by ji o jediný cyklus prodloužil,
a v logu je u každého zásahu adresa, `A`, `SP` **a počitadlo cyklů**.

    ./tools/tracesound.py --speech                 # → build/sound/word*.json.gz
    ./tools/tracesound.py --speech --words 6       # jen jedna věta

Měří to `tools/matchsound.mjs` proti `app/speech.js`.
"""
import argparse, gzip, json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME
from tracerooms import BUILD_CALL, ENTROPY_SITE, DELAY, JOY_SITES, RIGHT

GAME_ENTRY = 0x3855
WORDS = 8
PORT_VALUE = 0x25            # `$3914` — hra jede s odpojeným KERNALem ($E000 je RAM)

# ★ pět míst, kde se rozhoduje o vzorku; u prvních čtyř je v `A` to, co půjde
# do `$D418`, u pátého se nepíše nic a hladina drží
SITES = ((0x0888, 'A'),      # `$0883` — rámec dopředu
         (0x08A9, 'B'),      # `$08A4` — rámec pozpátku
         (0x08C8, 'C'),      # `$08C3` — ticho náběhu, `$07`
         (0x08D9, 'D'),      # `$08D9` — **nepíše nic**
         (0x08E9, 'E'))      # `$08E1` — poslední `$07`, časovač stojí
HOLD_MARK = 0x80             # ★ vzorek je vždycky pod $80 (hlídá matchsound)

LOADER = 0x0300              # vlastní zavaděč věty
LOADER_INDEX = LOADER + 0x11
LOADER_DONE = LOADER + 0x1D
# $0300: SEI ; LDA #$25 ; STA $01 ; LDA #$08 ; STA $D404/$D40B/$D412
#        LDA #index ; JSR $0880          — pusť větu
# $0315: LDA #$FF ; JSR $0880 ; LSR A ; BCS $0315    — počkej, až doběhne
# $031D: JMP $031D                       — a stůj
LOADER_CODE = (0x78, 0xA9, PORT_VALUE, 0x85, 0x01,
               0xA9, 0x08, 0x8D, 0x04, 0xD4, 0x8D, 0x0B, 0xD4, 0x8D, 0x12, 0xD4,
               0xA9, 0x00, 0x20, 0x80, 0x08,
               0xA9, 0xFF, 0x20, 0x80, 0x08, 0x4A, 0xB0, 0xF8,
               0x4C, 0x1D, 0x03)

# `.C:0888  8D 18 D4    STA $D418  - A:07 X:40 Y:00 SP:f8 ..-..I.C  421278116`
# ★ monitor tiskne adresu a `SP` malými písmeny, ale `A`, `X` a `Y` **velkými**
HIT = re.compile(r'^\.C:([0-9a-fA-F]{4})\s+.*?-\s+A:([0-9a-fA-F]{2})\s+X:([0-9a-fA-F]{2})'
                 r'\s+Y:([0-9a-fA-F]{2})\s+SP:([0-9a-fA-F]{2}).*?(\d+)\s*$')


def poke(e, addr, code):
    e.cmd('> %04x %s' % (addr, ' '.join('%02x' % b for b in code)))


def rest(e, entropy, start):
    """Dojede do hry a zastaví stroj tam, kde nic nehýbe pamětí."""
    e.cmd('break exec $%04x' % GAME_ENTRY)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, entropy))
    e.cmd('del 1')
    e.brk(GAME_IRQ)                                  # #1
    e.ignore(1, start * IRQ_PER_FRAME)
    e.go()
    e.cmd('disable 1')
    for site in JOY_SITES:
        e.cmd('> %04x a9 %02x ea' % (site, RIGHT))
    e.brk(BUILD_CALL)                                # #2
    e.go()
    e.cmd('disable 2')
    e.cmd('> %04x 60' % DELAY)
    e.cmd('bank io')
    e.cmd('> d01a 00')
    e.cmd('> d019 ff')
    e.cmd('> dc0d 7f')
    e.cmd('bank ram')


def parse(path, words):
    """Log monitoru → posloupnost vzorků každé věty.

    Zásahy jdou v pořadí, v jakém se staly; věty od sebe dělí zásah na
    `$031D` (konec zavaděče).
    """
    runs, current = [], []
    for line in open(path, encoding='utf-8', errors='replace'):
        m = HIT.match(line.strip())
        if not m:
            continue
        pc = int(m.group(1), 16)
        if pc == LOADER_DONE:
            runs.append(current)
            current = []
            continue
        for site, tag in SITES:
            if pc == site:
                current.append((tag, int(m.group(2), 16), int(m.group(5), 16),
                                int(m.group(6))))
                break
    if current:
        runs.append(current)
    return dict(zip(words, runs))


def speech(a):
    """Osm vět jedním během: vzorek po vzorku, bez jediného cyklu navíc."""
    os.makedirs(a.dir, exist_ok=True)
    words = [int(w) for w in a.words.split(',')] if a.words else list(range(WORDS))
    e = C64Emu(a.image, fast=a.fast)
    rest(e, int(a.entropy, 16), a.start)
    poke(e, LOADER, LOADER_CODE)
    num = 3
    for site, _tag in SITES:                         # #3..#7 — jen vypsat a jet dál
        e.brk(site)
        e.on_break(num, 'g')
        num += 1
    e.brk(LOADER_DONE)                               # #8 — konec věty
    for word in words:
        poke(e, LOADER_INDEX, (word,))
        e.cmd('r pc=%04x' % LOADER)
        e.go()
    log = '%s/speech.log' % a.dir
    if not a.reparse:
        e.run(cycles=900_000_000, monlog=log, moncmds='%s/speech.cmds' % a.dir,
              timeout=a.timeout)

    runs = parse(log, words)
    missing = [w for w in words if not runs.get(w)]
    for word in words:
        hits = runs.get(word)
        if not hits:
            continue
        samples = [HOLD_MARK if tag == 'D' else value for tag, value, _sp, _c in hits]
        out = {'source': 'originál pod x64sc, tools/tracesound.py --speech',
               'word': word, 'cyclesPerSample': 101, 'holdMark': HOLD_MARK,
               'note': 'vzorek po vzorku, jak ho ovladač $0880 dává do $D418; '
                       '$80 = fáze $08D9, která nepíše a hladina drží',
               'phases': ''.join(tag for tag, _v, _s, _c in hits),
               'samples': samples,
               'stack': [sp for _t, _v, sp, _c in hits],
               'cycles': [c for _t, _v, _s, c in hits]}
        with gzip.open('%s/word%d.json.gz' % (a.dir, word), 'wt') as f:
            json.dump(out, f)
        nested = sum(1 for _t, _v, sp, _c in hits if sp < hits[0][2])
        print('  věta %d: %d vzorků (%.2f s), zanořených NMI %d'
              % (word, len(samples), len(samples)*101/985248.0, nested))
    print('tracesound: %d vět do %s, %s' % (len(words), a.dir,
          'hotovo' if not missing else 'CHYBÍ %s — koukni do speech.log' % missing))
    return 1 if missing else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--dir', default='build/sound')
    ap.add_argument('--speech', action='store_true', help='záznam vzorků řeči')
    ap.add_argument('--words', default='', help='které věty, po čárkách (výchozí všech osm)')
    ap.add_argument('--start', type=int, default=14000, help='snímků, než se hra rozjede')
    ap.add_argument('--reparse', action='store_true',
                    help='jen znovu přečíst hotový speech.log, bez emulátoru')
    ap.add_argument('--timeout', type=int, default=7200)
    ap.add_argument('--fast', action='store_true')
    a = ap.parse_args()
    if a.speech:
        return speech(a)
    ap.error('zatím umí jen --speech')


if __name__ == '__main__':
    sys.exit(main())
