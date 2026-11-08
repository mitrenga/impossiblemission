#!/usr/bin/env python3
"""dumpend — tabulky **konce hry** do data/end.json.

Tabule se skóre nemá obrázek: je to **sedm nadpisů, tři rámečky, maska
rovnice a patnáct řádků síně slávy**, a všechno to jsou statická data
(`sources/docs/disasm_notes.md` §33). Tenhle nástroj je vytáhne z obrazu
paměti a **u každé tabulky si její hranice ověří kódem, který ji čte** —
stejně jako `dumpglobal.py` u tabulek pohybu (§17).

| adresa | délka | čte | co to je |
|---|---|---|---|
| `$B96D` | 14 | `$B844` | sedm ukazatelů na nadpisy |
| `$B97B` | 7 | `$B84E` | jejich délky (o jednu menší, `BPL`) |
| `$B982` | 7 | `$B85C` | o kolik řádků se po nadpisu jde dál |
| `$B9A0` | 10 | `$B994` | znaky rohů horního rámečku |
| `$B9AA` | 10 | `$B997` | a jejich offsety; první čtyři čte i `$B9C4` |
| `$B9B4` | 14 | `$B9E4` | offsety znaků spodního rámečku |
| `$B9D0` | 4 | `$B9C4` | znaky prostředku |
| `$B9ED` | 14 | `$B9E1` | znaky spodního rámečku |
| `$BB7F` | 13 | `$BB71` | maska rovnice `n × 100 = n00` |
| `$BB8C` | 13 | `$BB76` | a její barvy |
| `$BAE7` | 4 | `$BACD` | číslice `1000` za dokončenou misi |
| `$BD80` | 15 | `$BCF8` | offsety patnácti řádků síně slávy |
| `$BEF0` | 64 | `$BEEC` | matice klávesnice → screen code |

★ **Kódování písmen je to ze sady šachty** (`a` = `$71`, mezera `$53`,
tečka `$FE`, §14), protože tabule se kreslí s `$D018` = `$02`. Nástroj
proto texty rovnou **přeloží** a do `data/end.json` je uloží i čitelně; kdyby
se překlad pokazil, je to vidět na první pohled.

★ **Prázdná síň slávy se nebere z obrazu**, a to je podstatné: `$CF00` je
v obrazu paměti **zbytek rozbaleného obrázku titulky** (§4). Tabulku
vyrábí až `$38AA`, když `LOAD "HI"` nevyjde — patnáct položek po osmi
bajtech, jméno z pěti `$DC` a skóre nula. Nástroj ji proto skládá **podle
toho kódu** a jeho konstanty si ověřuje.

    ./tools/dumpend.py                 # → data/end.json
    ./tools/dumpend.py --show
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unpack import build

# (adresa, délka, kdo čte, co to je)
TABLES = [
    (0xB96D, 14, '$B844', 'sedm ukazatelů na nadpisy'),
    (0xB97B, 7, '$B84E', 'délky nadpisů, o jednu menší (BPL)'),
    (0xB982, 7, '$B85C', 'o kolik řádků se po nadpisu jde dál'),
    (0xB9A0, 10, '$B994', 'znaky rohů horního rámečku'),
    (0xB9AA, 10, '$B997', 'jejich offsety; první čtyři čte i $B9C4'),
    (0xB9B4, 14, '$B9E4', 'offsety znaků spodního rámečku'),
    (0xB9D0, 4, '$B9C4', 'znaky prostředku rámečku'),
    (0xB9ED, 14, '$B9E1', 'znaky spodního rámečku'),
    (0xBB7F, 13, '$BB71', 'maska rovnice n x 100 = n00'),
    (0xBB8C, 13, '$BB76', 'barvy té masky'),
    (0xBAE7, 4, '$BACD', 'číslice 1000 za dokončenou misi'),
    (0xBD80, 15, '$BCF8', 'offsety patnácti řádků síně slávy'),
    (0xBEF0, 64, '$BEEC', 'matice klávesnice -> screen code'),
]

# nadpisy: (jméno, adresa, délka) — délky jsou `$B97B` + 1
LABELS = [
    ('piecesFound', 0xB89A, 19),
    ('passwordsFound', 0xB8AD, 15),
    ('puzzlesSolved', 0xB8BC, 14),
    ('secondsRemaining', 0xB8CA, 17),
    ('missionComplete', 0xB8DB, 16),
    ('totalScore', 0xB8EB, 21),
    ('hallOfFame', 0xB933, 23),
]
# ★ nadpis, který se za X = 4 vymění, když hodiny stojí na šesté (`$B835`)
TERMINATED = ('missionTerminated', 0xB94A, 35)
# dvouřádkový text „this surpasses the previous high score of" (`$BC42`)
SURPASS = (('surpass0', 0xB900, 29), ('surpass1', 0xB91D, 29))
# spodní řádky: co se čeká na klávesu a co se ptá na jméno
PROMPTS = (('hitRestore', 0xBDB3, 36), ('enterName', 0xBD8F, 36))
PROMPT_COLORS = (0xBDD7, 36)

# kde se tabule kreslí (`$B77C`, `$B87C`, `$BC3A`, `$BC5B`, `$BC70`)
SCREEN = 0x4000
LAYOUT = {
    'frameTop': 0x4000,          # `$B7BE` — kreslicí poloha na začátku
    'labels': 0x42D2,            # `$B81B` — odkud jdou nadpisy nahoru
    'labelColors': 0xDAD2,
    'score': 0x4040,             # `$BA03` — první řádek rovnice
    'scoreColors': 0xD840,
    'surpass': 0x420A,           # `$BC3A` — „this surpasses…"
    'surpassScore': 0x423A,      # `$BC5B` — a to staré nejvyšší skóre
    'fame': 0x42F9,              # `$BC70` — patnáct řádků síně slávy
    'prompt': 0x42AA,            # `$B87C` a `$BCE8` — spodní řádek
    'promptColors': 0xDAAA,
}

# síň slávy: patnáct položek po osmi bajtech na `$CF00` (`$BBF7`, `$BD57`)
FAME_AT, FAME_ENTRIES, FAME_STRIDE = 0xCF00, 15, 8
FAME_NAME, FAME_NAME_LENGTH = 3, 5
FAME_BLANK = 0xDC                 # `$38AA LDA #$DC`
# odkládací pásmo pro zp `$90`–`$FA` kolem KERNALu (`$38C8`, `$BDFB`)
FAME_SPILL, FAME_SPILL_LENGTH = 0xCF80, 0x6B

# ★ konstanty ověřované **na svém místě v kódu**: (adresa operandu, hodnota, co to je)
CONSTANTS = [
    (0x83E2, 0x06, 'čas vyprší v 6 hodin ($83E1)'),
    (0x83E6, 0xFF, 'a $43 dostane $FF ($83E5)'),
    (0x8403, 0x01, 'rámeček zbělá ($8402)'),
    (0x8408, 0x05, 'a řekne se věta 5 ($8407)'),
    (0x840D, 0x7F, 'třes má 128 kol ($840C)'),
    (0x8412, 0x07, 'svislý posun jsou spodní tři bity ($8411)'),
    (0x8423, 0x07, 'vodorovný taky ($8422)'),
    (0x8444, 0x10, 'a bit 4 $D011 je 24/25 řádků ($8443)'),
    (0x847B, 0x52, 'plocha se zalije znakem $52 ($847A)'),
    (0x84D7, 0x09, 'a barvou 9 ($84D6)'),
    (0x8490, 0x7F, 'rozpad má 128 kol ($848F)'),
    (0x8495, 0x03, 'a v kole čtyři stránky ($8494)'),
    (0x84A5, 0x53, 'na kterých maže znakem $53 ($84A4)'),
    (0x84AD, 0x40, 'dolů po $4000 ($84AC)'),
    (0x84B8, 0x00, 'nakonec rámeček zčerná ($84B7)'),
    (0xB86F, 0x00, 'konec, který není časem, řekne větu 0 ($B86E)'),
    (0xB86B, 0x06, 'a pozná se hodinami ($B868)'),
    (0xB832, 0x06, 'nadpis 4 se mění podle hodin ($B831)'),
    (0xBA63, 0x12, 'dvanáctá hodina se přepíše na nulu ($BA62)'),
    (0xBA6B, 0x06, 'a na šesté se vteřiny nepočítají ($BA6A)'),
    (0xBA86, 0x60, 'vteřiny: $60 minus $D2 ($BA85)'),
    (0xBA90, 0x59, 'minuty: $59 minus $D3 ($BA8F)'),
    (0xBAA8, 0x05, 'hodiny: $05 minus $D4 ($BAA7)'),
    (0xBAB0, 0x36, 'a hodina je $36 (3 600) vteřin ($BAAF)'),
    (0xBAD8, 0x10, 'dokončená mise je $10 stovek, tedy 1 000 ($BAD7)'),
    (0xBBC0, 0x05, 'skládačka je 5 stovek, tedy 500 ($BBBF)'),
    (0xBBA5, 0x01, 'dílek i heslo jsou 1 stovka, tedy 100 ($BBA4)'),
    (0xBB37, 0x8B, 'číslice se tisknou od screen code $8B ($BB36)'),
    (0xBBF1, 0x8C, 'jednička rovnice je $8C ($BBF0)'),
    (0xBA58, 0x90, 'a pětka $90 ($BA57)'),
    (0xBC00, 0x0E, 'síň slávy má patnáct položek ($BBFF)'),
    (0xBC0F, 0x08, 'položka je osm bajtů ($BC0E)'),
    (0xBC2E, 0x10, 'a krok zpátky je proto $10 minus těch osm ($BC2D)'),
    (0xBD30, 0x05, 'jméno má pět znaků ($BD2F)'),
    (0xBCE2, 0x0F, 'a pod patnáctou položku se nevejde ($BCE1)'),
    (0x38AB, 0xDC, 'prázdné jméno je pětkrát $DC ($38AA)'),
    (0xB794, 0x02, 'tabule kreslí sadou šachty, $D018 = $02 ($B793)'),
]
# ★ `$B77C` čeká na `RUN/STOP`, a to je v matici klávesnice `$F0`
RESTORE_KEY = 0xF0
# ★ a pak **nová hra**, ne vypnutí (`$B897 JMP $38D2`)
RESTART_CODE = (0xB897, bytes([0x4C, 0xD2, 0x38]))
# dvě cesty do tabule a nikde jinde (`$84BF`, `$AB64`)
ENTRIES = ((0x84BF, 'vypršel čas'), (0xAB64, 'řídicí místnost'))


def text_of(mem, at, length):
    """Screen codes sady šachty na písmena — `a` = `$71`, mezera `$53` (§14)."""
    out = []
    for b in mem[at:at + length]:
        if b == 0x53:
            out.append(' ')
        elif 0x71 <= b <= 0x8A:
            out.append(chr(ord('a') + b - 0x71))
        elif 0x8B <= b <= 0x94:
            out.append(chr(ord('0') + b - 0x8B))
        elif b == 0xFE:
            out.append('.')
        elif b == 0xDD:
            out.append('/')
        elif b == 0xD9:
            out.append('x')
        elif b == 0x96:
            out.append('=')
        elif b == 0xDC:
            out.append('_')
        else:
            out.append('?')
    return ''.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--mem', help='hotový obraz paměti místo rozbalení diskety')
    ap.add_argument('-o', default='data/end.json')
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

    tables = []
    for at, length, reader, what in TABLES:
        tables.append({'addr': '$%04X' % at, 'length': length, 'reader': reader,
                       'what': what, 'values': list(mem[at:at + length])})

    # --- nadpisy: ukazatel, délka a text musí souhlasit s `$B96D` --------
    labels = []
    for i, (name, at, length) in enumerate(LABELS):
        ptr = mem[0xB96D + 2*i] | mem[0xB96D + 2*i + 1] << 8
        check(ptr == at, 'nadpis %s: `$B96D` míří na $%04X, čekalo se $%04X'
              % (name, ptr, at))
        check(mem[0xB97B + i] + 1 == length,
              'nadpis %s: `$B97B` říká %d znaků, čekalo se %d'
              % (name, mem[0xB97B + i] + 1, length))
        labels.append({'name': name, 'addr': '$%04X' % at, 'length': length,
                       'text': text_of(mem, at, length),
                       'values': list(mem[at:at + length]),
                       'advance': mem[0xB982 + i]})
        # ★ nadpis nesmí obsahovat znak, který se nedá přečíst — je to
        # jediná pojistka proti tomu, že se v kódování písmen něco pokazí
        check('?' not in labels[-1]['text'],
              'nadpis %s se nedá přečíst: %r' % (name, labels[-1]['text']))

    extra = []
    for name, at, length in (TERMINATED,) + SURPASS + PROMPTS:
        item = {'name': name, 'addr': '$%04X' % at, 'length': length,
                'text': text_of(mem, at, length), 'values': list(mem[at:at + length])}
        check('?' not in item['text'], 'text %s se nedá přečíst: %r'
              % (name, item['text']))
        extra.append(item)
    extra.append({'name': 'promptColors', 'addr': '$%04X' % PROMPT_COLORS[0],
                  'length': PROMPT_COLORS[1], 'text': None,
                  'values': list(mem[PROMPT_COLORS[0]:PROMPT_COLORS[0] + PROMPT_COLORS[1]])})

    # ★ `$B94A` se od `$B8DB` musí lišit — je to celý smysl té výměny
    check(text_of(mem, TERMINATED[1], TERMINATED[2]).replace(' ', '')
          == 'missionterminated',
          'vyměněný nadpis nezní „mission terminated": %r'
          % text_of(mem, TERMINATED[1], TERMINATED[2]))

    # --- konstanty na svém místě v kódu ---------------------------------
    for at, value, what in CONSTANTS:
        check(mem[at] == value, '%s: na $%04X je $%02X, čekalo se $%02X'
              % (what, at, mem[at], value))
    at, want = RESTART_CODE
    check(bytes(mem[at:at + len(want)]) == want,
          'konec hry na $%04X neskáče na novou hru $38D2' % at)
    for at, what in ENTRIES:
        check(bytes(mem[at:at + 3]) == bytes([0x4C, 0x7C, 0xB7]),
              'cesta do tabule (%s) na $%04X není `JMP $B77C`' % (what, at))
    # ★ a **nikde jinde** — kdyby se konec hry pustil ještě odjinud, měřidlo
    # by o té cestě nevědělo
    found = [at for at in range(0x0880, 0xCFFD)
             if mem[at] in (0x4C, 0x20) and mem[at + 1] == 0x7C and mem[at + 2] == 0xB7]
    check(sorted(found) == sorted(at for at, _ in ENTRIES),
          'do tabule se skáče i odjinud: %s' % ['$%04X' % x for x in found])

    # --- prázdná síň slávy podle `$38AA`/`$38B4` -------------------------
    blank = []
    for i in range(FAME_ENTRIES):
        blank.append({'score': [0, 0, 0],
                      'name': [FAME_BLANK]*FAME_NAME_LENGTH})
    check(FAME_AT + FAME_ENTRIES*FAME_STRIDE == 0xCF78,
          'patnáct položek po osmi nekončí na $CF78')
    check(FAME_AT + 0x80 == FAME_SPILL,
          'odkládací pásmo nezačíná na $CF80')

    data = {
        'source': 'statická data originálu, obraz paměti z tools/unpack.py',
        'note': 'konec hry: $83EA, $B77C a síň slávy $BBF7 (disasm_notes.md §33)',
        'charset': 'šachta ($4800), a = $71, mezera = $53 (§14)',
        'tables': tables,
        'labels': labels,
        'terminatedFor': 4,
        'texts': extra,
        'layout': {k: '$%04X' % v for k, v in LAYOUT.items()},
        'screen': '$%04X' % SCREEN,
        'shake': {'rounds': 0x80, 'draws': 3},
        'dissolve': {'rounds': 0x80, 'pages': 4, 'top': 0x43, 'bottom': 0x40,
                     'fill': 0x52, 'blank': 0x53, 'color': 9},
        'score': {'at': '$00D9', 'bytes': 3,
                  'piece': 1, 'password': 1, 'puzzle': 5, 'mission': 0x10,
                  'note': 'přičítá se do $DA, tedy do stovek — 100/100/500/1000'},
        'speech': {'timeUp': 5, 'gameOver': 0, 'controlRoom': 4},
        'fame': {'at': '$%04X' % FAME_AT, 'entries': FAME_ENTRIES,
                 'stride': FAME_STRIDE, 'nameAt': FAME_NAME,
                 'nameLength': FAME_NAME_LENGTH, 'blank': FAME_BLANK,
                 'spill': '$%04X' % FAME_SPILL, 'spillLength': FAME_SPILL_LENGTH,
                 'empty': blank},
        'keys': {'restore': RESTORE_KEY, 'nothing': 0xFF, 'ret': 0x00,
                 'delete': 0x01},
        'restart': '$38D2',
        'entries': [{'addr': '$%04X' % at, 'what': what} for at, what in ENTRIES],
        'checks': checks, 'diffs': diffs,
    }
    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    json.dump(data, open(a.o, 'w'), indent=1)

    if a.show:
        for item in labels:
            print('  %-18s %s  %r' % (item['name'], item['addr'], item['text']))
        for item in extra:
            if item['text']:
                print('  %-18s %s  %r' % (item['name'], item['addr'], item['text']))
    print('dumpend: %d tabulek, %d nadpisů, %d kontrol, %d rozdílů → %s'
          % (len(tables), len(labels), checks, diffs, a.o))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
