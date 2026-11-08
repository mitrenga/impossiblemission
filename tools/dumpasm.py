#!/usr/bin/env python3
"""dumpasm — disassembly hry do sources/asm/ (`main.asm`, `hints.json`,
`coverage.txt`, `RAMUse.md`).

`svision/tools/retro/dis6502.py` je **trasující** disassembler: jde od
vstupních bodů po instrukcích a cokoli, kam nedojde, nechá bajty. Kvalita
výsledku je proto přesně tak dobrá jako **seznam vstupních bodů** — a ten
tady není hádaný. Každý z nich je odečtený z kódu a zapsaný v
`sources/docs/disasm_notes.md`; u každého je v tabulce níž číslo §, které ho
zavedlo, takže se dá dohledat, **proč** se tam skáče.

Totéž platí o **datových blocích**: vzorky řeči, bloky sprajtů, znakové
sady, tabulky pohybu, záznamy místností, proud programů robotů, karty
skládačky a okna prohledávání jsou data, a kdyby se přes ně trasovalo,
vyjdou z nich nesmysly. Jsou tedy vyjmenované taky.

    ./tools/dumpasm.py                # → sources/asm/
    ./tools/dumpasm.py --show         # a vypsat pokrytí

★ Pokrytí je **statické, ne vzorkované z běhu**: říká, kam se od známých
vstupních bodů dá dojít, ne co se v konkrétní hře provedlo. Co se doopravdy
provádí, měří `tools/scancoverage.mjs` nad záznamy — každé na svém: tohle na
programu, to druhé na instrukcích robota a stavech agenta.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# (adresa, jméno, §, co to je) — **každý vstupní bod má svůj paragraf**
ENTRIES = [
    (0x3310, 'initStatic', '§1', 'statická inicializace'),
    (0x3855, 'gameEntry', '§0', 'vstup hry'),
    (0x3914, 'initRun', '§1', 'inicializace za běhu'),
    (0x398F, 'drawMap', '§11', 'losování mapy pevnosti'),
    (0x3A15, 'shaftLoop', '§19', 'hlavní smyčka v šachtě'),
    (0x7236, 'drawFortress', '§9', 'losování pevnosti, šest fází'),
    (0x7249, 'roomLoop', '§19', 'hlavní smyčka v místnosti'),
    (0x72CE, 'buildShaftScreen', '§22', 'stavba obrazovky šachty'),
    (0x82E7, 'gameIrq', '§5', 'obsluha přerušení hry'),
    (0x8609, 'agentStep', '§19', 'krok agenta'),
    (0x855A, 'liftUp', '§20', 'krok výtahu nahoru'),
    (0x8590, 'liftDown', '§20', 'krok výtahu dolů'),
    (0x8B9E, 'enterRoom', '§21', 'přechod do místnosti'),
    (0x8C36, 'enterShaft', '§22', 'přechod do šachty'),
    (0x8ECA, 'robotStep', '§24', 'krok robotů'),
    (0x92C1, 'orbStep', '§24', 'skript koule'),
    (0x9296, 'searchProbe', '§27', 'co je pod rukou agenta'),
    (0x94FA, 'spriteCollision', '§24', 'kolize sprajtů'),
    (0x95DA, 'die', '§24', 'agent umírá'),
    (0x97F1, 'searchFurniture', '§27', 'prohledávání nábytku'),
    (0x9C3A, 'composePiece', '§15', 'skládání obrázku dílku'),
    (0x9D09, 'fullScreenTerminal', '§27', 'celoobrazovkový terminál'),
    (0xA248, 'curtainClose', '§21', 'clona se zavírá'),
    (0xA2ED, 'curtainOpen', '§21', 'clona se otevírá'),
    (0xA39C, 'buildRoom', '§12', 'stavitel místnosti'),
    # ★ §33 opravila obě jména: `$A0F5` je lift reset (§29), `$A771` kódová
    # místnost a **`$AA40` řídicí místnost** — ta, do které se vejde jen se
    # složeným heslem a ze které se jde `$AB64 JMP $B77C`, tedy na tabuli
    (0xA771, 'codeRoom', '§27', 'kódová místnost'),
    (0xAA40, 'controlRoom', '§33', 'řídicí místnost'),
    (0xAC81, 'roomLiftUnderAgent', '§23', 'výtah v místnosti'),
    (0xACEB, 'roomLiftUp', '§25', 'jízda výtahem nahoru'),
    (0xAD7A, 'roomLiftDown', '§25', 'jízda výtahem dolů'),
    (0xAE2D, 'floorCheck', '§19', 'kontrola podlahy'),
    (0xB07E, 'fortressPhase1', '§9', 'první fáze generátoru'),
    (0xB2B3, 'mapShuffle', '§11', 'míchačka mapy pevnosti'),
    # M5, konec hry (§33)
    (0x83EA, 'checkTimeUp', '§33', 'vrchol smyčky: vypršel čas?'),
    (0xB77C, 'scoreBoard', '§33', 'tabule se skóre'),
    (0xB9FB, 'scoreCount', '§33', 'skóre v BCD'),
    (0xBBF7, 'hallOfFame', '§33', 'síň slávy a zadání jména'),
    (0xBDFB, 'saveFame', '§33', 'uložení síně slávy na disketu'),
    (0xBEA5, 'readKey', '§33', 'čtení klávesnice přes CIA1'),
]

# (od, do, druh, §, co to je) — data, přes která se **netrasuje**
DATA = [
    (0x0D00, 0x0E6C, 'bytes', '§20', 'tabulky šachty'),
    (0x0E70, 0x0EB0, 'words', '§12', 'ukazatele na 32 záznamů místností'),
    (0x0EB0, 0x1D64, 'bytes', '§12', 'záznamy místností'),
    (0x208E, 0x2112, 'bytes', '§9', 'osm hesel'),
    (0x2112, 0x232C, 'bytes', '§24', 'proud programů robotů a skript koule'),
    (0x232C, 0x26E3, 'bytes', '§12', 'tvary nábytku'),
    (0x26E3, 0x2A63, 'bytes', '§15', 'karty a tvary dílků skládačky'),
    (0x3063, 0x30F3, 'bytes', '§12', 'glyfy řídicí místnosti'),
    (0x30F3, 0x3310, 'bytes', '§9', 'tabulka slotů nábytku'),
    (0x3313, 0x3633, 'bytes', '§20', 'spodní panel šachty a jeho barvy'),
    (0x3633, 0x3855, 'bytes', '§27', 'obrazovka terminálu, zabalená po délkách'),
    (0x4000, 0x4400, 'bytes', '§6', 'obrazovka hry'),
    (0x4800, 0x5000, 'bytes', '§14', 'znaková sada šachty'),
    (0x5000, 0x5800, 'bytes', '§6', 'znaková sada místnosti'),
    (0x5800, 0x6000, 'bytes', '§14', 'znaková sada kapesního počítače'),
    (0x6000, 0x7236, 'bytes', '§13', 'bloky sprajtů: agent, robot, koule'),
    (0x8D05, 0x8E21, 'bytes', '§17', 'tabulky pohybu agenta a salta'),
    (0x99ED, 0x9B28, 'bytes', '§27', 'tabulky a okna prohledávání'),
    (0xC100, 0xC500, 'bytes', '§12', 'nárazník, ve kterém se staví místnost'),
    (0xC500, 0xC600, 'bytes', '§13', 'tabulka obracení bitů'),
    (0xC9F0, 0xCF00, 'bytes', '§15', 'devět karet skládačky'),
]

# RAMUse.md: (adresa, jméno, §, co to je) — proměnné, o kterých se ví
VARS = [
    ('$01', 'banking', '§0', 'paměťová konfigurace; hra si odpojuje KERNAL kvůli řeči'),
    ('$10/$11', 'kreslicí poloha', '§25, §27', 'kam se zrovna kreslí na obrazovku'),
    ('$14/$15', 'barevná poloha', '§25, §27', 'totéž v barevné paměti'),
    ('$18/$19', 'pomocný ukazatel', '§27', 'stavitel, prohledávání, mazání nábytku'),
    ('$1A', 'místo', '§19', '0 šachta, 1 místnost, 2 místnost se staví'),
    ('$1B/$1C', 'lano a podřádek', '§20', 'fáze lana výtahu a podřádek kroku'),
    ('$1D/$1E', 'konce šachty', '§20', 'výtah je nahoře / dole'),
    ('$1F/$20', 'fáze dveří', '§20', 'vpravo a vlevo, $00-$15 nebo $FF'),
    ('$2B', 'čtverec v mřížce', '§11', 'kde je agent na mapě pevnosti'),
    ('$2C-$32', 'sprajty agenta', '§19', 'tři dvojice x/y a devátý bit'),
    ('$33-$38', 'nové hrany', '§19', 'hrany a středy při řešení pohybu'),
    ('$39', 'rychlost', '§19', '±5 pixelů na krok'),
    ('$3A-$3D', 'staré hrany', '§19', 'levá/2, pravá/2, dolní, horní'),
    ('$3E/$40', 'tik a dělič', '§19', 'krok se dělá každý třetí průchod'),
    ('$3F', 'stav agenta', '§17', '$00-$0D chůze, $0E stání, $0F prohledávání, $10-$1B salto'),
    ('$41/$42', 'pád', '§19', 'rychlost pádu a dosednutí'),
    ('$43', 'smrt', '§19', '1 robot, 2 pád, 3 výtah, $FF vypršel čas'),
    ('$44', 'tik robotů', '§24', ''),
    ('$47', 'snooze', '§26', 'roboti spí, dokud tam není $FF'),
    ('$4E/$4F', 'zvuk', '§24', 'hlasy SID, které si robot bere'),
    ('$50/$51', 'natočení a salto', '§17', '$01 vpravo, $80 vlevo'),
    ('$52/$53', 'pod agentem', '§23', 'řádek a sloupec, počítá `$AC81`'),
    ('$54-$6C', 'roboti', '§24', 'šest bajtů na robota od `$55`'),
    ('$6D-$71', 'koule', '§24', 'jestli je, kde je ve skriptu, kolik zbývá, čekání, hrana'),
    ('$79-$7D', 'scratch kolize', '§19', 'devátý bit a ukazatel na buňku'),
    ('$7E/$7F', 'místnost a strana', '§12', 'číslo místnosti a odkud agent přišel'),
    ('$81/$82', 'záznam místnosti', '§12', 'ukazatel do záznamu, který stavitel nechal'),
    ('$83/$85', 'západky', '§25, §27', 'nahoru a dolů; `$85` je i nesmrtelnost při jízdě dolů'),
    ('$84', 'barva dlaždice', '§25', 'barva plošin výtahu v místnosti'),
    ('$86-$88', 'nábytek', '§27', 'offset a ukazatel do seznamu nábytku v záznamu'),
    ('$8A', 'volba terminálu', '§27', 'kurzor v menu celoobrazovkového terminálu'),
    ('$8B/$8C', 'rastry clony', '§21', 'horní a dolní okraj černého pásu'),
    ('$8D', 'pozadí místnosti', '§21', 'první bajt záznamu; do `$D021` ho dá clona'),
    ('$8E', 'které sprajty svítí', '§13', 'poslední bajt záznamu, do `$D015` ho dá `$A35E`'),
    ('$C1', 'zvonek', '§19', 'kolikrát odbila hodina'),
    ('$D1-$D5', 'hodiny', '§19', 'snímky, vteřiny, minuty, hodiny (BCD), stopka'),
    ('$D6/$D7', 'nálezy', '§27', 'kolik dílků a kolik terminálů agent prošel'),
    ('$D8', 'složené skládačky', '§33', 'pět set bodů za každou (`$BBB4`)'),
    ('$D9-$DB', 'skóre', '§33', 'tři bajty BCD, `$D9` nejnižší; `$BB48` přičítá do stovek'),
    ('$DC', 'lift resety', '§27', 'kolikrát se použil'),
    ('$DE', 'západka střelby', '§19', 'jedno zmáčknutí je jedno salto'),
    ('$E0', 'čítač snímků', '§19', 'zvedá ho obsluha přerušení, čeká na něj `$7F6B`'),
    ('$E4-$EA', 'scratch', '§25, §27', 'počty a offsety, na kterých stojí kreslení'),
    ('$EB/$EC', 'míchačka', '§8', 'stav generátoru náhody; vstup je `$D012`'),
    ('$4000-$43E7', 'obrazovka', '§6', 'to, co VIC ukazuje'),
    ('$43F8-$43FF', 'ukazatele sprajtů', '§13', 'osm bajtů na konci obrazovky'),
    ('$4EF5-$4F34', 'nalezené dílky', '§27', 'seznam zakončený $FF a barvy pozadí'),
    ('$4F55+', 'záznamy nábytku', '§27', 'šest bajtů na kus, staví je stavitel místnosti'),
    ('$C100-$C4FF', 'nárazník', '§12, §27', 'místnost se v něm staví; okno si tam schová pozadí'),
    ('$CF00-$CF77', 'síň slávy', '§33', 'patnáct položek po osmi bajtech; `$CF78` je koš'),
    ('$CF80-$CFEA', 'odkládací pásmo', '§33', 'zp `$90`-`$FA` kolem KERNALu (`$BDFB`)'),
    ('$FF30-$FF95', 'stopa kabiny', '§20', 'kudy výtah jel po mapě pevnosti'),
    ('$FF96+', 'mřížka pevnosti', '§11', '9 × 6 čtverců'),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo diskety')
    ap.add_argument('-o', default='sources/asm')
    ap.add_argument('--lo', default='0880')
    ap.add_argument('--hi', default='CFFF')
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)
    os.makedirs(a.o, exist_ok=True)

    hints = {
        'note': ('vstupní body a datové bloky Impossible Mission; u každého je '
                 'paragraf sources/docs/disasm_notes.md, který ho zavedl'),
        'entries': ['%04X' % at for at, _, _, _ in ENTRIES],
        'labels': {'%04X' % at: name for at, name, _, _ in ENTRIES},
        'data': [['%04X' % lo, '%04X' % hi, kind] for lo, hi, kind, _, _ in DATA],
        'why': {'%04X' % at: '%s %s' % (par, what) for at, _, par, what in ENTRIES},
        'dataWhy': {'%04X' % lo: '%s %s' % (par, what) for lo, _, _, par, what in DATA},
    }
    with open(os.path.join(a.o, 'hints.json'), 'w') as f:
        json.dump(hints, f, indent=1)
        f.write('\n')

    import dis6502
    dis6502.SYMS = dis6502.MACHINES['c64']
    d = dis6502.Dis(mem, int(a.lo, 16), int(a.hi, 16), hints)
    for at, _, _, _ in ENTRIES:
        d.ref(at, -1)
        d.trace(at)
    with open(os.path.join(a.o, 'main.asm'), 'w') as f:
        d.output(f, 'Impossible Mission (Epyx 1984), $%s-$%s' % (a.lo, a.hi))
    code, data, unk = d.coverage()
    total = int(a.hi, 16) - int(a.lo, 16)

    with open(os.path.join(a.o, 'coverage.txt'), 'w') as f:
        f.write('# pokrytí disassembly, %d vstupních bodů, %d datových bloků\n'
                % (len(ENTRIES), len(DATA)))
        f.write('# ★ je to **statické** pokrytí: kam se od známých vstupních bodů\n'
                '# dá dojít, ne co se v konkrétní hře provedlo. Druhé měří\n'
                '# tools/scancoverage.mjs nad záznamy.\n')
        f.write('kód        %6d B  %5.1f %%\n' % (code, 100.0*code/total))
        f.write('data       %6d B  %5.1f %%\n' % (data, 100.0*data/total))
        f.write('nezařazeno %6d B  %5.1f %%\n' % (unk, 100.0*unk/total))
        f.write('nevyřešeno %6d skoků\n\n' % len(d.unresolved))
        for at, name, par, what in ENTRIES:
            f.write('$%04X  %-22s %-6s %s\n' % (at, name, par, what))
        f.write('\n')
        for lo, hi, kind, par, what in DATA:
            f.write('$%04X-$%04X  %-6s %-6s %s\n' % (lo, hi - 1, kind, par, what))

    with open(os.path.join(a.o, 'RAMUse.md'), 'w') as f:
        f.write('# RAMUse — co kde v paměti je\n\n')
        f.write('Vzniká `tools/dumpasm.py`. ★ Není to odhad: u každé položky je\n'
                'paragraf `sources/docs/disasm_notes.md`, ve kterém se na ni\n'
                'přišlo, a většina z nich je zároveň srovnávaná některým\n'
                '`match*` (`MILNIKY.md`).\n\n')
        f.write('| adresa | co to je | § | poznámka |\n|---|---|---|---|\n')
        for at, name, par, what in VARS:
            f.write('| `%s` | %s | %s | %s |\n' % (at, name, par, what))
        f.write('\n## Datové bloky\n\n| adresa | co to je | § |\n|---|---|---|\n')
        for lo, hi, _, par, what in DATA:
            f.write('| `$%04X`–`$%04X` | %s | %s |\n' % (lo, hi - 1, what, par))

    print('%s: main.asm, hints.json, coverage.txt, RAMUse.md' % a.o)
    print('dumpasm: kód %d B (%.1f %%), data %d B, nezařazeno %d B; '
          'nevyřešeno %d skoků' % (code, 100.0*code/total, data, unk, len(d.unresolved)))
    if a.show:
        for at, why in d.unresolved[:20]:
            print('  $%04X: %s' % (at, why))
    return 0


if __name__ == '__main__':
    sys.exit(main())
