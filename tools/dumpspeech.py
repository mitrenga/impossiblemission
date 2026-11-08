#!/usr/bin/env python3
"""dumpspeech — index vzorků řeči do data/speech.json.

★ Řeč je **`IM.WORDS`, 6 016 B na `$E000`–`$F77F`** pod odpojeným KERNALem
(§2, §4) a přehrává se **zápisy do `$D418`** z **NMI od časovače B CIA2**,
tedy **s kadencí v cyklech, ne ve snímcích** (`sources/docs/disasm_notes.md`
§18). Tenhle nástroj **nedekóduje zvuk** — to je M6. Dělá **index**: co
v těch 6 016 bajtech je, kde to začíná, jak je to dlouhé, čím se to hraje
a s jakým hashem, aby se při buildu dat dalo sáhnout na blok a bylo doložené,
že je to ten blok.

Co je doložené z kódu (a čím to nástroj kontroluje):

| věc | kde | čím |
|---|---|---|
| tabulka slov | `$E000`, **8 položek po 4 B** | `$0CAB` (`index*4`, základ `$0CFE/$0CFF` = `$E000`) |
| proud obálky | 1. ukazatel položky | čte `$0B31` přes `($A7)` |
| proud skriptu | 2. ukazatel položky | čte `$09C0` přes `($A5)`, **záznam 4 B** (`$0A5C`: `$A5 += 4`) |
| konec věty | bit 7 bajtu 3 záznamu | `$09E1` → `$09B7`, test `$09B6` → `$092F = $7B` (`$097B` zastaví) |
| rámce | `$E47E`–`$F77F` | bajty 2 a 3 záznamu = ukazatel (`+$E000`, horní bajt `& $3F`, `$09D6`) |
| vyrovnávací paměť | `$0800`, půlky po **32 nebo 64** B | `$0CF8` z bitu 6 bajtu 0 (`$09FB`), plní `$0A68`/`$0AE5`/`$0B73`/`$0BE3` |
| kadence | **časovač B CIA2, latch `$0064`** | `$0C76` (`$DD06`), `$0C7B` (`$DD07`), `$0C80` (`$DD0D = $82`) |
| výstup | `LSR` + `STA $D418` | `$0884`, `$08A4`, `$08C3` (hlasitost SID, 4 bity) |

★ **Vět je osm a bloky na sebe navazují bez děr.** Že to tak je, se nehádá
z obrázku: nástroj projde skript každé věty záznam po záznamu až po bit 7
a **musí dojít přesně na začátek skriptu další věty** — a u poslední věty
(`$E476`, dva záznamy) musí zbytek souboru od `$E47E` být právě ta oblast,
do které míří **všechny** ukazatele rámců všech osmi vět. To je kontrola,
která drží celé rozvržení pohromadě.

★ **Věta 6 se nikde nevolá.** Volání je sedm (`LDX #n` + `JSR $BF51`)
a pokrývají indexy 0–5 a 7; k indexu 6 v programu volání není. Nástroj to
neopravuje ani nezamlčuje — vypíše to.

?? **Co která věta říká, se tady netvrdí.** Text by byl druhá ruka; do dat
patří až tehdy, když se vzorky přehrají (M6). Index nese jen to, co je
v kódu: odkud se věta pouští a za jaké podmínky.

    ./tools/dumpspeech.py                 # → data/speech.json
    ./tools/dumpspeech.py --show          # + rozpis záznamů skriptu
"""
import argparse, base64, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imlib import D64
from unpack import build

WORDS_LO, WORDS_HI = 0xE000, 0xF780        # IM.WORDS: $E000-$F77F, 6 016 B
WORDS_LEN = WORDS_HI - WORDS_LO
TABLE = WORDS_LO                           # tabulka slov, 8 položek po 4 B
COUNT = 8
ENTRY = 4
REC = 4                                    # záznam skriptu, $0A5C: $A5 += 4
END_BIT = 0x80                             # bit 7 bajtu 3 = konec věty ($09B6)
PTR_MASK = 0x3F                            # horní bajt ukazatele rámce ($09E4)
NOISE_BIT = 0x04                           # bit 2 bajtu 1: bajty 2 a 3 nejsou ukazatel ($09CE → BCS $0A4B)
FRAME_BIT = 0x40                           # bit 6 bajtu 0: rámec 64 B místo 32 ($09FD)

BUFFER = 0x0800                            # STA $0800,X — vyrovnávací paměť vzorků
SIGVOL = 0xD418

# kadence: časovač B CIA2 (`$0C71`-`$0C88`) — latch a povolení NMI
CADENCE = [(0x0C76, bytes([0xA9, 0x64]), 'LDA #$64'),      # latch lo
           (0x0C78, bytes([0x8D, 0x06, 0xDD]), 'STA $DD06'),
           (0x0C7B, bytes([0xA9, 0x00]), 'LDA #$00'),      # latch hi
           (0x0C7D, bytes([0x8D, 0x07, 0xDD]), 'STA $DD07'),
           (0x0C80, bytes([0xA9, 0x82]), 'LDA #$82'),      # NMI od časovače B
           (0x0C82, bytes([0x8D, 0x0D, 0xDD]), 'STA $DD0D')]
TIMER_LATCH = 0x0064
PAL_CYCLES_PER_FRAME = 19656               # ★ R-038, CLAUDE.md
PAL_CLOCK = 985248

# přehrávač: tři místa, kde do $D418 padne vzorek (posunutý o bit doprava)
PLAYER = [(0x0884, 'LDA vyrovnávací paměť, LSR, STA $D418 — první půlka'),
          (0x08A4, 'LDA vyrovnávací paměť, LSR, STA $D418 — druhá půlka'),
          (0x08C3, 'LDA #$0E, LSR, STA $D418 — náběh a doběh (ticho)')]

# ★ volání řeči: `LDX #n` + `JSR $BF51`. Podmínka je odečtená z kódu kolem.
CALLS = [
    (0x39F4, 2, '$39F4', 'rozběh hry — hned po generátoru pevnosti ($7236) '
                         'a po zapnutí sprajtů ($D015 = $CF)'),
    (0x39FF, 3, '$39FF', 'rozběh hry — druhá věta hned za první, mezi nimi $7F6D'),
    (0x8BC8, 1, '$8BC8', 'herní smyčka — příznak $C1 je nenulový a stav agenta '
                         'není $11, $1B, $14 ani $07; $C1 se přitom nuluje'),
    (0x8407, 5, '$8407', 'SEI, $D020 = $01 — smyčka blikání obrazovky'),
    (0x9605, 7, '$9605', 'ticho na všech třech hlasech SID a $43 = $02; '
                         'sprajty 1-3 se vypnou ($D015 &= $F1)'),
    (0xAB23, 4, '$AB23', 'přepínání obrazu ($71FB dvakrát, $01 = $25)'),
    (0xB86E, 0, '$B86E', 'konec hry — hodina $D4 **není** 6 (tedy ne vypršený čas)'),
]
WRAPPER = 0xBF51                           # obálka: uloží X do $BF50, JSR $0880
ENTRYPT = 0x0880                           # vstup ovladače řeči (JMP $0C2F)

# ★ M6: co z ovladače je **data** a musí se vozit s sebou, protože to
# přepis čte (`app/speech.js`, §32).
AMPS = 0x0AD5      # čtyři tabulky po 4 B, index z bitů 0-1 prvního bajtu rámce
AMPS_LEN = 16      # ★ a ta nultá **není tabulka, je to kód** ($0AD4 `CPX #`)
AMPS_TABLE = 0x0AD9                        # tři tabulky, které tabulky opravdu jsou
STEPS = 0x0B63     # přírůstky obrysu, 16 B se znaménkem ($F4…$0E)
STEPS_LEN = 16
DEFAULTS = 0x0CF1  # stav ovladače: $0CF1-$0CFF, mezi nimi základ dat $0CFE/$0CFF
DEFAULTS_LEN = 15
PADS = 0x0A47      # délky rámce režimů 2 a 3, 4 B ($0A2E: bity 6-7 bajtu 0)
PADS_LEN = 4
# ★ handlery, které si ovladač sází do `JSR $098C` ($092F) a do `JMP $0951` ($0911)
HANDLERS = {0x098C: 'režim 1 — jeden bit na vzorek, hraje se přímo ($0B73)',
            0x098F: 'režim 0 — dva bity na vzorek, hraje se přímo ($0BE3)',
            0x0992: 'režim 3 — dva bity na vzorek, interpoluje se ($0A68)',
            0x0998: 'režim 2 — čtyři bity na vzorek, interpoluje se ($0AE5)',
            0x0981: 'pauza — $0CF1 = $C3 (fáze náběhu) a $0CF4 = $80',
            0x097B: 'konec věty — $0CF1 = $E1'}
AFTERS = {0x0937: 'nic (PLA, RTI)',
          0x0939: 'interpolace $0BFD a krok obrysu $0B1D',
          0x0951: 'zkrácení okna o $0CF9, a po $10 zase celé'}


def walk(mem, start):
    """Skript věty: záznamy po 4 B až po bit 7 bajtu 3 ($09B6 pak zastaví)."""
    recs, a = [], start
    while True:
        r = mem[a:a + REC]
        recs.append((a, r))
        a += REC
        if r[3] & END_BIT:
            return recs, a
        if a >= WORDS_HI:
            return recs, a                 # neukončený skript — kontrola to chytí


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--disk', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('-o', default='data/speech.json')
    ap.add_argument('--show', action='store_true', help='rozpis záznamů skriptu')
    a = ap.parse_args()

    mem = build(a.disk, verbose=False)
    checks = diffs = 0

    def check(ok, what):
        nonlocal checks, diffs
        checks += 1
        if not ok:
            diffs += 1
            print('  ROZDÍL: %s' % what)

    # --- 1. soubor: adresa a délka rovnou z diskety -----------------------
    prg = D64(a.disk).read('IM.WORDS')
    load = prg[0] | prg[1] << 8
    check(load == WORDS_LO, 'IM.WORDS se nahrává na $%04X, ne na $%04X' % (load, WORDS_LO))
    check(len(prg) - 2 == WORDS_LEN,
          'IM.WORDS má %d B, ne %d' % (len(prg) - 2, WORDS_LEN))
    check(bytes(mem[WORDS_LO:WORDS_HI]) == prg[2:],
          'obraz paměti na $E000 nesedí s IM.WORDS z diskety')
    words_bytes = bytes(mem[WORDS_LO:WORDS_HI])

    # --- 2. kód: kadence, přehrávač, volání ------------------------------
    for addr, want, what in CADENCE:
        check(bytes(mem[addr:addr + len(want)]) == want,
              'na $%04X není %s' % (addr, what))
    for addr, what in PLAYER:
        # LDA …, LSR A, STA $D418 — mezi LDA a LSR je buď nic, nebo NOP
        seg = bytes(mem[addr:addr + 10])
        check(b'\x4a\x8d\x18\xd4' in seg, 'na $%04X není LSR + STA $D418 (%s)' % (addr, what))
    for addr, idx, _, _ in CALLS:
        check(mem[addr] == 0xA2 and mem[addr + 1] == idx,
              'na $%04X není LDX #$%02X' % (addr, idx))
        check(mem[addr + 2] == 0x20 and (mem[addr + 3] | mem[addr + 4] << 8) == WRAPPER,
              'na $%04X za LDX není JSR $%04X' % (addr, WRAPPER))
    check(mem[ENTRYPT] == 0x4C and (mem[ENTRYPT + 1] | mem[ENTRYPT + 2] << 8) == 0x0C2F,
          'na $%04X není JMP $0C2F' % ENTRYPT)
    check(mem[WRAPPER + 0x1E] == 0x20 and
          (mem[WRAPPER + 0x1F] | mem[WRAPPER + 0x20] << 8) == ENTRYPT,
          'obálka $%04X nevolá $%04X' % (WRAPPER, ENTRYPT))
    called = {idx for _, idx, _, _ in CALLS}

    # --- 3. tabulka slov --------------------------------------------------
    table = [(mem[TABLE + i*ENTRY] | mem[TABLE + i*ENTRY + 1] << 8,
              mem[TABLE + i*ENTRY + 2] | mem[TABLE + i*ENTRY + 3] << 8)
             for i in range(COUNT)]
    check(table[0][0] == COUNT * ENTRY,
          'první ukazatel obálky je $%04X, ne velikost tabulky ($%02X)'
          % (table[0][0], COUNT * ENTRY))
    for i in range(1, COUNT):
        check(table[i][0] > table[i-1][0], 'ukazatele obálky nerostou u slova %d' % i)
        check(table[i][1] > table[i-1][1], 'ukazatele skriptu nerostou u slova %d' % i)
    check(table[-1][0] < table[0][1],
          'obálky přesahují do skriptů ($%04X >= $%04X)' % (table[-1][0], table[0][1]))

    # --- 4. skripty: projít záznam po záznamu a navázat na další slovo ----
    words, targets = [], []
    for i, (pe, ps) in enumerate(table):
        recs, end = walk(mem, WORDS_LO + ps)
        nxt = WORDS_LO + table[i+1][1] if i + 1 < COUNT else None
        if nxt is not None:
            check(end == nxt, 'skript slova %d končí na $%04X, další začíná na $%04X'
                  % (i, end, nxt))
        else:
            check(end < WORDS_HI, 'skript slova %d přetekl soubor' % i)
        ptrs = []
        for _, r in recs:
            if r[1] & NOISE_BIT:
                continue                   # bajty 2 a 3 nejsou ukazatel ($0A4B)
            t = WORDS_LO + (r[2] | (r[3] & PTR_MASK) << 8)
            ptrs.append(t)
        targets += ptrs
        env_len = (table[i+1][0] if i + 1 < COUNT else table[0][1]) - pe
        words.append({
            'index': i,
            'envelope': {'addr': '$%04X' % (WORDS_LO + pe), 'bytes': env_len,
                         'pairs': env_len // 2},
            'script': {'addr': '$%04X' % (WORDS_LO + ps), 'bytes': len(recs) * REC,
                       'records': len(recs), 'end': '$%04X' % (end - 1)},
            'frames': {'count': len(ptrs),
                       'first': '$%04X' % min(ptrs) if ptrs else None,
                       'last': '$%04X' % max(ptrs) if ptrs else None,
                       'sizes': sorted({64 if r[0] & FRAME_BIT else 32 for _, r in recs}),
                       'modes': sorted({r[1] & 3 for _, r in recs})},
            'calledFrom': [{'addr': w, 'when': when}
                           for addr, idx, w, when in CALLS if idx == i],
            'sha256': hashlib.sha256(
                words_bytes[ps:ps + len(recs)*REC]).hexdigest(),
        })

    # --- 4b. ★ data ovladače, která si přepis odveze (M6, §32) ----------
    amps = bytes(mem[AMPS:AMPS + AMPS_LEN])
    steps = bytes(mem[STEPS:STEPS + STEPS_LEN])
    pads = bytes(mem[PADS:PADS + PADS_LEN])
    defaults = bytes(mem[DEFAULTS:DEFAULTS + DEFAULTS_LEN])
    # ★ nultá „tabulka" jsou bajty kódu $0AD4-$0AD8 (`CPX #$40 / BNE / RTS`),
    # a první z nich si rozbalovač sám přepisuje na konec okna. Tabulky jsou
    # tedy jen tři — a ta nultá je v datech proto, aby se dalo doložit, co
    # by se z ní přečetlo, kdyby na ni index 0 opravdu padl.
    check(bytes(mem[0x0AD4:0x0AD9]) == bytes([0xE0, 0x00, 0xD0, 0xBA, 0x60]),
          'na $0AD4 není `CPX #imm / BNE / RTS`, takže nultá tabulka je něco jiného')
    for i in range(3):
        row = amps[4 + i*4:8 + i*4]
        check(list(row) == sorted(row), 'tabulka $%04X neroste' % (AMPS_TABLE + i*4))
        check(max(row) <= 0x1E, 'tabulka $%04X má vzorek nad $1E' % (AMPS_TABLE + i*4))
    check(list(pads) == [0x08, 0x10, 0x18, 0x20],
          'délky rámce režimů 2 a 3 nejsou 8, 16, 24, 32')
    check(defaults[0x0CFE - DEFAULTS] == 0x00 and defaults[0x0CFF - DEFAULTS] == 0xE0,
          'základ dat v $0CFE/$0CFF není $E000')
    check(steps[6] == 0xFF and steps[7] == 0x00,
          'tabulka přírůstků $0B63 nemá uprostřed $FF a $00')
    # ★ handlery: na každé adrese musí být to, co se od ní čeká
    check(bytes(mem[0x098C:0x098F]) == bytes([0x4C, 0x73, 0x0B]), 'na $098C není JMP $0B73')
    check(bytes(mem[0x098F:0x0992]) == bytes([0x4C, 0xE3, 0x0B]), 'na $098F není JMP $0BE3')
    check(bytes(mem[0x0992:0x0995]) == bytes([0x20, 0x68, 0x0A]), 'na $0992 není JSR $0A68')
    check(bytes(mem[0x0998:0x099B]) == bytes([0x20, 0xE5, 0x0A]), 'na $0998 není JSR $0AE5')
    check(mem[0x0937] == 0x68 and mem[0x0938] == 0x40, 'na $0937 není PLA, RTI')

    # --- 5. oblast rámců: začíná tam, kde končí poslední skript ----------
    last_end = WORDS_LO + table[-1][1] + words[-1]['script']['records'] * REC
    check(min(targets) >= last_end,
          'ukazatel rámce $%04X míří před oblast rámců $%04X' % (min(targets), last_end))
    check(max(targets) < WORDS_HI,
          'ukazatel rámce $%04X míří za soubor' % max(targets))

    data = {
        'source': 'IM.WORDS z originální diskety, obraz paměti z tools/unpack.py',
        'note': 'index, ne zvuk — dekódování vzorků je M6 '
                '(sources/docs/disasm_notes.md §18)',
        'file': {'name': 'IM.WORDS', 'addr': '$%04X-$%04X' % (WORDS_LO, WORDS_HI - 1),
                 'bytes': WORDS_LEN, 'underKernal': True,
                 'sha256': hashlib.sha256(words_bytes).hexdigest(),
                 # ★ M6: bajty samy. Věty sdílejí rámce ($E47E-$F77F), takže
                 # „vystřihnout jednu" nejde — veze se celých 6 016 B.
                 'data': base64.b64encode(words_bytes).decode()},
        'table': {'addr': '$%04X' % TABLE, 'count': COUNT, 'entryBytes': ENTRY,
                  'readBy': '$0CAB', 'base': '$%04X' % WORDS_LO,
                  'layout': '2 B ukazatel obálky, 2 B ukazatel skriptu; oba relativně k $E000'},
        'player': {
            'irq': 'NMI od časovače B CIA2 ($DD06/$DD07 = $%04X, $DD0D = $82)' % TIMER_LATCH,
            'timerLatch': TIMER_LATCH,
            'cyclesPerSample': TIMER_LATCH + 1,
            'sampleRatePAL': round(PAL_CLOCK / (TIMER_LATCH + 1), 1),
            'samplesPerFramePAL': round(PAL_CYCLES_PER_FRAME / (TIMER_LATCH + 1), 1),
            'output': '$%04X — LSR + STA $%04X, tedy 4 bity hlasitosti SID'
                      % (BUFFER, SIGVOL),
            'buffer': {'addr': '$%04X' % BUFFER, 'halves': 2,
                       'halfBytes': [32, 64],
                       'setBy': '$0CF8 z bitu 6 bajtu 0 záznamu ($09FB)'},
            'setup': '$0C71 nastaví časovač, $0C89 přezbrojí dekodér, vektor NMI je $FFFA',
            'stop': '$08E1 — $DD0F = $90 (časovač stojí), $D418 = $07',
            'entry': '$%04X (JMP $0C2F); obálka hry je $%04X, index věty jde v X'
                     % (ENTRYPT, WRAPPER),
            'commands': {'$FF': 'dotaz, jestli řeč ještě běží', '$FE': 'zastavit',
                         '$FD': 'nastavit základ dat z X/Y'},
        },
        'format': {
            'script': 'proud záznamů po 4 B: bajt 0 = počitadlo opakování a velikost '
                      'rámce (bit 6), bajt 1 = druhé počitadlo, bit 2 = šum '
                      '(bajty 2 a 3 pak nejsou ukazatel) a bity 0-1 = režim '
                      'rozbalení, bajty 2 a 3 = ukazatel na rámec (+$E000, horní '
                      'bajt & $3F), **bit 7 bajtu 3 = konec věty**',
            'envelope': '★ **není to hlasitost, je to délka pauzy za rámcem** '
                        '($0CF4 → $AF, fáze $08C3/$08D9): dvojice bajtů = '
                        'výchozí hodnota (bajt 0 & $FE), počet kroků '
                        '($E0 | bit 0 bajtu 0 << 4 | bajt 1 >> 4) a přírůstek '
                        'z tabulky $0B63 (dolní nibble bajtu 1); krok dělá $0B1D '
                        'a hodnota jde do $0CF4 posunutá o bit doprava. '
                        'Perioda rámce je tedy 2·délka + pauza, tedy **výška tónu**',
            'frames': {'addr': '$%04X-$%04X' % (last_end, WORDS_HI - 1),
                       'bytes': WORDS_HI - last_end,
                       'note': '★ sdílené — míří do nich ukazatele ze skriptů všech '
                               'vět, takže bloky vět nejsou disjunktní'},
            'unpackers': {'$0A68': 'režim 3 — dva bity na vzorek, 4 na bajt, '
                                   'z tabulky vybrané bity 0-1 prvního bajtu; '
                                   'hraje se z $0820/$0860 přes interpolaci',
                          '$0AE5': 'režim 2 — čtyři bity na vzorek, 2 na bajt '
                                   '(nibble × 2); hraje se přes interpolaci',
                          '$0B73': 'režim 1 — **jeden bit** na vzorek, 8 na bajt, '
                                   '$0E nebo $10; hraje se přímo z $0800/$0840',
                          '$0BE3': 'režim 0 — dva bity na vzorek jako $0A68, ale '
                                   'tabulka je vynucená na první ($0BF6 AND #$FC '
                                   'ORA #$01) a hraje se přímo'},
            'phases': {'$0883': 'A — vzorky dopředu, $AD jich',
                       '$08A4': 'B — **tytéž vzorky pozpátku**, $AE jich',
                       '$08C3': 'C — jednou $07 (ticho), a pak',
                       '$08D9': 'D — $AF-1 snímků **beze zápisu**: hladina drží',
                       '$08E1': 'konec — časovač stojí, $D418 = $07',
                       '$08F2': 'doplnění — nový rámec nebo další opakování'},
            'buffers': {'$0800': 'rozbalený rámec, půlka A',
                        '$0840': 'rozbalený rámec, půlka B',
                        '$0820': 'interpolovaný rámec, půlka A (režimy 2 a 3)',
                        '$0860': 'interpolovaný rámec, půlka B'},
        },
        # ★ M6: data samotného ovladače. Přepis (`app/speech.js`) je kód,
        # ale tohle jsou bajty, které ten kód **čte** — a na které by žádné
        # `match*` nepřišlo, protože měřidla začínají z paměti originálu.
        'driver': {
            'amplitudes': {'addr': '$%04X' % AMPS, 'bytes': AMPS_LEN,
                           'data': base64.b64encode(amps).decode(),
                           'note': '★ čtyři tabulky po 4 B, index z bitů 0-1 '
                                   'prvního bajtu rámce ($0A78) — a ta nultá '
                                   'jsou bajty kódu $0AD4-$0AD8, jejichž první '
                                   'si rozbalovač přepisuje na konec okna'},
            'steps': {'addr': '$%04X' % STEPS, 'bytes': STEPS_LEN,
                      'data': base64.b64encode(steps).decode(),
                      'note': 'přírůstky obrysu, se znaménkem: $F4…$0E ($0B4F)'},
            'pads': {'addr': '$%04X' % PADS, 'bytes': PADS_LEN,
                     'data': base64.b64encode(pads).decode(),
                     'note': 'délky rámce režimů 2 a 3 z bitů 6-7 bajtu 0 ($0A2E)'},
            'defaults': {'addr': '$%04X' % DEFAULTS, 'bytes': DEFAULTS_LEN,
                         'data': base64.b64encode(defaults).decode(),
                         'note': 'stav ovladače po nahrání; $0CFE/$0CFF je '
                                 'základ dat ($E000)'},
            'handlers': {'$%04X' % k: v for k, v in sorted(HANDLERS.items())},
            'afters': {'$%04X' % k: v for k, v in sorted(AFTERS.items())},
        },
        'notCalled': sorted(set(range(COUNT)) - called),
        'words': words,
    }

    os.makedirs(os.path.dirname(os.path.abspath(a.o)), exist_ok=True)
    with open(a.o, 'w') as f:
        json.dump(data, f, indent=1)
        f.write('\n')

    if a.show:
        for i, (pe, ps) in enumerate(table):
            print('slovo %d: skript $%04X' % (i, WORDS_LO + ps))
            for addr, r in walk(mem, WORDS_LO + ps)[0]:
                kind = 'šum ' if r[1] & NOISE_BIT else 'rámec $%04X' % (
                    WORDS_LO + (r[2] | (r[3] & PTR_MASK) << 8))
                print('  $%04X: %02X %02X %02X %02X   rámec %d B, režim %d, %s%s'
                      % (addr, r[0], r[1], r[2], r[3],
                         64 if r[0] & FRAME_BIT else 32, r[1] & 3, kind,
                         '  KONEC' if r[3] & END_BIT else ''))

    print('%s: %d vět, %d B, rámce $%04X-$%04X (%d B), %d cyklů na vzorek (%.1f Hz PAL)'
          % (a.o, COUNT, WORDS_LEN, last_end, WORDS_HI - 1, WORDS_HI - last_end,
             TIMER_LATCH + 1, PAL_CLOCK / (TIMER_LATCH + 1)))
    if data['notCalled']:
        print('bez volání v programu: věta %s'
              % ', '.join(str(i) for i in data['notCalled']))
    print('dumpspeech: %d kontrol, %d rozdílů' % (checks, diffs))
    return 1 if diffs else 0


if __name__ == '__main__':
    sys.exit(main())
