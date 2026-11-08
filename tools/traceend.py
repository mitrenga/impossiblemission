#!/usr/bin/env python3
"""traceend — záznam **konce hry** v originálu, `$83F2` a `$B77C`.

Konec hry je v programu **jeden** (`sources/docs/disasm_notes.md` §33) a vedou
do něj dvě cesty: vypršení času (`$84BF`) a řídicí místnost (`$AB64`). Tenhle
nástroj natáčí tu první celou — třes, rozpad a tabuli se skóre — a k tomu
umí druhou nasimulovat tím, že hodiny nechá jinde než na šesté.

★ **Čas se nedá vyčkat a nesmí se zaplátovat.** Hodiny jdou od dvanácté
k šesté, tedy šest herních hodin = **1 296 000 snímků**; to je sedm hodin
emulace na jeden záznam. Nastaví se proto **stav** hodin (`$D2`/`$D3`/`$D4`
na 5:59:57) a hodiny pak přetečou **samy kódem originálu** — `$83C2` je táž
rutina, kterou tikají celou hru, a `$83DF` v ní `$43` shodí. Nic se nezaplátuje:
záplata by přeskočila právě to, co se má změřit.

★ **Jednotkou tu není snímek.** `$8401` udělá `SEI` a `CLI` už nepřijde —
konec hry běží až na `JMP $38D2`, tedy na novou hru, s vypnutým přerušením.
`$9787` uvnitř není čekání na snímek, ale prázdná smyčka (§33). Záznam se
proto dělá **zastávkami**, jako umírání (§31) a terminál (§29):

| past | co už proběhlo |
|---|---|
| `$8401` | čas vypršel, hra se rozhodla skončit; `$1A` ještě říká, kde byla |
| `$840E` | **jedno kolo třesu** — tři čísla z míchačky v `$D011`/`$D016` |
| `$8452` | třes hotový, obrazovka se chystá zhasnout |
| `$8491` | **jedno kolo rozpadu** — šestnáct bajtů `$53` na náhodných místech |
| `$84B7` | rozpad hotový |
| `$B873` | tabule stojí: rámečky, sedm nadpisů, a věta 0, když to nebyl čas |
| `$B87C` | **skóre je spočítané** a síň slávy přerovnaná |
| `$B88D` | hotovo, čeká se na `RUN/STOP` |

★ **Třes a rozpad se dají měřit, ačkoli vypadají jako porucha**: obojí bere
čísla z míchačky `$82D6`, a ta je táž jako všude jinde (§8). Kdo chce jen
tabuli a ne dva a půl tisíce zastávek, dá `--stops tail`.

★ **Síň slávy se do záznamu vozí zvlášť** (`$CF00`–`$CF7F`): je to patnáct
položek po osmi bajtech, které `$3887` zkusil nahrát z diskety jako `HI`.
Na čisté disketě žádné `HI` není, takže `$38AA` udělá prázdnou — a záznam ji
má proto v každé zastávce, aby se dalo doložit vkládání i řazení.

★ **Do tabule se dá dojít jen jednou cestou, a to je přiznaná mez záznamu.**
Druhý vchod je `$AB64`, tedy **řídicí místnost** (`$AA40`, M5 část 4), a do té
se nedostane nikdo, kdo nemá složené heslo. Záznamy `endwin*` proto pustí
`$43` = `$FF` s hodinami **jinde než na šesté**: tabule se pak chová přesně
jako po dokončené misi (nadpis „mission complete", tisíc bodů, věta 0), ale
**navíc řekne i větu 5**, kterou by řídicí místnost neřekla. Měří se tedy
tabule, ne ta cesta k ní.

    ./tools/traceend.py --name endtime42 --entropy 42
    ./tools/traceend.py --set          # celá sada pro akceptaci M5

Měří to `tools/matchend.mjs` proti `app/endGame.js`.
"""
import argparse, copy, json, os, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu, GAME_IRQ, IRQ_PER_FRAME, CYCLES_PER_FRAME_PAL
from traceplayer import (ENTROPY_SITE, GAME_ENTRY, FRAME_TICK, STUB, STUB_CODE,
                         TICK_STUB, TICK_CODE, TICK_SITE, LOOP_STUB, LOOP_CODE,
                         LOOP_SITES, COUNTER, TABLE, MAX_FRAMES, JOY_SITES,
                         parse_script, parse_log)

# hodiny: snímky, vteřiny, minuty, hodiny, stopka (`RAMUse.md`, §19)
CLOCK_FRAMES, CLOCK_SECONDS, CLOCK_MINUTES, CLOCK_HOURS = 0xD1, 0xD2, 0xD3, 0xD4
# počitadla, ze kterých se skládá skóre (§33): dílky, hesla, skládačky
FOUND_PIECES, FOUND_PASSWORDS, SOLVED_PUZZLES = 0xD6, 0xD7, 0xD8
# skóre samo — tři bajty BCD, `$D9` nejnižší
SCORE = 0xD9

# co se vypisuje na každé zastávce; blok `zp` musí zůstat první
DUMPS = (('zp', 0x0000, 0x00FF, 'ram'),
         ('harness', 0x0320, 0x033F, 'ram'),
         ('screen', 0x4000, 0x43FF, 'ram'),
         # ★ **síň slávy**: patnáct položek po osmi bajtech na `$CF00`, a za
         # nimi odkládací pásmo `$CF80` pro zp `$90`–`$FA` (§33)
         ('fame', 0xCF00, 0xCF7F, 'ram'),
         ('color', 0xD800, 0xDBFF, 'io'),
         ('vic', 0xD000, 0xD02E, 'io'))

# pasti uvnitř konce hry (viz hlavička)
TRAPS = (0x8401, 0x840E, 0x8452, 0x8491, 0x84B7, 0xB873,
         0xBCE6, 0xBD60, 0xB87C, 0xB88D)
# ★ **kolo třesu a kolo rozpadu** jsou ty dvě, kterých je hodně: 128 a 512
LOOP_TRAPS = (0x840E, 0x8491)
# která past se ozvala; `> $0335 n` napíše monitor **před** výpisem (§31)
STOP_MARK = 0x0335

# ★ **Klávesnice je harness, přesně jako joystick.** Skóre, které se vejde do
# síně slávy, pustí `$BCE6` a to **čeká na pět znaků jména** (§33) — bez nich
# záznam skončí uprostřed. `$BEA5` je čtení matice přes `$DC00`/`$DC01`,
# takže se podstrčí stejně, jako `traceplayer` podstrkuje `$DC00` agentovi:
# obě volání `JSR $BEA5` se přepíšou na stub, který bere znaky z tabulky.
#
# ★ **Vrací se screen code, ne kód klávesy**: `$BEF0` je překladová tabulka
# 8 × 8 a hra to, co z ní vypadne, ukládá rovnou na obrazovku (`$BD21`).
# `$FF` je „nic", `$00` `RETURN`, `$01` `INST/DEL` a `$F0` `RUN/STOP`.
KEY_SITES = (0xB890, 0xBD0E)
KEY_STUB = 0x0380
KEY_TABLE = 0x03A0
KEY_INDEX = 0x0336
KEY_LIMIT = 0x3F
# `LDX index / CPX #limit / BEQ / INC index / LDA table,X / RTS`
# ★ Pořadí není náhodné: `LDA abs,X` musí být **poslední**, protože volající
# se hned ptá na příznaky (`$BD11 BEQ`) a `INC` by je přebilo.
KEY_CODE = (0xAE, KEY_INDEX & 0xFF, KEY_INDEX >> 8,
            0xE0, KEY_LIMIT,
            0xF0, 0x03,
            0xEE, KEY_INDEX & 0xFF, KEY_INDEX >> 8,
            0xBD, KEY_TABLE & 0xFF, KEY_TABLE >> 8,
            0x60)
# jméno, které harness „napíše" — screen codes sady šachty, `a` = `$71` (§14)
KEY_NAME = (0x71, 0x77, 0x75, 0x7E, 0x84)          # agent

# ★ **A `JSR $BDFB` se vyřadí, protože pod tímhle harnessem nedoběhne.**
# `$BDFB` je opravdový `SAVE` síně slávy na jednotku 8 (§33). V emulátoru se
# na něm běh **zasekne**: hra si pro sebe přepsala `$DD00` (banka VIC leží ve
# stejném registru jako sériová sběrnice), NMI i `$D01A`, a KERNAL už se
# k jednotce nedostane — změřeno, disketa po záznamu **nezměněná** a log
# končí uvnitř `$BDFB`.
#
# Vyřadit se to smí ze dvou důvodů: je to **jediné místo konce hry, které
# nesahá na nic měřeného** (tabulka `$CF00` je v tu chvíli hotová, past
# `$BD60` je před ním), a v přepisu ho **nic nezastupuje** — síň slávy
# remaku je `localStorage`, ne disketa. Bez vyřazení se neozvou poslední dvě
# pasti a záznam nemá konec.
SAVE_CALL = 0xBD60

# (jméno, semínko, rozjezd, hodiny, (dílky, hesla, skládačky))
# ★ **Vybrané tak, aby každá větev tabule padla aspoň jednou**: vypršení
# času (hodiny na šesté → „mission terminated" a žádná řeč), dokončená mise
# (hodiny jinde → věta 0 a „mission complete"), prázdná hra (nula všude,
# tedy `$BAFB` s potlačenými nulami), hra s nálezy ve všech třech
# počitadlech (aby se změřily i ty tři rovnice) a skóre, které přebije **i tu
# nejvyšší** položku síně slávy (tedy `$BC38`, „this surpasses…").
#
# ★ **A polovina sady je v místnosti, polovina v šachtě**, protože `$83F5`
# se na to ptá: v šachtě (`$1A` = 0) rozsvítí sprajty a pustí `$731C`, což je
# **kapesní počítač** (`$39F1`, M5 část 2) a v přepisu zatím není. Záznamy
# `endroom*` mají `$1A` = 1 a jdou celé; u těch v šachtě `matchend` spodní
# panel do srovnání nebere a říká to.
ROOM = 'right:200'
SET_RUNS = (
    ('endtime42', '42', 'right:60', (0x05, 0x59, 0x57), (0, 0, 0)),
    ('endtimefull42', '42', 'right:60', (0x05, 0x59, 0x57), (0x24, 0x07, 0x09)),
    ('endroom42', '42', ROOM, (0x05, 0x59, 0x57), (0x11, 0x03, 0x02)),
    ('endroomfull42', '42', ROOM, (0x05, 0x59, 0x57), (0x24, 0x07, 0x09)),
    ('endroom5A', '5A', ROOM, (0x05, 0x59, 0x57), (0x06, 0x01, 0x00)),
    # ★ **dvanáctá hodina**: `$BA60` ji přepisuje na nulu, bez čeho by
    # odčítání vteřin v BCD vyšlo záporně. Tady se čas nevypršel — hodiny
    # zůstaly na dvanácté a konec hry se pustí `$43` = `$FF`, jako by ho
    # pustila řídicí místnost (`$AB64`).
    ('endwin42', '42', 'right:60', None, (0x24, 0x09, 0x09)),
    ('endwinroom42', '42', ROOM, None, (0x24, 0x09, 0x09)),
)


def record(a):
    os.makedirs(a.dir, exist_ok=True)
    script = parse_script(a.script) if a.script else []
    lead = parse_script(a.lead) if a.lead else []
    total = sum(n for _, _, n in script)
    if total > MAX_FRAMES:
        raise SystemExit('záznam má %d snímků, harness jich unese %d'
                         % (total, MAX_FRAMES))
    base = os.path.join(a.dir, a.name)

    # ★ **Vlastní kopie diskety.** Síň slávy se ukládá `SAVE`m do souboru
    # `HI` (§33), takže záznam, ve kterém se skóre vejde do tabulky, by
    # **zapsal do referenčního obrazu** — a ten je podklad (`sources/`), ne
    # pracovní soubor. A vedle toho by si příští běh to `HI` našel a začal
    # s neprázdnou tabulkou.
    image = '%s.d64' % base
    shutil.copyfile(a.image, image)

    table = [0x7F]*256
    frame = 0
    for _token, value, frames in script:
        for _ in range(frames):
            table[frame] = value
            frame += 1

    e = C64Emu(image, fast=a.fast)
    e.cmd('break exec $%04x' % GAME_ENTRY)
    e.go()
    e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, int(a.entropy, 16)))
    e.cmd('del 1')
    e.brk(GAME_IRQ)
    e.ignore(1, a.start * IRQ_PER_FRAME)
    e.go()
    e.cmd('del 1')
    e.cmd('bank ram')
    for at in range(0, 256, 16):
        e.cmd('> %04x %s' % (TABLE + at, ' '.join('%02x' % x for x in table[at:at+16])))
    e.cmd('> %04x %s' % (STUB, ' '.join('%02x' % x for x in STUB_CODE)))
    e.cmd('> %04x %s' % (TICK_STUB, ' '.join('%02x' % x for x in TICK_CODE)))
    e.cmd('> %04x %s' % (LOOP_STUB, ' '.join('%02x' % x for x in LOOP_CODE)))
    e.cmd('> %04x 20 %02x %02x' % (TICK_SITE, TICK_STUB & 0xFF, TICK_STUB >> 8))
    for site in LOOP_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, LOOP_STUB & 0xFF, LOOP_STUB >> 8))
    e.cmd('break exec $%04x' % FRAME_TICK)
    for _token, value, frames in lead:
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, value))
        e.ignore(1, max(0, frames - 1))
        e.go()
    for site in JOY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, STUB & 0xFF, STUB >> 8))
    e.cmd('> %04x %02x' % (COUNTER, 0xFE if lead else 0xFF))
    e.cmd('> %04x ff' % STOP_MARK)

    keys = [0xFF]*(KEY_LIMIT + 1)
    keys[2:2 + len(KEY_NAME)] = list(KEY_NAME)
    for i in range(2 + len(KEY_NAME), KEY_LIMIT + 1):
        keys[i] = 0xF0                                 # `RUN/STOP` = nová hra
    e.cmd('> %04x %s' % (KEY_STUB, ' '.join('%02x' % x for x in KEY_CODE)))
    for at in range(0, KEY_LIMIT + 1, 16):
        e.cmd('> %04x %s' % (KEY_TABLE + at,
                             ' '.join('%02x' % x for x in keys[at:at+16])))
    e.cmd('> %04x 00' % KEY_INDEX)
    for site in KEY_SITES:
        e.cmd('> %04x 20 %02x %02x' % (site, KEY_STUB & 0xFF, KEY_STUB >> 8))
    e.cmd('> %04x ea ea ea' % SAVE_CALL)              # `JSR $BDFB` → tři `NOP`

    # ★ **Počitadla nálezů jsou stav, ne kód.** Skóre se počítá z `$D6`–`$D8`
    # a nasbírat dvaatřicet dílků chůzí po pevnosti není měření konce hry, je
    # to měření prohledávání (§27, to má vlastní nástroj). Do záznamu se
    # proto dosadí — a `matchend` dostane tutéž trojici.
    pieces, passwords, puzzles = a.found
    e.cmd('> %04x %02x' % (FOUND_PIECES, pieces))
    e.cmd('> %04x %02x' % (FOUND_PASSWORDS, passwords))
    e.cmd('> %04x %02x' % (SOLVED_PUZZLES, puzzles))

    # ★ **Hodiny taky.** `--clock` je nastaví tak, aby přetečení přišlo samo
    # (5:59:57 → tři vteřiny, tedy 180 snímků); bez `--clock` se konec pustí
    # rovnou `$43` = `$FF`, což je to, co udělá řídicí místnost.
    if a.clock:
        hours, minutes, seconds = a.clock
        e.cmd('> %04x 00' % CLOCK_FRAMES)
        e.cmd('> %04x %02x' % (CLOCK_SECONDS, seconds))
        e.cmd('> %04x %02x' % (CLOCK_MINUTES, minutes))
        e.cmd('> %04x %02x' % (CLOCK_HOURS, hours))
    else:
        e.cmd('> %04x ff' % 0x43)

    e.cmd('bank ram')
    e.bsave('%s_ram.bin' % base, 0x0000, 0xFFFF)
    e.cmd('bank io')
    e.bsave('%s_color.bin' % base, 0xD800, 0xDBFF)
    e.bsave('%s_vic.bin' % base, 0xD000, 0xD02E)
    e.cmd('bank ram')

    parts, bank = [], 'ram'
    for _name, lo, hi, want in DUMPS:
        if want != bank:
            parts.append('bank %s' % want)
            bank = want
        parts.append('m %04x %04x' % (lo, hi))
    if bank != 'ram':
        parts.append('bank ram')
    dump = '; '.join(parts)
    e.cmd('del')
    traps = TRAPS if a.stops == 'all' else tuple(x for x in TRAPS if x not in LOOP_TRAPS)
    # ★ **Číslo checkpointu a číslo pasti nejsou totéž.** Monitor čísluje
    # checkpointy po `del` znovu od jedné, a `--stops tail` jich staví méně;
    # do `$0335` se ale musí dostat **pořadí v `TRAPS`**, jinak by měřidlo
    # nepoznalo, která past se ozvala.
    number = 0
    for i, at in enumerate(TRAPS):
        if at not in traps:
            continue
        number += 1
        e.brk(at)
        e.on_break(number, '> %04x %02x; %s; g' % (STOP_MARK, i, dump))
    e.go()

    # ★ **Na konec se musí přidat hodně.** Když se skóre vejde do síně slávy,
    # `$BD60` pustí `$BDFB`, a to je opravdový `SAVE` na opravdovou jednotku
    # 1541 s cyklově přesnou emulací: zápis, `S0:HI` a `R0:HI=HI2` stojí
    # **desítky milionů cyklů**. S rozpočtem na šest set snímků záznam končil
    # uprostřed ukládání a poslední dvě pasti se neozvaly.
    cycles = (150_000_000
              + (a.start + sum(n for _, _, n in lead) + total + 6000)*CYCLES_PER_FRAME_PAL)
    e.run(cycles=cycles, screenshot='%s.png' % base, monlog='%s.log' % base,
          moncmds='%s.cmds' % base, timeout=a.timeout)

    stops = parse_log('%s.log' % base, [(n, lo, hi) for n, lo, hi, _ in DUMPS])
    # ★ Záznam se uzavře **novou hrou**: `$B897` skočí na `$38D2` a kdyby
    # emulátor jel dál, celý konec by se mohl ozvat znovu. Bere se ten první,
    # tedy vše až po poslední zastávku `$B88D`.
    kept, last = [], TRAPS.index(0xB88D)
    for f in stops:
        kept.append(f)
        if f['harness'][STOP_MARK - 0x0320] == last:
            break
    index = {
        'name': a.name, 'script': a.script, 'lead': a.lead,
        'entropy': '%02X' % int(a.entropy, 16), 'start': a.start,
        'stops': a.stops,
        'clock': (['%02X' % x for x in a.clock] if a.clock else None),
        'found': {'pieces': '%02X' % pieces, 'passwords': '%02X' % passwords,
                  'puzzles': '%02X' % puzzles},
        'ram': os.path.relpath('%s_ram.bin' % base),
        'color': os.path.relpath('%s_color.bin' % base),
        'vic': os.path.relpath('%s_vic.bin' % base),
        'dumps': [{'name': n, 'from': '$%04X' % lo, 'to': '$%04X' % hi, 'bank': b}
                  for n, lo, hi, b in DUMPS],
        'segments': [{'token': t, 'value': '%02X' % v, 'frames': n} for t, v, n in script],
        'traps': ['$%04X' % x for x in TRAPS],
        'stopMark': '$%04X' % STOP_MARK,
        'keys': ['%02X' % x for x in KEY_NAME],
        'saveStubbed': '$%04X' % SAVE_CALL,
        'trapOf': [f['harness'][STOP_MARK - 0x0320] for f in kept],
        'frames': [{k: ''.join('%02x' % b for b in f[k]) for k in f} for f in kept],
    }
    json.dump(index, open('%s.json' % base, 'w'), indent=1)
    marks = set(index['trapOf'])
    ok = last in marks and TRAPS.index(0xB873) in marks
    score = ''
    if kept:
        s = kept[-1]['zp'][SCORE:SCORE + 3]
        score = '%02X%02X%02X' % (s[2], s[1], s[0])
    print('traceend %s: %d zastávek, %d pastí, skóre %s, %s'
          % (a.name, len(kept), len(marks), score,
             'ok' if ok else 'CHYBÍ — hra do tabule nedošla?'))
    return 0 if ok else 1


def record_set(a):
    from concurrent.futures import ThreadPoolExecutor

    def one(item):
        name, seed, lead, clock, found = item
        args = copy.copy(a)
        args.set, args.name, args.entropy = False, name, seed
        args.lead, args.clock, args.found = lead, clock, found
        return name, record(args)

    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        res = list(pool.map(one, SET_RUNS))
    bad = [n for n, rc in res if rc]
    print('traceend --set: %d záznamů, %s'
          % (len(res), 'hotovo' if not bad else 'NEDOBĚHLO: ' + ', '.join(bad)))
    return 1 if bad else 0


def triple(text):
    if not text:
        return None
    return tuple(int(x, 16) for x in text.split(':'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--script', default='')
    ap.add_argument('--lead', default='right:60')
    ap.add_argument('--name', default='endtime42')
    ap.add_argument('--dir', default='build/end')
    ap.add_argument('--entropy', default='42', metavar='HEX')
    ap.add_argument('--clock', type=triple, default=(0x05, 0x59, 0x57),
                    metavar='H:M:S', help='hodiny v BCD; prázdné = pustit `$43`')
    ap.add_argument('--found', type=triple, default=(0, 0, 0),
                    metavar='PIECES:PASS:PUZZLES')
    ap.add_argument('--stops', choices=('all', 'tail'), default='all',
                    help='`tail` vynechá kola třesu a rozpadu')
    ap.add_argument('--start', type=int, default=14000)
    ap.add_argument('--timeout', type=int, default=1800)
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--set', action='store_true', help='celá sada (akceptace M5)')
    ap.add_argument('--jobs', type=int, default=4)
    a = ap.parse_args()
    return record_set(a) if a.set else record(a)


if __name__ == '__main__':
    sys.exit(main())
