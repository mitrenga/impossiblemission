#!/usr/bin/env python3
"""dumpglobal — globální tabulky a konstanty hry do data/global.json.

★ Tabulky, na kterých stojí pohyb, nejsou roztroušené: **leží za sebou**
(`sources/docs/disasm_notes.md` §17). Od `$8D05` do `$8E20` je jeden pás —
nejdřív **pět tabulek salta po dvanácti**, hned za nimi **sedm tabulek
stavu agenta po dvaceti osmi** — a `$8E21` je zase kód. Že to tak je, se
nehádá: každou tabulku má v kódu svého čtenáře.

| adresa | délka | čte | co to je |
|---|---|---|---|
| `$8D05` | 12 | `$8883` | salto: posun Y sprajtu 1 |
| `$8D11` | 12 | `$888B` | salto: posun Y sprajtu 2 |
| `$8D1D` | 12 | `$8893` | salto: posun Y sprajtu 3 |
| `$8D29` | 12 | `$88BC` | salto: posun X sprajtů 1 a 2 (vlevo se otočí znaménko) |
| `$8D35` | 12 | `$8898` | salto: posun X sprajtu 3 |
| `$8D41` | 28 | `$8739` | stav: základ ukazatele sprajtu (§13) |
| `$8D5D` | 56 | `$877E` | stav: totéž jako adresa (§13) |
| `$8D95` | 28 | `$87A5` | stav: kolik bloků se zrcadlí (§13) |
| `$8DB1` | 28 | `$8C48` | stav: horní hrana agenta (+ `$2D`, podlaha nejmíň `$33`) |
| `$8DCD` | 28 | `$8C57` | stav: dolní hrana |
| `$8DE9` | 28 | `$8C6B` | stav: levá hrana (vlevo se počítá jako `$17` − hodnota) |
| `$8E05` | 28 | `$8CA2` | stav: pravá hrana |

★ **Losuje se ukazatel, ne program.** Robot má v záznamu místnosti bajt
`druh` (§12) a ten je **rovnou ukazatel do proudu bajtů na `$2112`**
(`$A6BD` ho uloží jako čítač `$55,X`, vykonává ho `$8EFC`/`$8F02`).
Ve statickém obrazu je u všech **93 robotů nula** a skutečné ukazatele tam
zapíše **první fáze generátoru** (`$B07E`, §9) — změřeno: fáze 1 změní
v záznamech místností **92 bajtů a všechny jsou to `druh` robota**. Tím je
zodpovězená otevřená otázka §9.

★ **Sám proud `$2112`–`$232B` (538 B) je ale data programu** a generátor do
něj **nesáhne** — změřeno 2026-09-20 na 256 záznamech `tracefortressgen`:
všech 538 bajtů je před první fází i po ní stejných, a ve všech 256 semínkách
týchž. Proto se **vozí v `data/global.json`** a `player.seedMemory` ho sází do
paměti; bez něj mají všichni roboti program samých nul, jedou stejně rychle
a jen doprava — a **žádné `match*` na to nepřijde**, protože každé měřidlo
začíná z výpisu paměti originálu, kde ten proud je (stalo se 2026-09-20).
★ Totéž platí o **skriptu koule** `$2232`, který v proudu leží (§24): bez něj
se koule nehne vůbec. Začíná přesně tam, kde končí tabulka ukazatelů `$20D6`.

★ **Hodiny jdou v BCD** (`$83C2`): startují ve **12** (`$39A6`), minuta
přeteče na `$60`, hodina na `$13` zpátky na 1, a **v 6 hodin je konec**
(`$83E1` → `$43 = $FF`). Smrt stojí **10 minut** (`$96F0`), telefon
**2 minuty** (`$7D9F`, `$7DE8`) — přesně ta čísla, která má manuál.

**Rychlost chůze** je `$39` = **5 pixelů** doprava nebo **−5** doleva
(`$8808`/`$880E`) a krok se dělá jen každý **třetí** tik `$3E`
(`$3906` uloží `X = 3` do `$40`, srovnává `$86F3`). Natočení `$50` je
`$01` vpravo a `$80` vlevo — **tytéž hodnoty, jaké nese 63. bajt bloku
sprajtu** (§13).

    ./tools/dumpglobal.py                 # → data/global.json
    ./tools/dumpglobal.py --show
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# (adresa, délka, znaménko, kdo čte, co to je)
SOMERSAULT = [
    (0x8D05, 12, True, '$8883', 'posun Y sprajtu 1'),
    (0x8D11, 12, True, '$888B', 'posun Y sprajtu 2'),
    (0x8D1D, 12, True, '$8893', 'posun Y sprajtu 3'),
    (0x8D29, 12, True, '$88BC', 'posun X sprajtů 1 a 2; vlevo se otočí znaménko'),
    (0x8D35, 12, True, '$8898', 'posun X sprajtu 3; vlevo se otočí znaménko'),
]
STATE = [
    (0x8D41, 28, False, '$8739', 'základ ukazatele sprajtu (§13)'),
    (0x8D5D, 56, False, '$877E', 'totéž jako adresa (§13)'),
    (0x8D95, 28, False, '$87A5', 'kolik bloků se zrcadlí (§13)'),
    (0x8DB1, 28, True, '$8C48', 'horní hrana agenta'),
    (0x8DCD, 28, True, '$8C57', 'dolní hrana agenta'),
    (0x8DE9, 28, True, '$8C6B', 'levá hrana agenta'),
    (0x8E05, 28, True, '$8CA2', 'pravá hrana agenta'),
]
# ★ `$970E` — čím agent do místnosti přichází: tři ukazatele sprajtů na
# `$43F9` a **tři barvy** na `$D028`. Bez nich je figurka černá (§13).
AGENT_DEFAULTS = 0x9708
AGENT_DEFAULT_COUNT = 3

# ★ **Obřad umírání** (§31): dvě tabulky, které jsou taky **data programu**.
# `$9783` jsou čtyři barvy, kterými `$975B` bliká agentovi, než se rozpustí
# (dvojice `a`/`b`, sprajt 1 dostane druhou z nich), a `$97E9` je osm masek,
# z nichž každá vyhodí **jeden** bit — proto se agent rozpouští po bodech
# a ne po bajtech. Bez nich je figurka černá a zmizí za osminu času.
DEATH_FLASH, DEATH_FLASH_COUNT = 0x9783, 4
DEATH_MASKS, DEATH_MASK_COUNT = 0x97E9, 8

STATES = 28
SOMERSAULT_FRAMES = 12
AFTER_TABLES = 0x8E21             # tady už je zase kód

ROBOT_PROGRAMS = 0x2112           # proud bajtů, do kterého míří `druh` robota
ROBOT_PROGRAMS_END = 0x232C       # $232C je tabulka tvarů nábytku (§12)
GEN_PTRS, GEN_PTR_COUNT = 0x20D6, 30

# ★ konstanty ověřované **na svém místě v kódu**: (adresa operandu, hodnota, co to je)
CONSTANTS = [
    (0x39A7, 0x12, 'hodiny startují ve 12 ($39A6)'),
    (0x83C8, 0x60, 'minuta přeteče na $60 ($83C7)'),
    (0x83D5, 0x13, 'hodina přeteče na $13 ($83D4)'),
    (0x83E2, 0x06, 'v 6 hodin je konec ($83E1)'),
    (0x96F1, 0x10, 'smrt stojí 10 minut ($96F0)'),
    (0x7DA0, 0x02, 'telefon stojí 2 minuty ($7D9F)'),
    (0x7DE9, 0x02, 'telefon stojí 2 minuty, druhé místo ($7DE8)'),
    (0x8807, 0x01, 'natočení doprava ($8806)'),
    (0x880D, 0x80, 'natočení doleva ($880C)'),
    (0x8809, 0x05, 'krok doprava 5 pixelů ($8808)'),
    (0x880F, 0xFB, 'krok doleva -5 pixelů ($880E)'),
    (0xA6CE, 0x1F, 'sprajt robota: Y = řádek*8 + $1F ($A6CD)'),
    (0xA6DA, 0x02, 'sprajt robota: X = (sloupec+2)*8 ($A6D9)'),
]
# ★ dělič kroku se nedá vzít z operandu — je to `X`, které si inicializace
# vyrobí dvěma `INX`; ověřuje se proto celá ta osmice instrukcí
DIVIDER_CODE = (0x3900, bytes([0xE8, 0x86, 0x75, 0x86, 0x76, 0xE8, 0x86, 0x40]))
DIVIDER_VALUE = 3

COUNTERS = {'snoozes': 0x3439, 'liftInits': 0x3444}   # číslice v šabloně $3431 (§16)
ROBOT_MSB = 0x0E6C                                    # 4 B masek $D010 ($9069, $A6EB)


def signed(b):
    return b - 256 if b > 127 else b


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo rozbalení diskety')
    ap.add_argument('-o', default='data/global.json')
    ap.add_argument('--show', action='store_true')
    a = ap.parse_args()

    mem = open(a.mem, 'rb').read() if a.mem else build(a.disk, verbose=False)

    checks = diffs = 0

    def check(ok, what):
        nonlocal checks, diffs
        checks += 1
        if not ok:
            diffs += 1
            print('  ROZDÍL: %s' % what)

    def take(spec):
        out = []
        for at, length, signed_, reader, what in spec:
            values = list(mem[at:at + length])
            out.append({'addr': '$%04X' % at, 'length': length, 'reader': reader,
                        'what': what,
                        'values': [signed(v) for v in values] if signed_ else values})
        return out

    somersault, state = take(SOMERSAULT), take(STATE)

    # ★ Masky rozpouštění: osm bajtů, z nichž **každý má právě jeden bit
    # nulový**, a dohromady pokryjí všech osm. Je to nejlevnější důkaz, že
    # je tabulka přečtená na správné adrese — a kdyby byla prázdná (jak
    # dlouho byla v paměti remaku), vyjde z toho nula pokrytých bitů.
    masks = list(mem[DEATH_MASKS:DEATH_MASKS + DEATH_MASK_COUNT])
    check(all(bin(v ^ 0xFF).count('1') == 1 for v in masks),
          'masky $97E9 nevyhazují po jednom bitu: %s' % masks)
    check(len(set(masks)) == DEATH_MASK_COUNT, 'masky $97E9 se opakují')
    check(all(v < 0x10 for v in mem[DEATH_FLASH:DEATH_FLASH + DEATH_FLASH_COUNT]),
          'barvy blikání $9783 nejsou barvy C64')

    # --- pás tabulek musí být souvislý a končit tam, kde začíná kód ------
    at = SOMERSAULT[0][0]
    for spec, name in ((SOMERSAULT, 'salto'), (STATE, 'stav')):
        for start, length, _, _, what in spec:
            check(start == at, 'tabulka %s %s nezačíná tam, kde končí předchozí '
                               '($%04X != $%04X)' % (name, what, start, at))
            at = start + length
    check(at == AFTER_TABLES, 'pás tabulek nekončí na $%04X, ale na $%04X'
          % (AFTER_TABLES, at))

    # ★ salto se musí vrátit do stejné výšky a všechny tři sprajty ujet
    # stejně daleko — jinak by se agent po saltu propadl nebo roztrhl
    for i in range(3):
        check(sum(somersault[i]['values']) == 0,
              'salto: %s nedá dohromady nulu (%d)'
              % (somersault[i]['what'], sum(somersault[i]['values'])))
    dx12, dx3 = sum(somersault[3]['values']), sum(somersault[4]['values'])
    check(dx12 == dx3, 'salto: sprajty 1 a 2 ujedou %d, sprajt 3 %d' % (dx12, dx3))

    # --- hrany agenta musí dávat obdélník -------------------------------
    top, bottom = state[3]['values'], state[4]['values']
    left, right = state[5]['values'], state[6]['values']
    for i in range(STATES):
        check(top[i] <= bottom[i], 'stav %d má horní hranu pod dolní' % i)
        check(left[i] <= right[i], 'stav %d má levou hranu vpravo od pravé' % i)

    # --- programy robotů ------------------------------------------------
    check(GEN_PTRS + 2*GEN_PTR_COUNT == ROBOT_PROGRAMS,
          'proud programů robotů nezačíná tam, kde končí tabulka $20D6')
    spots = []
    for i in range(GEN_PTR_COUNT):
        p = mem[GEN_PTRS + 2*i] | mem[GEN_PTRS + 2*i + 1] << 8
        while mem[p] != 0xFF:
            spots.append(p)
            p += 3
    for spot in spots:
        check(mem[spot] == 0, 'robot na $%04X má ve statickém obrazu program $%02X, '
                              'a měl by mít nulu — programy se losují' % (spot, mem[spot]))

    # --- konstanty na svém místě v kódu ---------------------------------
    for at, value, what in CONSTANTS:
        check(mem[at] == value, '%s: na $%04X je $%02X, čekalo se $%02X'
              % (what, at, mem[at], value))
    check(bytes(mem[DIVIDER_CODE[0]:DIVIDER_CODE[0] + len(DIVIDER_CODE[1])]) == DIVIDER_CODE[1],
          'inicializace děliče kroku na $%04X nesedí' % DIVIDER_CODE[0])

    data = {
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': 'tabulky pohybu leží v jednom pásu $8D05-$8E20 (disasm_notes.md §17)',
        'agent': {
            'states': STATES,
            'meaning': {'walk': '$00-$0D', 'standing': '$0E', 'searching': '$0F',
                        'somersault': '$10-$1B'},
            'step': {'right': signed(mem[0x8809]), 'left': signed(mem[0x880F]),
                     'site': '$8808 / $880E'},
            'facing': {'right': '$%02X' % mem[0x8807], 'left': '$%02X' % mem[0x880D],
                       'note': 'tytéž hodnoty nese 63. bajt bloku sprajtu (§13)'},
            'frameDivider': {'value': DIVIDER_VALUE, 'zp': '$40',
                             'site': '$3906, srovnává $86F3'},
            'floorMin': '$33 ($8C4E)',
            'defaults': {'addr': '$%04X' % AGENT_DEFAULTS, 'site': '$970E',
                         'pointers': list(mem[AGENT_DEFAULTS:
                                              AGENT_DEFAULTS + AGENT_DEFAULT_COUNT]),
                         'colors': list(mem[AGENT_DEFAULTS + AGENT_DEFAULT_COUNT:
                                            AGENT_DEFAULTS + 2*AGENT_DEFAULT_COUNT]),
                         'note': '★ sprajty 1-3 na $43F9 a jejich barvy na $D028; '
                                 'pouští to inicializace $397F, ne stavitel místnosti'},
            'tables': state,
        },
        'death': {
            'flash': {'addr': '$%04X' % DEATH_FLASH, 'site': '$975B',
                      'values': list(mem[DEATH_FLASH:DEATH_FLASH + DEATH_FLASH_COUNT]),
                      'note': '★ čtyři barvy blikání agenta v obřadu ($9761, $9773); '
                              'bez nich je figurka po celý obřad černá'},
            'masks': {'addr': '$%04X' % DEATH_MASKS, 'site': '$97D7',
                      'values': list(mem[DEATH_MASKS:DEATH_MASKS + DEATH_MASK_COUNT]),
                      'note': '★ osm masek, každá vyhodí jeden bit — rozpouštění jde '
                              'po bodech; s nulami by se bajt vymazal celý'},
        },
        'somersault': {'frames': SOMERSAULT_FRAMES, 'reader': '$887F',
                       'reach': dx12, 'note': '★ součet posunů Y je nula (salto skončí '
                                              've stejné výšce) a všechny tři sprajty '
                                              'ujedou stejně daleko',
                       'tables': somersault},
        'robots': {
            'programs': {'addr': '$%04X-$%04X' % (ROBOT_PROGRAMS, ROBOT_PROGRAMS_END - 1),
                         'bytes': ROBOT_PROGRAMS_END - ROBOT_PROGRAMS,
                         'entry': 'bajt „druh" v záznamu místnosti ($A6BD → čítač $55,X)',
                         'interpreter': '$8EFC / $8F02',
                         'drawnBy': '★ losuje se **ukazatel**, ne program: první fáze '
                                    'generátoru ($B07E, §9) zapíše 92 bajtů „druh" do '
                                    'záznamů místností a do proudu samotného '
                                    '**nesáhne** — změřeno na 256 záznamech, všech 538 '
                                    'bajtů je před fází i po ní stejných a ve všech '
                                    '256 týchž. Proud je tedy data programu.',
                         'values': list(mem[ROBOT_PROGRAMS:ROBOT_PROGRAMS_END])},
            'count': len(spots),
            'spots': ['$%04X' % s for s in spots],
            'msbMasks': {'addr': '$%04X' % ROBOT_MSB, 'bytes': list(mem[ROBOT_MSB:ROBOT_MSB + 4]),
                         'reader': '$9069, $A6EB'},
            'sprite': {'y': 'řádek*8 + $1F', 'x': '(sloupec+2)*8'},
        },
        'clock': {
            'bcd': True, 'routine': '$83C2',
            'startHour': '$%02X' % mem[0x39A7], 'minuteWrap': '$%02X' % mem[0x83C8],
            'hourWrap': '$%02X' % mem[0x83D5], 'endHour': '$%02X' % mem[0x83E2],
            'deathPenalty': '$%02X' % mem[0x96F1], 'phonePenalty': '$%02X' % mem[0x7DA0],
            'endFlag': '$43 = $FF ($83E5)',
        },
        'counters': {name: '$%04X' % at for name, at in COUNTERS.items()},
        'constants': [{'addr': '$%04X' % at, 'value': '$%02X' % value, 'what': what}
                      for at, value, what in CONSTANTS],
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write('\n')

    if a.show:
        for group in (somersault, state):
            for t in group:
                print('%s %-40s %s' % (t['addr'], t['what'],
                                       ' '.join('%d' % v for v in t['values'])))

    print('%s: %d tabulek salta, %d tabulek stavu, %d robotů, %d konstant'
          % (a.o, len(somersault), len(state), len(spots), len(CONSTANTS)))
    print('dumpglobal: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
