// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * **Konec hry** — `$83EA`, `$B77C` a síň slávy `$BBF7`
 * (`sources/docs/disasm_notes.md` §33).
 *
 * ★ **Konec hry je v programu jeden a vedou do něj dvě cesty**, `JMP $B77C`
 * na `$84BF` (vypršel čas) a na `$AB64` (řídicí místnost) — a nikde jinde,
 * což si `tools/dumpend.py` ověřuje průchodem celého obrazu. Pozná se
 * **hodinami**: stojí-li `$D4` na šesté, je to čas, a pak se místo „mission
 * complete" vypíše „mission terminated" a **nic se neřekne**; jinak je to
 * dokončená mise a `$B86E` řekne **větu 0**.
 *
 * Skládá se ze čtyř věcí, a každá má jinou jednotku:
 *
 * 1. `$83F2` — **třes a rozpad**: 128 kol třesu (v každém tři čísla
 *    z míchačky do `$D011`/`$D016`) a 128 kol rozpadu (šestnáct znaků `$53`
 *    na náhodných místech). Jednotkou je **kolo**, ne snímek: `$8401` udělá
 *    `SEI` a `CLI` už nepřijde, takže `$7F6B` by se nikdy nevrátil a `$9787`
 *    uvnitř je **prázdná smyčka**, ne čekání na obraz.
 * 2. `$B77C` — **tabule**: tři rutiny rámečků nad kreslicí polohou `$10`
 *    a sedm nadpisů, jeden z nich vyměnitelný.
 * 3. `$B9FB` — **skóre**, celé v BCD na `$D9`–`$DB`, a každý řádek tabule je
 *    malá rovnice `n × 100 = n00`.
 * 4. `$BBF7` — **síň slávy**: patnáct položek po osmi bajtech na `$CF00`,
 *    šestnáctá je přetlakový koš, a vejde-li se skóre, zadává se jméno.
 *
 * ## Čeho se to nedotýká, a proč
 *
 * ★ **`$731C` ne** (`$83FE`): vypršel-li čas **v šachtě** (`$1A` = 0),
 * rozsvítí originál sprajty a překreslí spodní panel, a ten panel je
 * **kapesní počítač** — tutéž rutinu pouští rozběh hry na `$39F1`. Patří do
 * M5 části 2. Přepis se tedy v šachtě chová, jako by ten panel zůstal, jak
 * byl, a `matchend` spodní deset řádků u záznamů ze šachty do srovnání
 * nebere a říká to. **V místnosti se nic nevynechává.**
 *
 * ★ **`$BDFB` ne** (`$BD60`): to je opravdový `SAVE` síně slávy do souboru
 * `HI` na jednotce 8. V remaku ji drží hlavní vlákno (`localStorage`), takže
 * tady se jen vrátí, co se do tabulky uložilo, a model si s tím poradí sám.
 * Pod harnessem `tools/traceend.py` se to navíc **zasekne**, takže je to
 * vyřazené i v záznamu — a je to jediné vyřazené místo.
 *
 * ★ **Klávesnice je vstup, ne kód.** `$BEA5` čte matici přes `$DC00`/`$DC01`
 * a vrací **screen code sady šachty** (tabulka `$BEF0`), `$FF` je „nic",
 * `$00` `RETURN`, `$01` `INST/DEL` a `$F0` `RUN/STOP`. Přepis dostane jméno
 * hotové, jako `$97F1` dostává joystick.
 */

/** nultá stránka, na kterou se konec hry ptá (`RAMUse.md`, §19, §33) */
var EG_PLACE = 0x1A, EG_DEATH = 0x43;
var EG_DRAW = 0x10, EG_COLOR_DRAW = 0x14, EG_PTR = 0x18;
var EG_SECONDS = 0xD2, EG_MINUTES = 0xD3, EG_HOURS = 0xD4;
var EG_PIECES = 0xD6, EG_PASSWORDS = 0xD7, EG_PUZZLES = 0xD8;
var EG_SCORE = 0xD9, EG_WORK = 0xE4, EG_DIGITS = 0xE7;
/** registry, na které konec hry sahá */
var EG_SPENA = 0xD015, EG_SCROLY = 0xD011, EG_SCROLX = 0xD016, EG_VMCSB = 0xD018;
var EG_EXTCOL = 0xD020, EG_BGCOL0 = 0xD021, EG_BGCOL1 = 0xD022, EG_BGCOL2 = 0xD023;
/** obrazovka hry a barvy (§6) */
var EG_SCREEN = 0x4000, EG_COLOR = 0xD800, EG_CELLS = 1000;

/** ★ `$840C` a `$848F`: obojí `LDX #$7F`, tedy **128 kol** */
var EG_SHAKE_ROUNDS = 0x80, EG_DISSOLVE_ROUNDS = 0x80;
/** rozpad: čtyři průchody v kole (`$8494 LDA #$03`) a stránky `$43`…`$40` */
var EG_DISSOLVE_PASSES = 4, EG_DISSOLVE_TOP = 0x43, EG_DISSOLVE_BOTTOM = 0x40;
/** čím se plocha zalije (`$847A`), čím se maže (`$84A4`) a jakou barvou (`$84D6`) */
var EG_FILL = 0x52, EG_BLANK = 0x53, EG_FILL_COLOR = 9;

/** která věta se kde řekne (§33, `data/speech.json`) */
var EG_WORD_TIME_UP = 5, EG_WORD_GAME_OVER = 0;
/** hodina, na které hra končí časem (`$83E1`) */
var EG_LAST_HOUR = 0x06, EG_NOON = 0x12;

/** kde se co kreslí (`$B7BE`, `$B81B`, `$BA03`, `$BC3A`, `$BC70`, `$B87C`) */
var EG_AT_FRAME = 0x4000, EG_AT_LABELS = 0x42D2, EG_AT_SCORE = 0x4040;
var EG_AT_SURPASS = 0x420A, EG_AT_SURPASS2 = 0x4232, EG_AT_SURPASS_SCORE = 0x423A;
var EG_AT_FAME = 0x42F9, EG_AT_PROMPT = 0x42AA, EG_AT_NAMES = 0x4300;

/** síň slávy: patnáct zobrazených položek po osmi bajtech, šestnáctá je koš */
var EG_FAME_AT = 0xCF00, EG_FAME_SHOWN = 15, EG_FAME_STRIDE = 8;
var EG_FAME_NAME = 3, EG_FAME_NAME_LENGTH = 5, EG_FAME_BLANK = 0xDC;

/** znaky, kterými se zadává jméno (`$BCFD`, `$BD42`) */
var EG_CURSOR = 0xDB, EG_ERASED = 0xAF;
/** a klávesy, na které se konec hry ptá (`$BEF0`) */
var EG_KEY_NONE = 0xFF, EG_KEY_RETURN = 0x00, EG_KEY_DELETE = 0x01,
    EG_KEY_RESTORE = 0xF0;

/** číslice sady šachty: `$8B` je nula (`$BB36 ADC #$8B`) */
var EG_DIGIT_BASE = 0x8B;

function egLoad(m, a) { return rbLoad(m, a); }
function egStore(m, a, v) { rbStore(m, a, v); }
function egByte(v) { return v & 0xFF; }
function egWord(m, a) { return egLoad(m, a) | (egLoad(m, a + 1) << 8); }
function egSetWord(m, a, v) { egStore(m, a, v & 0xFF); egStore(m, a + 1, (v >> 8) & 0xFF); }

/** kde leží tabulka konce hry v paměti stroje, a jak dlouhá je */
function egTable(m, data, name) {
  var i;
  for (i = 0; i < data.tables.length; i++) {
    if (data.tables[i].addr === name) { return data.tables[i].values; }
  }
  return null;
} // egTable

/* --------------------------------------------------------- BCD, jak to dělá SED */

/** `ADC` v `SED`, bajt po bajtu jako 6502 */
function egBcdAdd(a, b, carry) {
  var lo = (a & 0x0F) + (b & 0x0F) + (carry ? 1 : 0), hi = (a >> 4) + (b >> 4);
  if (lo > 9) { lo -= 10; hi++; }
  var c = 0;
  if (hi > 9) { hi -= 10; c = 1; }
  return {value: ((hi << 4) | lo) & 0xFF, carry: c};
} // egBcdAdd

/** `SBC` v `SED` — a `SEC` před ním, protože tak to originál dělá všude */
function egBcdSub(a, b) {
  var lo = (a & 0x0F) - (b & 0x0F), hi = (a >> 4) - (b >> 4), c = 1;
  if (lo < 0) { lo += 10; hi--; }
  if (hi < 0) { hi += 10; c = 0; }
  return {value: ((hi << 4) | lo) & 0xFF, carry: c};
} // egBcdSub

/**
 * `$BB3F`/`$BB48` — přenos do skóre, a `$BB57`/`$BB60` totéž do pracovního
 * `$E4`–`$E6`. Je to jedna rutina se dvěma vstupy: `$BB3F` přičte do
 * nejnižšího bajtu, `$BB48` **do prostředního**, tedy do stovek — a právě
 * proto je „přičti jedničku" **sto bodů** (§33).
 *
 * @param {Object} m - Stroj.
 * @param {number} at - `$D9` pro skóre, `$E4` pro pracovní trojici.
 * @param {number} a - Co přičíst, v BCD.
 * @param {number} from - 0 nejnižší bajt, 1 prostřední.
 */
function egAddBcd(m, at, a, from) {
  var i = from, carry = 0, value = a;
  for (; i < 3; i++) {
    var sum = egBcdAdd(egLoad(m, at + i), value, carry);
    egStore(m, at + i, sum.value);
    if (!sum.carry) { return; }
    // ★ přenos není `+1` na další bajt naslepo: originál pokračuje
    // `LDA #$01 / CLC / ADC $DA`, tedy přičte **jedničku v BCD**
    value = 0x01; carry = 0;
  }
} // egAddBcd

/* ------------------------------------------------ kreslicí poloha, `$AF17`… */

/** `$AF24` — nová kreslicí poloha; `$10`/`$11` je obrazovka, `$14`/`$15` barvy */
function egSetDraw(m, at) {
  egSetWord(m, EG_DRAW, at);
  egStore(m, EG_COLOR_DRAW, at & 0xFF);
  // ★ `$AF24` sází **jen nízký bajt** `$14` a vysoký zvedá jen při přenosu,
  // takže `$15` si nese, co v něm bylo; tabule ho přepíše na `$B81B`
} // egSetDraw

/**
 * `$AF24` — posun kreslicí polohy o `delta` bajtů. ★ Není to „o řádek":
 * `$AF2F` přičte 40, `$AF37` 80, `$AF17` odečte 40, `$AF1F` přičte 240
 * a `$AF0F` odečte 160 — a **`$11` i `$15` se zvedají jen přenosem**, takže
 * se barevná poloha veze s obrazovou o stejný posun.
 *
 * @param {Object} m - Stroj.
 * @param {number} delta - O kolik bajtů (může být negativní).
 */
function egMoveDraw(m, delta) {
  var low = egLoad(m, EG_DRAW), sum = low + delta;
  egStore(m, EG_DRAW, sum & 0xFF);
  egStore(m, EG_COLOR_DRAW, sum & 0xFF);
  if (delta >= 0) {
    if (sum > 0xFF) {
      egStore(m, EG_DRAW + 1, egByte(egLoad(m, EG_DRAW + 1) + 1));
      egStore(m, EG_COLOR_DRAW + 1, egByte(egLoad(m, EG_COLOR_DRAW + 1) + 1));
    }
  } else if (sum < 0) {
    // `$AEF0` — odčítání jde přes vlastní konec, ale stejným způsobem
    egStore(m, EG_DRAW + 1, egByte(egLoad(m, EG_DRAW + 1) - 1));
    egStore(m, EG_COLOR_DRAW + 1, egByte(egLoad(m, EG_COLOR_DRAW + 1) - 1));
  }
} // egMoveDraw

function egDrawAt(m) { return egWord(m, EG_DRAW); }
function egColorAt(m) { return egWord(m, EG_COLOR_DRAW); }

/* ------------------------------------------------------- `$83F2`: třes a rozpad */

/**
 * `$83F2`–`$8407` — hra se rozhodla skončit.
 *
 * ★ **Rámeček zbělá**, a je to **jediné místo celé hry, kde `$D020` není
 * nula** (§12 pozn. 3; změřeno `$F0` v místnosti, v šachtě i za jízdy).
 * A hned za tím se řekne **věta 5**.
 *
 * @param {Object} m - Stroj.
 * @returns {Object} `speech`: kterou větu konec hry řekl, nebo `undefined`.
 */
function egBegin(m) {
  var out = {};
  // ★ `$83F5`: **v šachtě** se rozsvítí sprajty a překreslí panel (`$731C`,
  // kapesní počítač, M5 část 2). V místnosti se nedělá nic.
  if (!egLoad(m, EG_PLACE)) {
    egStore(m, EG_SPENA, 0x8F);                      // `$83F9`
    out.pocketComputer = 1;                          // `$83FE JSR $731C` — nepřepsané
  }
  egStore(m, EG_EXTCOL, 0x01);                       // `$8402`
  out.speech = EG_WORD_TIME_UP;                      // `$8407 LDX #$05 / JSR $BF51`
  return out;
} // egBegin

/**
 * `$840E` — **jedno kolo třesu**, a jsou v něm **tři** čísla z míchačky:
 * první dá spodní tři bity do `$D011` (svislý posun rastru), druhé do
 * `$D016` (vodorovný), a třetí se porovná s číslem kola — a podle toho se
 * zvedne nebo shodí **bit 4 `$D011`**, tedy 24 nebo 25 řádků.
 *
 * ★ Právě to poslední dělá z třesu **něco měřitelného**: kolo `$7F` má
 * `$7F` možností, jak hodit hlavu, kolo nula žádnou, takže třes k nule
 * **utichá** — a sedí-li registry po kole, sedí i všechna tři volání
 * míchačky v tom kole (§8).
 *
 * @param {Object} m - Stroj.
 * @param {number} round - Číslo kola, `$7F` dolů k nule (to je `X`).
 * @param {function(): number} entropy - Míchačce.
 */
function egShakeRound(m, round, entropy) {
  var a = egRandom(m, entropy) & 0x07;                       // `$840E`
  egStore(m, EG_WORK, a);                                    // `$8413`
  egStore(m, EG_SCROLY, (egLoad(m, EG_SCROLY) & 0xF8) | a);  // `$8415`
  a = egRandom(m, entropy) & 0x07;                           // `$841F`
  egStore(m, EG_WORK, a);                                    // `$8424`
  egStore(m, EG_SCROLX, (egLoad(m, EG_SCROLX) & 0xF8) | a);  // `$8426`
  // `$8430 JSR $9787` — prázdná smyčka, na stavu se neprojeví
  // ★ a `$8433 STX $E4` **nechá v `$E4` číslo kola**, takže to měřidlo vidí
  egStore(m, EG_WORK, round);                                // `$8433`
  var r = egRandom(m, entropy) & 0x7F;                       // `$8435`
  var rows = egLoad(m, EG_SCROLY) & 0xEF;                    // `$843C`
  // `CMP $E4` nastaví carry, když `r >= round`; `BCS` pak `ORA #$10`
  // **přeskočí**, takže vysoká náhoda znamená 24 řádků
  if (r < round) { rows |= 0x10; }                           // `$8443`
  egStore(m, EG_SCROLY, rows);                               // `$8445`
} // egShakeRound

/**
 * `$8452`–`$848C` — obraz se zhasne, plocha se zalije znakem `$52` a barvou
 * devět a zase rozsvítí. ★ A **sprajty zhasnou úplně** (`$8470`), takže
 * agent, roboti ani koule už na tabuli nejsou.
 * @param {Object} m - Stroj.
 */
function egBlank(m) {
  egStore(m, EG_SCROLY, egLoad(m, EG_SCROLY) | 0x10);        // `$8453`
  egStore(m, EG_SCROLY, egLoad(m, EG_SCROLY) & 0xEF);        // `$8468` — obraz zhasne
  egStore(m, EG_SPENA, 0x00);                                // `$8470`
  egStore(m, EG_VMCSB, 0x04);                                // `$8475`
  egFillScreen(m, EG_FILL);                                  // `$847A JSR $84C4`
  egFillColor(m, EG_FILL_COLOR);                             // `$847F JSR $84D6`
  egStore(m, EG_BGCOL0, 0x00);                               // `$8482`
  egStore(m, EG_SCROLY, egLoad(m, EG_SCROLY) | 0x10);        // `$8487` — a rozsvítí
} // egBlank

/**
 * `$84C4` — plocha se zalije jedním znakem, a je to **čtyři smyčky po 256**,
 * tedy `$4000`–`$43FF` **i s ukazateli sprajtů** na `$43F8`. To není
 * nedopatření: sprajty jsou v tu chvíli zhasnuté.
 * @param {Object} m - Stroj.
 * @param {number} value - Znak.
 */
function egFillScreen(m, value) {
  for (var i = 0; i < 0x400; i++) { egStore(m, EG_SCREEN + i, value); }
} // egFillScreen

/** `$84D6` — a barvy stejně, celé `$D800`–`$DBFF` */
function egFillColor(m, value) {
  for (var i = 0; i < 0x400; i++) { egStore(m, EG_COLOR + i, value); }
} // egFillColor

/**
 * `$8498` — **jedno kolo rozpadu**. V kole se čtyřikrát projde od stránky
 * `$43` dolů ke `$40` a na každé se jedním číslem z míchačky vybere bajt,
 * který se přepíše na `$53` — tedy **šestnáct znaků a šestnáct volání
 * míchačky** na kolo, 2 048 za celý rozpad.
 *
 * ★ Plocha se tím **nevymaže celá** (je to náhoda bez paměti: po 2 048
 * hodech do 1 024 míst zbude něco přes třetinu), a proto ji `$84BC`
 * nakonec zalije natvrdo.
 *
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Míchačce.
 */
function egDissolveRound(m, entropy) {
  // ★ počitadlo průchodů je `$E4` a **zůstane v něm `$FF`** (`$84B0 DEC $E4`
  // shodí trojku pod nulu), takže to měřidlo na každé zastávce vidí
  egStore(m, EG_WORK, EG_DISSOLVE_PASSES - 1);               // `$8494 LDA #$03`
  for (var pass = 0; pass < EG_DISSOLVE_PASSES; pass++) {
    for (var page = EG_DISSOLVE_TOP; page >= EG_DISSOLVE_BOTTOM; page--) {
      var y = egRandom(m, entropy);                          // `$84A0`
      egStore(m, (page << 8) | y, EG_BLANK);                 // `$84A6`
    }
    egStore(m, EG_WORK, egByte(egLoad(m, EG_WORK) - 1));     // `$84B0`
  }
} // egDissolveRound

/** `$84B7` — rámeček zčerná a plocha se zalije `$53`; pak `JMP $B77C` */
function egFinishDissolve(m) {
  egStore(m, EG_EXTCOL, 0x00);                               // `$84B7`
  egFillScreen(m, EG_BLANK);                                 // `$84BC JSR $84C2`
} // egFinishDissolve

/** míchačka `$82D6`, jak ji volá celá hra (§8) */
function egRandom(m, entropy) {
  return fgRandom(m.mem, entropy());
} // egRandom

/* -------------------------------------------------------- `$B77C`: tabule */

/**
 * `$B989` — **horní hrana okna**: offsety 1 až 37 dostanou znak `$CA`
 * (`DEY`/`BNE`, takže **nulový offset ne**) a do deseti offsetů `$B9AA` se
 * pak posadí rohy a výstupky z `$B9A0`.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egFrameTop(m, data) {
  var at = egDrawAt(m), i;
  for (var y = 0x25; y >= 1; y--) { egStore(m, at + y, 0xCA); }   // `$B98D`
  var chars = egTable(m, data, '$B9A0'), spots = egTable(m, data, '$B9AA');
  for (i = 9; i >= 0; i--) { egStore(m, at + spots[i], chars[i]); }
} // egFrameTop

/** `$B9C2` — prostředek: čtyři znaky `$B9D0` na první čtyři offsety `$B9AA` */
function egFrameMiddle(m, data) {
  var at = egDrawAt(m);
  var chars = egTable(m, data, '$B9D0'), spots = egTable(m, data, '$B9AA');
  for (var i = 3; i >= 0; i--) { egStore(m, at + spots[i], chars[i]); }
} // egFrameMiddle

/**
 * `$B9D4` — **spodní hrana**: offsety `$2A` až `$4D` dostanou `$D3`, tedy
 * **dva řádky**, a do čtrnácti offsetů `$B9B4` se posadí znaky `$B9ED`.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egFrameBottom(m, data) {
  var at = egDrawAt(m), i;
  for (var y = 0x4D; y >= 0x2A; y--) { egStore(m, at + y, 0xD3); }   // `$B9D8`
  var chars = egTable(m, data, '$B9ED'), spots = egTable(m, data, '$B9B4');
  for (i = 13; i >= 0; i--) { egStore(m, at + spots[i], chars[i]); }
} // egFrameBottom

/**
 * `$B77C`–`$B818` — **rámečky tabule**. Je to jedenáct oken poskládaných ze
 * tří rutin a posunů kreslicí polohy; přepis je v tom pořadí, ve kterém je
 * originál volá, protože okna se **překrývají** a poslední zápis rozhoduje.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egFrames(m, data) {
  egStore(m, EG_SPENA, 0x00);                                // `$B788`
  egFillScreen(m, EG_BLANK);                                 // `$B78D`
  egFillColor(m, EG_FILL_COLOR);                             // `$B790`
  egStore(m, EG_VMCSB, 0x02);                                // `$B793` — sada šachty
  egStore(m, EG_SCROLY, 0x1B);                               // `$B798`
  egStore(m, EG_SCROLX, 0x18);                               // `$B79D`
  egStore(m, EG_BGCOL0, 0x00);                               // `$B7AD`
  egStore(m, EG_BGCOL1, 0x03);                               // `$B7B2`
  egStore(m, EG_BGCOL2, 0x0E);                               // `$B7B7`
  egSetDraw(m, EG_AT_FRAME);                                 // `$B7BC`
  var x;
  for (x = 1; x >= 0; x--) {                                 // `$B7C6`
    egFrameTop(m, data); egMoveDraw(m, 40);
    egFrameMiddle(m, data); egMoveDraw(m, 40);
    egFrameBottom(m, data); egMoveDraw(m, 80);
  }
  egFrameTop(m, data); egMoveDraw(m, 40);                    // `$B7DF`
  egFrameBottom(m, data); egMoveDraw(m, 80);
  egFrameTop(m, data); egMoveDraw(m, 40);                    // `$B7EB`
  egFrameMiddle(m, data); egMoveDraw(m, 40);
  egFrameMiddle(m, data); egMoveDraw(m, 40);
  egFrameBottom(m, data); egMoveDraw(m, 80);
  egFrameTop(m, data); egMoveDraw(m, 40);                    // `$B803`
  for (x = 5; x >= 0; x--) {                                 // `$B80B`
    egFrameMiddle(m, data); egMoveDraw(m, 40);
  }
  egFrameBottom(m, data);                                    // `$B818`
} // egFrames

/**
 * `$B829`–`$B866` — **sedm nadpisů, odspodu nahoru**. Ukazatel je v `$B96D`,
 * délka v `$B97B` a o kolik řádků se po nadpisu jde dál v `$B982`; ★ za
 * `X` = 4 se ale při hodinách na šesté vezme místo „mission complete" text
 * `$B94A`, tedy **„m i s s i o n   t e r m i n a t e d"** — a to je jediný
 * rozdíl mezi koncem časem a koncem misí.
 *
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egLabels(m, data) {
  egSetDraw(m, EG_AT_LABELS);                                // `$B81B`
  egSetWord(m, EG_COLOR_DRAW, 0xDAD2);
  var timeUp = egLoad(m, EG_HOURS) === EG_LAST_HOUR;
  for (var x = 6; x >= 0; x--) {
    var label = data.labels[x], values = label.values, length = values.length;
    if (x === data.terminatedFor && timeUp) {                // `$B82B`
      var swap = egText(data, 'missionTerminated');
      values = swap.values; length = values.length;
    }
    var at = egDrawAt(m), colorAt = egColorAt(m);
    for (var y = length - 1; y >= 0; y--) {                  // `$B851`
      egStore(m, colorAt + y, 0x07);
      egStore(m, at + y, values[y]);
    }
    for (var n = data.labels[x].advance; n >= 0; n--) { egMoveDraw(m, -40); }
  }
} // egLabels

/** text, který není nadpis (`$B94A`, `$B900`, `$BDB3`, `$BD8F`) */
function egText(data, name) {
  for (var i = 0; i < data.texts.length; i++) {
    if (data.texts[i].name === name) { return data.texts[i]; }
  }
  return null;
} // egText

/* ------------------------------------------------------- `$B9FB`: skóre */

/** `$BB35` — číslici na obrazovku, `$BB38` znak už hotový */
function egPutDigit(m, y, digit) {
  egStore(m, egDrawAt(m) + y, egByte(digit + EG_DIGIT_BASE));
  egStore(m, egColorAt(m) + y, 0x01);
} // egPutDigit

function egPutChar(m, y, value) {
  egStore(m, egDrawAt(m) + y, value);
  egStore(m, egColorAt(m) + y, 0x01);
} // egPutChar

/**
 * `$BB6F` — **maska rovnice**: třináct znaků `$BB7F` a jejich barvy `$BB8C`.
 * Je v ní `_ _ × _ 0 0 _ = _ _ _ 0 0`, takže stačí dopsat počet a jedničku
 * nebo pětku, a z řádku je `n × 100 = n00` (§33).
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egRowMask(m, data) {
  var at = egDrawAt(m), colorAt = egColorAt(m);
  var chars = egTable(m, data, '$BB7F'), colors = egTable(m, data, '$BB8C');
  for (var y = 12; y >= 0; y--) {
    egStore(m, at + y, chars[y]);
    egStore(m, colorAt + y, colors[y]);
  }
} // egRowMask

/**
 * `$BB99` — kolikrát, tolikrát **sto**: `$E4` se v BCD zvedá po jedné (to je
 * ten počet, který se pak vytiskne) a skóre po jedné **do `$DA`**, tedy po
 * stovce. Dílek i heslo jdou přes tuhle rutinu.
 * @param {Object} m - Stroj.
 * @param {number} count - `$D6` nebo `$D7`.
 */
function egCountHundreds(m, count) {
  egStore(m, EG_WORK, 0);                                    // `$BB99`
  if (!count) { return; }
  for (var i = count; i > 0; i--) {                          // `$BBA1`
    egStore(m, EG_WORK, egBcdAdd(egLoad(m, EG_WORK), 1, 0).value);
    egAddBcd(m, EG_SCORE, 1, 1);                             // `$BBA8` — do `$DA`
  }
} // egCountHundreds

/** `$BBB4` — a skládačka je **pětka**, tedy pět set */
function egCountFiveHundreds(m, count) {
  egStore(m, EG_WORK, 0);                                    // `$BBB4`
  if (!count) { return; }
  for (var i = count; i > 0; i--) {                          // `$BBBC`
    egStore(m, EG_WORK, egBcdAdd(egLoad(m, EG_WORK), 5, 0).value);
    egAddBcd(m, EG_SCORE, 5, 1);                             // `$BBC5`
  }
} // egCountFiveHundreds

/**
 * `$BBCD` — počet do masky: desítky na offset 0, jednotky na 1, a **tytéž
 * dvě číslice znovu** na 9 a 10; na offset 3 jde `$8C`, tedy jednička. Tím
 * z masky vyjde `nn × 100 = nn00`.
 * @param {Object} m - Stroj.
 */
function egPutEquation(m) {
  var work = egLoad(m, EG_WORK), at = egDrawAt(m);
  if (work & 0xF0) {                                         // `$BBCF`
    var tens = egByte((work >> 4) + EG_DIGIT_BASE);
    egStore(m, at + 0, tens);
    egStore(m, at + 9, tens);
  }
  var units = egByte((work & 0x0F) + EG_DIGIT_BASE);         // `$BBE1`
  egStore(m, at + 1, units);
  egStore(m, at + 10, units);
  egStore(m, at + 3, 0x8C);                                  // `$BBF0` — jednička
} // egPutEquation

/**
 * `$BAFB`/`$BAFD` — **trojbajtové BCD na obrazovku** s potlačenými úvodními
 * nulami. ★ A když je celé číslo nula, vytiskne se **jedna** nula o jeden
 * offset zpátky (`$BB2E DEY`), což je ten samotný `0` na řádku celkového
 * skóre v prázdné hře.
 *
 * @param {Object} m - Stroj.
 * @param {number} y - Odkud (`$BAFB` začíná na 7, `$BAFD` s tím, co má volající).
 */
function egPutNumber(m, y) {
  egStore(m, EG_DIGITS, 0);                                  // `$BAFD`
  for (var x = 2; x >= 0; x--) {                             // `$BB03`
    var value = egLoad(m, EG_WORK + x);
    if ((value & 0xF0) || egLoad(m, EG_DIGITS)) {
      egStore(m, EG_DIGITS, egByte(egLoad(m, EG_DIGITS) + 1));
      egPutDigit(m, y, value >> 4);
    }
    y++;
    if ((value & 0x0F) || egLoad(m, EG_DIGITS)) {
      egStore(m, EG_DIGITS, egByte(egLoad(m, EG_DIGITS) + 1));
      egPutDigit(m, y, value & 0x0F);
    }
    y++;
  }
  if (!egLoad(m, EG_DIGITS)) { egPutDigit(m, y - 1, 0); }    // `$BB2E`
} // egPutNumber

/**
 * `$BA7E` — **zbývající vteřiny**, a odčítají se od šesté hodiny: `$60`
 * mínus vteřiny, k tomu `$59` mínus minuty krát šedesát a `$05` mínus
 * hodiny krát `$36`, tedy 3 600. Do skóre jde totéž, jen po jedné.
 * @param {Object} m - Stroj.
 */
function egSecondsLeft(m) {
  egStore(m, EG_WORK + 1, 0);                                // `$BA7E`
  egStore(m, EG_WORK + 2, 0);
  var seconds = egBcdSub(0x60, egLoad(m, EG_SECONDS)).value; // `$BA85`
  egStore(m, EG_WORK, seconds);
  egAddBcd(m, EG_SCORE, seconds, 0);                         // `$BA8C`
  var minutes = egBcdSub(0x59, egLoad(m, EG_MINUTES)).value; // `$BA8F`
  while (minutes) {                                          // `$BA96`
    egAddBcd(m, EG_WORK, 0x60, 0);
    egAddBcd(m, EG_SCORE, 0x60, 0);
    minutes = egBcdSub(minutes, 1).value;
  }
  var hours = egBcdSub(0x05, egLoad(m, EG_HOURS)).value;     // `$BAA7`
  while (hours) {                                            // `$BAAE`
    egAddBcd(m, EG_WORK, 0x36, 1);
    egAddBcd(m, EG_SCORE, 0x36, 1);
    hours = egBcdSub(hours, 1).value;
  }
} // egSecondsLeft

/**
 * `$B9FB` — **celé skóre**: tři rovnice, zbývající vteřiny (nebo tři nuly,
 * když čas vypršel), tisíc za dokončenou misi a nakonec součet.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egScore(m, data) {
  egStore(m, EG_SCORE, 0); egStore(m, EG_SCORE + 1, 0); egStore(m, EG_SCORE + 2, 0);
  egSetDraw(m, EG_AT_SCORE);                                 // `$BA03`
  egSetWord(m, EG_COLOR_DRAW, 0xD840);

  egRowMask(m, data);                                        // `$BA11`
  egCountHundreds(m, egLoad(m, EG_PIECES));                  // `$BA14`
  egPutEquation(m);                                          // `$BA19`
  egMoveDraw(m, 40);                                         // `$BA1C`

  egRowMask(m, data);                                        // `$BA1F`
  egCountHundreds(m, egLoad(m, EG_PASSWORDS));               // `$BA22`
  egPutEquation(m);                                          // `$BA27`
  egMoveDraw(m, 80); egMoveDraw(m, 40);                      // `$BA2A`, `$BA2D`

  egRowMask(m, data);                                        // `$BA30`
  var puzzles = egLoad(m, EG_PUZZLES);
  egCountFiveHundreds(m, puzzles);                           // `$BA33`
  egPutDigit(m, 1, puzzles);                                 // `$BA38` — jen jedna číslice
  var work = egLoad(m, EG_WORK);
  if (work & 0xF0) { egPutDigit(m, 9, work >> 4); }          // `$BA3F`
  egPutDigit(m, 10, work & 0x0F);                            // `$BA4E`
  egStore(m, egDrawAt(m) + 3, 0x90);                         // `$BA57` — pětka
  egMoveDraw(m, 40);                                         // `$BA5D`

  // ★ `$BA60`: **dvanáctá hodina se přepíše na nulu**, jinak by `$05 − $12`
  // v BCD vyšlo záporně a hráč by dostal třiadevadesát hodin k dobru
  var hours = egLoad(m, EG_HOURS);
  if (hours === EG_NOON) { egStore(m, EG_HOURS, 0); hours = 0; }
  if (hours === EG_LAST_HOUR) {
    // `$BA6E` — čas vypršel: tři nuly a žádné vteřiny
    for (var y = 12, x = 2; x >= 0; x--, y--) { egPutChar(m, y, EG_DIGIT_BASE); }
    egMoveDraw(m, 0xF0);                                     // `$BAEB JSR $AF1F`
  } else {
    egSecondsLeft(m);                                        // `$BA7E`
    egPutNumber(m, 7);                                       // `$BAC0`
    egMoveDraw(m, 80); egMoveDraw(m, 40);                    // `$BAC3`, `$BAC6`
    var thousand = egTable(m, data, '$BAE7');                // `$BAC9`
    for (var i = 3, yy = 12; i >= 0; i--, yy--) { egPutDigit(m, yy, thousand[i]); }
    egAddBcd(m, EG_SCORE, 0x10, 1);                          // `$BAD7` — tisíc
    egMoveDraw(m, 80); egMoveDraw(m, 40);                    // `$BADE`
  }
  for (var k = 2; k >= 0; k--) {                             // `$BAEE`
    egStore(m, EG_WORK + k, egLoad(m, EG_SCORE + k));
  }
  egPutNumber(m, 7);                                         // `$BAF7`
} // egScore

/* --------------------------------------------------- `$BBF7`: síň slávy */

/**
 * `$BE95` — tříbajtové BCD porovnání odshora. ★ Vrací **carry**, a ta je
 * nastavená jen tehdy, když skóre je **opravdu vyšší**; při rovnosti je
 * shozená, takže stejné skóre se do tabulky nevecpe.
 * @param {Object} m - Stroj.
 * @param {number} at - Kde leží položka.
 * @returns {number} 1 když skóre přebíjí.
 */
function egBeats(m, at) {
  for (var y = 2; y >= 0; y--) {
    var mine = egLoad(m, EG_SCORE + y), theirs = egLoad(m, at + y);
    if (mine < theirs) { return 0; }                         // `BCC`
    if (mine !== theirs) { return 1; }                       // `BNE` s carry
  }
  return 0;                                                  // `$BEA3 CLC`
} // egBeats

/**
 * `$BBF7`–`$BC36` — **vkládání do síně slávy**. Prochází se **odspodu**
 * (`$CF70`, tedy položka 14) nahoru; každá přebitá se **posune o osm bajtů
 * dolů** a na uvolněné místo se uloží nové skóre.
 *
 * ★ **Šestnáctá položka je přetlakový koš.** `$CF70 + 8` je `$CF78`, tedy za
 * patnácti zobrazenými — nejnižší vytlačená položka tam skončí a nikdo ji
 * nikdy neuvidí. `$38AA` proto nuluje **šestnáct** skóre, ne patnáct.
 *
 * ★ A jméno se do uvolněné položky **nekopíruje**: `$BC19` ho přepíše na
 * pětkrát `$53`, tedy na mezery, a skutečné jméno tam napíše až zadávání.
 *
 * @param {Object} m - Stroj.
 * @returns {number} Index, na který se nové skóre vešlo, nebo −1.
 */
function egInsert(m) {
  var at = EG_FAME_AT + (EG_FAME_SHOWN - 1)*EG_FAME_STRIDE;  // `$BBF7` — `$CF70`
  for (var x = EG_FAME_SHOWN - 1; x >= 0; x--) {             // `$BBFF LDX #$0E`
    if (!egBeats(m, at)) { return x + 1; }                   // `$BC04 BCC`
    var from = at, to = at + EG_FAME_STRIDE;                 // `$BC0E LDA #$08`
    for (var y = 7; y >= 0; y--) {                           // `$BC15`
      egStore(m, to + y, egLoad(m, from + y));
      egStore(m, from + y, EG_BLANK);
    }
    for (var s = 2; s >= 0; s--) {                           // `$BC22`
      egStore(m, from + s, egLoad(m, EG_SCORE + s));
    }
    at -= EG_FAME_STRIDE;                                    // `$BC2A` (+8 −$10)
  }
  return 0;                                                  // `$BC6C LDX #$FF` → index 0
} // egInsert

/**
 * `$BC38` — **„this surpasses the previous high score of"**, a vypíše se jen
 * tehdy, když nové skóre přebilo **i tu nejvyšší** položku. To staré nejvyšší
 * se v tu chvíli už posunulo na `$CF08`, odkud se bere.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 */
function egSurpass(m, data) {
  var first = egText(data, 'surpass0').values, second = egText(data, 'surpass1').values;
  for (var y = 0x1C; y >= 0; y--) {                          // `$BC3A`
    egStore(m, 0xDA0A + y, 0x05);
    egStore(m, 0xDA32 + y, 0x05);
    egStore(m, EG_AT_SURPASS + y, first[y]);
    egStore(m, EG_AT_SURPASS2 + y, second[y]);
  }
  for (var x = 2; x >= 0; x--) {                             // `$BC53`
    egStore(m, EG_WORK + x, egLoad(m, EG_FAME_AT + EG_FAME_STRIDE + x));
  }
  egSetDraw(m, EG_AT_SURPASS_SCORE);                         // `$BC5B`
  egSetWord(m, EG_COLOR_DRAW, 0xDA3A);
  egPutNumber(m, 7);                                         // `$BC69`
} // egSurpass

/**
 * `$BC6E`–`$BCDC` — **patnáct řádků síně slávy ve třech sloupcích po pěti**.
 * Po každé pátce se kreslicí poloha vrátí o šest řádků nahoru a posune
 * o dvanáct znaků vpravo (`$BCC2`: −160, −40, +12).
 * @param {Object} m - Stroj.
 */
function egFameList(m) {
  egSetDraw(m, EG_AT_FAME);                                  // `$BC70`
  egSetWord(m, EG_COLOR_DRAW, 0xDAF9);
  var at = EG_FAME_AT;                                       // `$BC7E`
  for (var a = EG_FAME_SHOWN - 1; a >= 0; a--) {             // `$BC86 LDA #$0E`
    for (var y = 2; y >= 0; y--) {                           // `$BC8B`
      egStore(m, EG_WORK + y, egLoad(m, at + y));
    }
    egPutNumber(m, 0);                                       // `$BC94 JSR $BAFD`
    var name = [];
    for (var i = 0; i < EG_FAME_NAME_LENGTH; i++) {          // `$BC9B`
      name.push(egLoad(m, at + EG_FAME_NAME + i));
    }
    var drawAt = egDrawAt(m), colorAt = egColorAt(m);
    for (var k = 0; k < EG_FAME_NAME_LENGTH; k++) {          // `$BCA6`
      egStore(m, drawAt + 7 + k, name[k]);
      egStore(m, colorAt + 7 + k, 0x04);
    }
    at += EG_FAME_STRIDE;                                    // `$BCB1`
    egMoveDraw(m, 40);                                       // `$BCB6`
    if (a === 10 || a === 5) {                               // `$BCB9`
      egMoveDraw(m, -160); egMoveDraw(m, -40); egMoveDraw(m, 12);
    }
  }
} // egFameList

/**
 * `$BCE6`–`$BD63` — **zadání jména**. Pět znaků do řádku, který si položka
 * v síni slávy drží (offsety `$BD80`), s kurzorem `$DB` a mazáním `$AF`.
 *
 * ★ **Klávesy jsou vstup.** Přepis je dostane hotové — `$FF` „nic", `$00`
 * `RETURN` (uzavře zadávání i dřív), `$01` `INST/DEL` — a pět znaků zadávání
 * uzavře samo. Co se napsalo, se **opíše z obrazovky** do `$CF03 + index*8`;
 * originál to tak dělá proto, že obrazovka je jeho jediný nárazník.
 *
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {number} index - Na kterou položku se skóre vešlo.
 * @param {number[]} keys - Co hráč zmáčkl, v pořadí.
 * @returns {number[]} Jméno, jak se uložilo — pět screen codes.
 */
function egEnterName(m, data, index, keys) {
  egNameBegin(m, data, index);
  for (var i = 0; i < keys.length; i++) {
    if (egNameKey(m, data, index, keys[i]).done) { break; }
  }
  return egNameFinish(m, data, index);
} // egEnterName

/**
 * `$BCE6`–`$BD07` — **kurzor a výzva**, tedy to, co se udělá **před** prvním
 * stiskem. V prohlížeči to od zbytku odděleno být musí: originál stojí
 * v `$BD0B` a čeká, my mezi klávesami kreslíme dál.
 *
 * ★ **`$E5` je poloha na obrazovce a `$E6` počet napsaných znaků**, a obojí
 * zůstane v nulté stránce stát; přepis je tam proto opravdu vede, ne
 * v místních proměnných — měřidlo se na ně ptá.
 *
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {number} index - Na kterou položku se skóre vešlo.
 */
function egNameBegin(m, data, index) {
  var prompt = egText(data, 'enterName').values;
  for (var y = 0x23; y >= 0; y--) {                          // `$BCE8`
    egStore(m, EG_AT_PROMPT + y, prompt[y]);
    egStore(m, 0xDAAA + y, 0x07);
  }
  var spot = egTable(m, data, '$BD80')[index];               // `$BCF8` — `$E5`
  egStore(m, 0xE5, spot);
  egStore(m, 0xDB00 + spot, 0x07);                           // `$BCFD` — kurzor
  egStore(m, EG_AT_NAMES + spot, EG_CURSOR);
  egStore(m, 0xE6, 0);                                       // `$BD07`
} // egNameBegin

/**
 * `$BD0B`–`$BD7D` — **jeden stisk**. `$FF` a `RUN/STOP` se přeskakují,
 * `RETURN` zadávání uzavře, `INST/DEL` maže, pátý znak uzavře taky.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {number} index - Položka.
 * @param {number} key - Screen code, `$00`, `$01`, `$FF` nebo `$F0`.
 * @returns {Object} `done` když zadávání skončilo.
 */
function egNameKey(m, data, index, key) {
  var spot = egLoad(m, 0xE5), typed = egLoad(m, 0xE6);
  if (key === EG_KEY_NONE || key === EG_KEY_RESTORE) { return {}; }   // `$BD13`
  if (key === EG_KEY_RETURN) {                               // `$BD11 BEQ $BD40`
    egStore(m, EG_AT_NAMES + spot, EG_ERASED);               // `$BD42`
    return {done: 1};
  }
  if (key === EG_KEY_DELETE) {                               // `$BD1B`
    if (!typed) { return {}; }                               // `$BD66`
    typed--; spot--;
    egStore(m, 0xE6, typed); egStore(m, 0xE5, spot);         // `$BD68`
    egStore(m, EG_AT_NAMES + spot + 1, EG_ERASED);           // `$BD6E`
    egStore(m, 0xDB00 + spot, 0x07);
    egStore(m, EG_AT_NAMES + spot, EG_CURSOR);
    return {};
  }
  egStore(m, EG_AT_NAMES + spot, key);                       // `$BD1F`
  egStore(m, 0xDB00 + spot, 0x04);
  spot++; typed++;                                           // `$BD29`
  egStore(m, 0xE5, spot); egStore(m, 0xE6, typed);
  if (typed >= EG_FAME_NAME_LENGTH) { return {done: 1}; }    // `$BD2D`
  egStore(m, 0xDB00 + spot, 0x07);                           // `$BD33`
  egStore(m, EG_AT_NAMES + spot, EG_CURSOR);
  return {};
} // egNameKey

/**
 * `$BD47`–`$BD5E` — **jméno se opíše z obrazovky** do položky. Originál to
 * tak dělá proto, že obrazovka je jeho jediný nárazník; přepis to dělá
 * stejně, aby se dal srovnat.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {number} index - Položka.
 * @returns {number[]} Pět screen codes, jak se uložily.
 */
function egNameFinish(m, data, index) {
  var from = EG_AT_NAMES + egTable(m, data, '$BD80')[index];
  var into = EG_FAME_AT + EG_FAME_NAME + index*EG_FAME_STRIDE;
  var name = [];
  egStore(m, EG_WORK, EG_FAME_NAME_LENGTH - 1);              // `$BD50 LDA #$04`
  for (var k = 0; k < EG_FAME_NAME_LENGTH; k++) {            // `$BD54`
    var value = egLoad(m, from + k);
    egStore(m, into + k, value);
    name.push(value);
    egStore(m, EG_WORK, egByte(egLoad(m, EG_WORK) - 1));     // `$BD5C DEC $E4`
  }
  // `$BD60 JSR $BDFB` — `SAVE` na disketu; v remaku to dělá hlavní vlákno
  return name;
} // egNameFinish

/** `$B87C` — spodní řádek „hit restore or run/stop for new game" */
function egPrompt(m, data) {
  var text = egText(data, 'hitRestore').values;
  var colors = egText(data, 'promptColors').values;
  for (var y = 0x23; y >= 0; y--) {                          // `$B87E`
    egStore(m, EG_AT_PROMPT + y, text[y]);
    egStore(m, 0xDAAA + y, colors[y]);
  }
} // egPrompt

/* ------------------------------------------------------------- celý konec */

/**
 * `$B77C` celá — tabule, skóre, síň slávy a spodní řádek.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {number[]} keys - Co hráč napíše, když se skóre vejde do tabulky.
 * @returns {Object} `speech` když se řekla věta 0, `fame` s indexem a jménem.
 */
function egBoard(m, data, keys) {
  var out = egBoardDraw(m, data);
  var index = egBoardScore(m, data);
  if (index < EG_FAME_SHOWN) {                               // `$BCE1 CPX #$0F`
    out.fame = {index: index, name: egEnterName(m, data, index, keys || [])};
  }
  egPrompt(m, data);                                         // `$B87C`
  return out;
} // egBoard

/**
 * `$B77C`–`$B872` — **rámečky, nadpisy a věta**. Odděleno od skóre proto, že
 * v prohlížeči se mezi nimi nic neděje, ale v záznamu je mezi nimi zastávka
 * `$B873` — a na té se srovnává celá obrazovka.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @returns {Object} `speech`, když se řekla věta 0.
 */
function egBoardDraw(m, data) {
  var out = {};
  egFrames(m, data);                                         // `$B77C`
  egLabels(m, data);                                         // `$B829`
  // ★ `$B868`: konec, který **není** vypršením času, řekne **větu 0**
  if (egLoad(m, EG_HOURS) !== EG_LAST_HOUR) { out.speech = EG_WORD_GAME_OVER; }
  return out;
} // egBoardDraw

/**
 * `$B876`–`$B879` — **skóre a síň slávy**.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @returns {number} Index, na který se skóre vešlo, nebo `EG_FAME_SHOWN`.
 */
function egBoardScore(m, data) {
  egScore(m, data);                                          // `$B876 JSR $B9FB`
  var index = egInsert(m);                                   // `$B879 JSR $BBF7`
  if (index === 0 && egLoad(m, EG_SCORE) + egLoad(m, EG_SCORE + 1)
                     + egLoad(m, EG_SCORE + 2) > 0) {
    // ★ `$BC38` se dělá **jen** když se prošlo všech patnáct, tedy když se
    // nové skóre vešlo na první místo; `egInsert` to hlásí indexem 0
    egSurpass(m, data);
  }
  egFameList(m);                                             // `$BC6E`
  return index;
} // egBoardScore

/**
 * Celý konec hry naráz, jak ho vidí měřidlo.
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @param {function(): number} entropy - Míchačce.
 * @param {number[]} keys - Jméno do síně slávy.
 * @returns {Object} Co se řeklo a co se uložilo.
 */
function egEnd(m, data, entropy, keys) {
  var out = egBegin(m);                                      // `$83F2`
  for (var round = EG_SHAKE_ROUNDS - 1; round >= 0; round--) {
    egShakeRound(m, round, entropy);                         // `$840E`
  }
  egBlank(m);                                                // `$8452`
  for (var i = EG_DISSOLVE_ROUNDS - 1; i >= 0; i--) {
    egDissolveRound(m, entropy);                             // `$8498`
  }
  egFinishDissolve(m);                                       // `$84B7`
  var board = egBoard(m, data, keys);                        // `$B77C`
  if (board.speech !== undefined) { out.speech = board.speech; }
  if (board.fame) { out.fame = board.fame; }
  return out;
} // egEnd

/**
 * Konec hry rozložený **do snímků**, aby ho šlo v prohlížeči vidět.
 *
 * ★ Na stroji žádné snímky nemá — drží v něm `SEI` — ale trvá kolem pěti
 * vteřin a hráč se na něj dívá. Model ho proto krájí po **kolech**: třes je
 * 128 kol a rozpad taky, a to je při padesáti snímcích za vteřinu **pět
 * vteřin**, tedy přibližně to, co dělá stroj (jedno kolo třesu stojí
 * `$9787`, což je asi 0,85 snímku).
 *
 * @param {Object} m - Stroj.
 * @param {Object} data - `data/end.json`.
 * @returns {Object} Stav, který se pak vozí do `egFrame`.
 */
function egStart(m, data) {
  return {phase: 'begin', round: EG_SHAKE_ROUNDS - 1, data: data};
} // egStart

/**
 * Jeden snímek konce hry.
 * @param {Object} m - Stroj.
 * @param {Object} state - Co vrátil `egStart`.
 * @param {function(): number} entropy - Míchačce.
 * @param {number[]} keys - Jméno do síně slávy, když na ně přijde.
 * @returns {Object} `done` když je tabule hotová, `speech` když se mluvilo.
 */
function egFrame(m, state, entropy, keys) {
  if (state.phase === 'begin') {
    state.phase = 'shake';
    return egBegin(m);
  }
  if (state.phase === 'shake') {
    egShakeRound(m, state.round, entropy);
    state.round--;
    if (state.round < 0) { state.phase = 'blank'; }
    return {};
  }
  if (state.phase === 'blank') {
    egBlank(m);
    state.phase = 'dissolve';
    state.round = EG_DISSOLVE_ROUNDS - 1;
    return {};
  }
  if (state.phase === 'dissolve') {
    egDissolveRound(m, entropy);
    state.round--;
    if (state.round < 0) { state.phase = 'board'; }
    return {};
  }
  if (state.phase === 'board') {
    egFinishDissolve(m);
    var out = egBoardDraw(m, state.data);
    state.index = egBoardScore(m, state.data);
    if (state.index < EG_FAME_SHOWN) {
      // ★ **a tady se čeká na hráče**, jako originál čeká v `$BD0B`
      egNameBegin(m, state.data, state.index);
      state.phase = 'name';
      out.name = 1;
      return out;
    }
    egPrompt(m, state.data);
    state.phase = 'done';
    out.done = 1;
    return out;
  }
  if (state.phase === 'name') {
    var typed = keys && keys.length ? keys : [];
    for (var i = 0; i < typed.length; i++) {
      if (egNameKey(m, state.data, state.index, typed[i]).done) {
        var name = egNameFinish(m, state.data, state.index);
        egPrompt(m, state.data);
        state.phase = 'done';
        return {done: 1, fame: {index: state.index, name: name}};
      }
    }
    return {name: 1};
  }
  return {done: 1};
} // egFrame

/**
 * Prázdná síň slávy, kterou `$38AA` udělá, když `LOAD "HI"` nevyjde:
 * **šestnáct** položek (patnáctá zobrazená a jeden koš), jméno z pěti `$DC`
 * a skóre nula.
 * @param {Object} m - Stroj.
 */
function egBlankFame(m) {
  var i;
  for (i = 0; i < 0x80; i++) { egStore(m, EG_FAME_AT + i, EG_FAME_BLANK); }
  for (i = 0; i < 0x80; i += EG_FAME_STRIDE) {
    egStore(m, EG_FAME_AT + i, 0);
    egStore(m, EG_FAME_AT + i + 1, 0);
    egStore(m, EG_FAME_AT + i + 2, 0);
  }
} // egBlankFame

/**
 * Síň slávy z paměti stroje do něčeho, co se dá uložit v prohlížeči — a zpátky.
 * ★ V originálu je to soubor `HI` na disketě (`$BDFB`); v remaku ji drží
 * hlavní vlákno, protože na disketu se v prohlížeči nepíše.
 * @param {Object} m - Stroj.
 * @returns {Array<{score: number[], name: number[]}>} Šestnáct položek.
 */
function egFameOut(m) {
  var out = [];
  for (var i = 0; i < 0x80; i += EG_FAME_STRIDE) {
    var at = EG_FAME_AT + i, score = [], name = [];
    for (var s = 0; s < 3; s++) { score.push(egLoad(m, at + s)); }
    for (var n = 0; n < EG_FAME_NAME_LENGTH; n++) {
      name.push(egLoad(m, at + EG_FAME_NAME + n));
    }
    out.push({score: score, name: name});
  }
  return out;
} // egFameOut

/** a zpátky do paměti stroje */
function egFameIn(m, list) {
  for (var i = 0; i < list.length && i < 16; i++) {
    var at = EG_FAME_AT + i*EG_FAME_STRIDE, item = list[i];
    for (var s = 0; s < 3; s++) { egStore(m, at + s, item.score[s]); }
    for (var n = 0; n < EG_FAME_NAME_LENGTH; n++) {
      egStore(m, at + EG_FAME_NAME + n, item.name[n]);
    }
  }
} // egFameIn

var endGame = {
  end: egEnd, start: egStart, frame: egFrame,
  begin: egBegin, shakeRound: egShakeRound, blank: egBlank,
  dissolveRound: egDissolveRound, finishDissolve: egFinishDissolve,
  board: egBoard, boardDraw: egBoardDraw, boardScore: egBoardScore,
  frames: egFrames, labels: egLabels, score: egScore,
  insert: egInsert, surpass: egSurpass, fameList: egFameList,
  enterName: egEnterName, prompt: egPrompt,
  nameBegin: egNameBegin, nameKey: egNameKey, nameFinish: egNameFinish,
  blankFame: egBlankFame, fameOut: egFameOut, fameIn: egFameIn,
  putNumber: egPutNumber, beats: egBeats,
  SHAKE_ROUNDS: EG_SHAKE_ROUNDS, DISSOLVE_ROUNDS: EG_DISSOLVE_ROUNDS,
  FAME_AT: EG_FAME_AT, FAME_SHOWN: EG_FAME_SHOWN, FAME_STRIDE: EG_FAME_STRIDE,
  FAME_NAME: EG_FAME_NAME, FAME_NAME_LENGTH: EG_FAME_NAME_LENGTH,
  WORD_TIME_UP: EG_WORD_TIME_UP, WORD_GAME_OVER: EG_WORD_GAME_OVER,
  LAST_HOUR: EG_LAST_HOUR, KEY_RESTORE: EG_KEY_RESTORE,
  DIGIT_BASE: EG_DIGIT_BASE
};
// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
if (typeof self !== 'undefined') {
  self.endGame = endGame;
  self.egEnd = egEnd;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = endGame; }
