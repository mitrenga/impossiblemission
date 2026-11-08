// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * `$95DA` — **umírání** (`sources/docs/disasm_notes.md` §31).
 *
 * Když `$94FA` nebo pád nastaví `$43`, jde hra sem a udělá celý obřad. Není
 * to jedna rutina, je to **sedm kroků**, a jen první z nich je ta animace,
 * které si hráč všimne:
 *
 * 1. `$95DC` — je-li `$43` záporné, **vypršel čas** a hra končí (`$83F2`);
 * 2. `$95E1` — ★ **v šachtě se neumírá**: `$43` se shodí a jde se dál;
 * 3. `$95E8` — `SEI`, a tím se na celý obřad zastaví svět;
 * 4. `$9720` — ★ **agentovy tři sprajty se zkopírují do `$4D80` a ukazatele
 *    se přesměrují na ně**, takže se rozpouští kopie, ne data hry;
 * 5. `$9610`-`$964B` — blikání barev a **rozpouštění**: 33 kol, v každém
 *    49 bajtů ve třech blocích, a který bajt a které body se z něj vyhodí,
 *    říká **míchačka** `$82D6`;
 * 6. `$966C` — stavba: výtahy místnosti zpátky (`$A0F5`), roboti (`$A68B`),
 *    koule (`$A714`), agent na vstupní pozici (`$ABDB`);
 * 7. `$96EF` — ★ **deset minut k hodinám** (`SED`, `LDA #$10`, `JSR $83C2`).
 *
 * ## Co je na tom měřitelné a proč je to vlastní nástroj
 *
 * ★ **Snímek tu není jednotka.** `SEI` na `$95E8` drží až do `$96F5`, takže
 * v obřadu nestoupne `$E0`, nejdou hodiny, nejedou roboti a past harnessu
 * na `$8361` se ani jednou neozve. Je to totéž, co dělá bezpečnostní
 * terminál (§29), a měří se to stejně — **zastávkami** (`tools/tracedeath.py`,
 * `tools/matchdeath.mjs`).
 *
 * ★ A rozpouštění **je** měřitelné, ačkoli vypadá jako náhoda: `$97D7`
 * bere dvě čísla z míchačky (masku ze `$97E9` a posun do bloku) a míchačka
 * je táž jako všude jinde (§8). Když sedí obsah tří bloků po každém kole,
 * sedí i každé volání míchačky v tom kole — a těch je 295.
 *
 * ## Čeho se to nedotýká
 *
 * ★ **Smrtelný pád (`$43` = 2) mluví.** `$95FD` zhasne agenta a pustí
 * `$BF51` se vzorkem 7, tedy **výkřik** — a `$BF51` u něj **čeká, až
 * přehrávač domluví** (`$BF7E`, §32). Po celou tu dobu je obrazovka **bez
 * agenta** a svět stojí; teprve za ní `$960D` skočí na stavbu. V modelu to
 * drží `passes` = 0, které worker posílá po dobu věty (R-047).
 *
 * ★ A **vypršelý čas** (`$43` = `$FF` → `$83F2`) je konec hry, tedy M5.
 */

/** nultá stránka, na kterou se obřad ptá */
var DH_DEATH = 0x43, DH_PLACE = 0x1A, DH_SNOOZE = 0x47, DH_ORB = 0x6D,
    DH_STATE = 0x3F, DH_JUMP = 0x51, DH_LATCH = 0xDE, DH_ROOM = 0x7E,
    DH_SIDE = 0x7F, DH_RECORD = 0x18, DH_LIFTS = 0x81, DH_E4 = 0xE4,
    DH_SPRITES = 0x32, DH_ROW_COUNT = 0xE5, DH_PTR = 0x10;
/** registry */
var DH_SPENA = 0xD015, DH_MSIGX = 0xD010, DH_SPSPCL = 0xD01E,
    DH_SPRITE_COLORS = 0xD028;
/** ukazatele sprajtů agenta a tabulka jeho výchozích hodnot (`$9708`) */
var DH_POINTERS = 0x43F9, DH_DEFAULTS = 0x9708;
/** ukazatele na 32 záznamů místností (`$0E70`) */
var DH_ROOM_PTRS = 0x0E70;
/** ★ tři bloky, do kterých se agent rozpouští, a ukazatel, který na ně míří */
var DH_BLOCKS = [0x4D80, 0x4DC0, 0x4E00], DH_BLOCK_PTR = 0x36;
/** masky, kterými `$97D7` vyhazuje body (`$97E9`), a barvy blikání (`$9783`) */
var DH_MASKS = 0x97E9, DH_FLASH = 0x9783;
/** druhy smrti (`RAMUse.md`) */
var DH_BY_TOUCH = 1, DH_BY_FALL = 2, DH_BY_LIFT = 3;
/** kolik minut smrt stojí — `$96F0 LDA #$10` v `SED` */
var DH_PENALTY = 0x10;
/** kolik kol má rozpouštění a kolik bajtů se v kole vyhodí (`$961D`, `$961F`) */
var DH_ROUNDS = 0x20, DH_BYTES = 0x30;

/**
 * ★ **Zdržení `$9787` v cyklech, a snímek PAL, do kterého se počítá.**
 *
 * `$9787` je prázdná smyčka: `INX`/`BNE` 256krát (1 279 cyklů) a to
 * čtrnáctkrát, jak `$0C` v `Y` dojde na `$FF` — **18 001 cyklů**, tedy
 * 0,916 snímku. `$975B` ho volá **dvakrát**, jednou před každou půlkou
 * bliknutí, takže **jedna půlka trvá skoro přesně jeden snímek** a agent
 * v obřadu bliká zhruba pětadvacetkrát za vteřinu. Celý obřad je
 * `(34 + 33)·2` půlek, tedy **123 snímků, dvě a půl vteřiny**.
 */
var DH_DELAY = 18001, DH_FRAME_CYCLES = 19656;

/** kolikrát se blikne v úvodu (`$9612`: `Y` od `$10` dolů, a to dvakrát) */
var DH_INTRO_FLASHES = 0x11;
/** půlky bliknutí: úvod `$9610` a kola rozpouštění, po dvou na bliknutí */
var DH_INTRO_HALVES = 2*2*DH_INTRO_FLASHES, DH_ROUND_HALVES = 2*(DH_ROUNDS + 1);

function dhLoad(m, a) { return rbLoad(m, a); }
function dhStore(m, a, v) { rbStore(m, a, v); }
function dhByte(v) { return v & 0xFF; }
function dhWord(m, a) { return dhLoad(m, a) | (dhLoad(m, a + 1) << 8); }

/**
 * `$9720` — ★ **agent se rozpouští z kopie, ne z dat hry.**
 *
 * Každý z jeho tří sprajtů se přečte tam, kam míří jeho ukazatel, a uloží
 * se do `$4D80`/`$4DC0`/`$4E00`; ukazatele se pak přesměrují na `$36`,
 * `$37` a `$38`, což jsou právě ty tři bloky. Bez toho by rozpouštění
 * sežralo **sprajtová data agenta** (`$6000`, §13) a po prvním úmrtí by
 * byl agent děravý napořád.
 *
 * @param {Object} m - Stroj.
 */
function dhCopyBlocks(m) {
  for (var x = 2; x >= 0; x--) {
    var at = (dhLoad(m, DH_POINTERS + x)*64 + 0x4000) & 0xFFFF;   // ×64, banka 1
    // ★ a **`$18`/`$19` v tom zůstanou stát** (`$9724`, `$9734`): je to
    // odkládací pásmo, které si obřad po sobě neuklízí, a měřidlo ho vidí
    dhStore(m, DH_RECORD, at & 0xFF);
    dhStore(m, DH_RECORD + 1, (at >> 8) & 0xFF);
    var to = DH_BLOCKS[x];
    for (var y = 0x3F; y >= 0; y--) { dhStore(m, to + y, dhLoad(m, at + y)); }
    dhStore(m, DH_POINTERS + x, dhByte(DH_BLOCK_PTR + x));
  }
} // dhCopyBlocks

/**
 * `$97D7` — dvě čísla z míchačky: **která maska** (`$97E9`, každá vyhazuje
 * jeden bit) a **do kterého bajtu** bloku se má sáhnout.
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Co míchačka přimíchá (§8).
 * @returns {{mask: number, at: number}} Maska a posun 0-63.
 */
function dhPick(m, entropy) {
  var mask = dhLoad(m, DH_MASKS + (fgRandom(m.mem, entropy()) & 0x07));
  var at = fgRandom(m.mem, entropy()) & 0x3F;
  return {mask: mask, at: at};
} // dhPick

/**
 * `$975B` — jedno bliknutí barev agenta, ve dvou půlkách se zdržením mezi
 * nimi (`$9787`). ★ Zdržení je čistý čas a nic si nepamatuje, ale **`$979A`
 * mezi nimi sáhne do míchačky** (hlasitost je `mix & 7`), takže ho přepis
 * vynechat nesmí — rozpouštění by pak bralo jiná čísla.
 * @param {Object} m - Stroj.
 * @param {number} x - 0 nebo 1: která dvojice barev.
 * @param {function(): number} entropy - Míchačce.
 */
function dhFlash(m, x, entropy) {
  dhFlashHalf(m, x, 0, entropy);                           // `$9761`
  dhFlashHalf(m, x, 1, entropy);                           // `$9773`
} // dhFlash

/**
 * ★ **Jedna půlka bliknutí** — a je to ta, kterou hráč vidí.
 *
 * `$975B` sází barvy **dvakrát a mezi tím čeká** (`$9787`), takže agent
 * v obřadu bliká: jednou má sprajt 1 barvu `a` a zbylé dva `b`, podruhé
 * obráceně. Kdo obě půlky udělá naráz, nechá na registrech jen tu druhou —
 * a protože ta vychází na `$01`/`$0B`/`$0B`, tedy **přesně na obyčejné
 * barvy agenta**, nebliká vůbec nic (nahlásil operátor 2026-09-21).
 *
 * ★ Do míchačky se sahá **v první půlce** (`$979A` je za prvním `$9787`),
 * takže se pořadí čísel proti `dhDie` nemění.
 *
 * @param {Object} m - Stroj.
 * @param {number} x - 0 nebo 1: která dvojice barev.
 * @param {number} half - 0 první půlka (`$9761`), 1 druhá (`$9773`).
 * @param {function(): number} entropy - Míchačce.
 */
function dhFlashHalf(m, x, half, entropy) {
  var a = dhLoad(m, DH_FLASH + x), b = dhLoad(m, DH_FLASH + 2 + x);
  if (!half) {
    sndDeathFlash(m, function () { return fgRandom(m.mem, entropy()); });  // `$979A`
    dhStore(m, DH_SPRITE_COLORS + 1, a); dhStore(m, DH_SPRITE_COLORS + 2, a);
    dhStore(m, DH_SPRITE_COLORS, b);
    return;
  }
  dhStore(m, DH_SPRITE_COLORS + 1, b); dhStore(m, DH_SPRITE_COLORS + 2, b);
  dhStore(m, DH_SPRITE_COLORS, a);
} // dhFlashHalf

/**
 * `$9610`-`$964B` — blikání a rozpouštění.
 *
 * Napřed **dvakrát sedmnáct bliknutí** (`$9612`, jednou každou dvojicí
 * barev), pak **33 kol**, a v každém kole se 49krát vyhodí jeden bit ze
 * **všech tří bloků** — pokaždé jiný a jinde. ★ Čítač smyčky přitom leží
 * na zásobníku (`$9621 TXA PHA`), protože `$97D7` vrací posun **v `X`**;
 * kdo by si ho tam nechal, rozpouští po řadě, a vypadá to skoro stejně.
 *
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Míchačce.
 */
function dhDissolve(m, entropy) {
  var y;
  dhFlashIntro(m, entropy);                                // `$9610`
  for (y = DH_ROUNDS; y >= 0; y--) {                       // `$961D`
    dhRoundBytes(m, entropy);                              // `$961F`
    dhFlash(m, 0, entropy);                                // `$9643`
  }
  dhClearBlocks(m);                                        // `$964B`
} // dhDissolve

/**
 * `$9610` — **dvakrát sedmnáct bliknutí**, jednou každou dvojicí barev, než
 * se začne rozpouštět.
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Míchačce.
 */
function dhFlashIntro(m, entropy) {
  for (var x = 1; x >= 0; x--) {
    for (var y = 0x10; y >= 0; y--) { dhFlash(m, x, entropy); }
  }
} // dhFlashIntro

/**
 * `$961F` — jedno kolo rozpouštění: **devětačtyřicetkrát** se vyhodí jeden
 * bit ze všech tří bloků, pokaždé jinde.
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Míchačce.
 */
function dhRoundBytes(m, entropy) {
  for (var x = DH_BYTES; x >= 0; x--) {
    for (var b = 0; b < 3; b++) {
      var pick = dhPick(m, entropy);
      var at = DH_BLOCKS[b] + pick.at;
      dhStore(m, at, dhLoad(m, at) & pick.mask);
    }
  }
} // dhRoundBytes

/**
 * `$964B` — a co po rozpouštění zbylo, se domaže.
 * @param {Object} m - Stroj.
 */
function dhClearBlocks(m) {
  for (var x = 0x3F; x >= 0; x--) {
    for (var b = 0; b < 3; b++) { dhStore(m, DH_BLOCKS[b] + x, 0); }
  }
} // dhClearBlocks

/**
 * `$AE1C` — smrt **při jízdě výtahem** (`$43` = 3) za sebou nechá sloupec
 * plošin nakreslený tam, kam dojel; tohle ho smaže, stejně jako to dělá
 * lift reset (§25, §29). Kreslicí pozice i počet jsou to, co v nich nechala
 * jízda.
 * @param {Object} m - Stroj.
 */
function dhEraseLiftColumn(m) {
  for (;;) {
    for (var y = 2; y >= 0; y--) { dhStore(m, dhWord(m, DH_PTR) + y, 0x53); }
    roomLift.movePointer(m, -roomLift.SIX_ROWS);           // `$AE25 JSR $AEEB`
    var left = dhByte(dhLoad(m, DH_ROW_COUNT) - 1);        // `$AE28 DEC $E5`
    dhStore(m, DH_ROW_COUNT, left);
    if (left & 0x80) { return; }                           // `$AE2A BPL`
  }
} // dhEraseLiftColumn

/**
 * `$966C` — místnost se staví znovu, ale **nekreslí se**: obrazovka zůstane,
 * jak je, a mění se jen to, co v ní chodí. Výtahy se vrátí na začátek
 * (`$A0F5`, tatáž rutina, jakou pouští lift reset v terminálu, §29), roboti
 * a koule se postaví ze záznamu a agent se postaví na vstupní pozici.
 *
 * ★ Kde v záznamu ta místa jsou, se **hledá průchodem**: `$9686` přeskočí
 * **dvě sekce ukončené `$FF`** (podlahy a sloupy), a na tom místě začíná
 * vstup agenta; roboti jsou o **šest bajtů** dál.
 *
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Míchačce.
 */
function dhRebuild(m, entropy) {
  dhStore(m, DH_SPENA, dhLoad(m, DH_SPENA) & 0xF0);        // `$966E`
  terminal.liftReset(m);                                   // `$9675 JSR $A0F5`

  var record = dhWord(m, DH_ROOM_PTRS + 2*dhLoad(m, DH_ROOM));
  dhStore(m, DH_RECORD, record & 0xFF);
  dhStore(m, DH_RECORD + 1, (record >> 8) & 0xFF);
  var y = 0;                                               // `$9686`
  for (var pass = 1; pass >= 0; pass--) {
    while (dhLoad(m, (record + y) & 0xFFFF) !== 0xFF) { y = dhByte(y + 1); }
    y = dhByte(y + 1);
  }
  var entry = y;                                           // `$9694 TYA PHA`

  var keptLifts = [dhLoad(m, DH_LIFTS), dhLoad(m, DH_LIFTS + 1)];
  dhStore(m, DH_MSIGX, 0);                                 // `$96A0`
  // ★ `Y` je bajtový index od `$18`, takže i `+6` se počítá v bajtu
  var built = roomBuild.robots(m, (record + dhByte(entry + 6)) & 0xFFFF);
  dhStore(m, DH_LIFTS, keptLifts[0]);                      // `$96A8`
  dhStore(m, DH_LIFTS + 1, keptLifts[1]);
  roomBuild.ball(m, built.at);                             // `$96AE JSR $A714`
  if (!dhLoad(m, DH_ORB)) {                                // `$96B1`
    dhStore(m, DH_SPENA, dhLoad(m, DH_SPENA) | 0x01);
  }

  dhStore(m, DH_SNOOZE, 0xFF);                             // `$96BF` — roboti se probudí
  var kept = dhLoad(m, DH_MSIGX) & 0xF0;                   // `$96C3`
  dhStore(m, DH_E4, kept);
  roomBuild.agentEntry(m, (record + entry) & 0xFFFF,       // `$96CA JSR $ABDB`
                       dhLoad(m, DH_SIDE));
  dhStore(m, DH_MSIGX, (dhLoad(m, DH_MSIGX) & 0x01)        // `$96CD`
    | dhLoad(m, DH_SPRITES) | kept);
  dhStore(m, DH_STATE, 0x0E);                              // `$96D9` — stojí

  for (var i = 2; i >= 0; i--) {                           // `$96DD JSR $970E`
    dhStore(m, DH_POINTERS + i, dhLoad(m, DH_DEFAULTS + i));
    dhStore(m, DH_SPRITE_COLORS + i, dhLoad(m, DH_DEFAULTS + 3 + i));
  }
  collision.read(m, 0x96E3);                               // `$96E3` — vyčisti latch
  dhStore(m, DH_DEATH, 0);                                 // `$96E6`
  dhStore(m, DH_JUMP, 0);
  // ★ `$96EF SED / LDA #$10 / JSR $83C2` — **deset minut**, a je to táž
  // rutina, kterou hodiny tikají po minutě (§17)
  player.clockAdd(m, DH_PENALTY);
} // dhRebuild

/**
 * `$96F5`-`$9703` — poslední tři zápisy: `CLI`, agent se rozsvítí, zvuk zpět
 * a západka tlačítka na jedna.
 *
 * ★ Je to **vlastní funkce**, protože `CLI` je hranice: od něj běží obsluha
 * přerušení a sahá do téhož stavu, takže se od toho místa dál nedá dokázat,
 * co udělal obřad a co ona (§31).
 * @param {Object} m - Stroj.
 */
function dhResume(m) {
  dhStore(m, DH_SPENA, dhLoad(m, DH_SPENA) | 0x0E);        // `$96F6`
  dhStore(m, DH_LATCH, 1);                                 // `$9703`
} // dhResume

/**
 * `$95DA` celá.
 * @param {Object} m - Stroj.
 * @param {function(): number} entropy - Co míchačka přimíchá (§8).
 * @returns {Object} `gameOver` když vypršel čas (M5), `speech` když obřad
 *   došel na řeč (M6), `done` když doběhl.
 */
function dhDie(m, entropy) {
  var how = dhLoad(m, DH_DEATH);
  if (how & 0x80) { return {gameOver: 1}; }                // `$95DC` → `$83F2`
  // ★ `$95E1`: **v šachtě se neumírá** — `$43` se shodí a hra jede dál
  if (!dhLoad(m, DH_PLACE)) { dhStore(m, DH_DEATH, 0); return {done: 1}; }

  dhCopyBlocks(m);                                         // `$95E9`
  sndSilence(m);                                           // `$95EC` — všechny tři hlasy do testu
  if (how === DH_BY_FALL) {
    // ★ `$95FD`-`$960D`: **smrtelný pád se nerozpouští**. Agent zhasne,
    // řekne se věta (`$BF51`, vzorek 7) a skočí se **rovnou na stavbu** —
    // žádné blikání, žádných 33 kol. Z toho je nepřepsaná jen ta řeč (M6),
    // takže se udělá zbytek a **přizná se, co se neřeklo**.
    dhStore(m, DH_SPENA, dhLoad(m, DH_SPENA) & 0xF1);      // `$95FD`
    dhRebuild(m, entropy);                                 // `$960D JMP $966C`
    dhResume(m);
    return {done: 1, speech: 7};
  }
  dhDissolve(m, entropy);
  sndSilenceTwo(m);                                        // `$965B` — a zase ticho
  if (how === DH_BY_LIFT) { dhEraseLiftColumn(m); }        // `$9663`
  dhRebuild(m, entropy);
  dhResume(m);
  return {done: 1};
} // dhDie

/**
 * Obřad rozložený **do snímků**, aby se dal v prohlížeči vidět.
 *
 * ★ Na stroji obřad žádné snímky nemá — drží v něm `SEI` — ale trvá
 * **dvě a půl vteřiny** a hráč ho vidí. ★ A jednotkou v něm není kolo
 * rozpouštění, je to **zdržení `$9787`**: prázdná smyčka 18 001 cyklů,
 * tedy 0,916 snímku PAL, kterou `$975B` volá **před každou půlkou
 * bliknutí**. Model ho proto krájí po půlkách (123 snímků) a agent v něm
 * bliká zhruba pětadvacetkrát za vteřinu — přesně to, co hráč z obřadu
 * vidí. A protože v něm obsluha přerušení nejede, `plFrame` se v těch
 * snímcích vrací dřív, než by na ni došlo: ★ **nestoupne `$E0`, nejdou
 * hodiny a nejedou roboti**, přesně jako na stroji.
 *
 * @param {Object} m - Stroj.
 * @returns {Object|null} Stav obřadu, nebo `null`, když se neumírá.
 */
function dhStart(m) {
  var how = dhLoad(m, DH_DEATH);
  if (how & 0x80) { return {phase: 'gameOver', how: how}; }   // `$95DC`
  if (!dhLoad(m, DH_PLACE)) { dhStore(m, DH_DEATH, 0); return null; }
  dhCopyBlocks(m);                                            // `$95E9`
  // ★ **`$95EC` patří sem, ne jen do `dhDie`**: obřad krájený na snímky je
  // to, co běží ve hře, takže bez tohohle se při smrti neumlčely hlasy
  // a v prohlížeči zůstal viset hukot robota pod celým rozpouštěním.
  // `matchdeath` na to nedosáhne — ten měří `dhDie`, kde ticho je.
  sndSilence(m);                                              // `$95EC`
  if (how === DH_BY_FALL) {
    dhStore(m, DH_SPENA, dhLoad(m, DH_SPENA) & 0xF1);         // `$95FD`
    return {phase: 'fall', how: how};
  }
  return {phase: 'dissolve', how: how, step: 0, credit: 0};
} // dhStart

/**
 * Jeden snímek obřadu — jedno kolo rozpouštění, a po posledním celá stavba.
 * @param {Object} m - Stroj.
 * @param {Object} dying - Co vrátil `dhStart`.
 * @param {function(): number} entropy - Míchačce.
 * @returns {Object} `done` když obřad skončil, `speech`/`gameOver` když došel
 *   tam, kam přepis zatím nesahá.
 */
function dhFrame(m, dying, entropy, passes) {
  if (dying.phase === 'gameOver') { return {done: 1, gameOver: 1}; }
  // ★ **Smrtelný pád se nerozpouští — křičí** (`$95FD`-`$960D`): agent
  // zhasne, řekne se **věta 7** a teprve pak se skočí na stavbu. ★ A mezi
  // tím `$BF51` **čeká, až přehrávač domluví** (`$BF7E`), takže po celou
  // dobu výkřiku je obrazovka **bez agenta** a svět stojí; nová figurka se
  // objeví teprve za ním. Kdo obojí udělá v jednom snímku, postaví agenta
  // dřív, než se výkřik ozve (nahlásil operátor 2026-09-21 — táž vada jako
  // u rozpouštění).
  // ★ Na co se čeká, řekne **čip** (R-047): worker po dobu věty posílá
  // `passes` = 0, tedy „hlavní smyčka neběží", a pustí ji zpráva `spoken`.
  if (dying.phase === 'fall') {
    if (!dying.said) {                                        // `$9605 JSR $BF51`
      dying.said = true;
      return {speech: 7};
    }
    if (passes === 0) { return {}; }                          // pořád se mluví
    dhRebuild(m, entropy);                                    // `$960D JMP $966C`
    dhResume(m);
    return {done: 1};
  }
  // ★ **Jednotka obřadu je zdržení `$9787`, ne kolo rozpouštění**: obřad
  // drží `SEI` a nic v něm na snímek nečeká, takže o jeho tempu rozhodují
  // ty dvě prázdné smyčky v každém bliknutí. Model si proto vede rozpočet
  // cyklů a v jednom snímku udělá tolik půlek, kolik se do něj vejde.
  dying.credit += DH_FRAME_CYCLES;
  var out = {};
  while (dying.credit >= DH_DELAY) {
    dying.credit -= DH_DELAY;
    if (dhCeremonyHalf(m, dying, entropy)) { return dhCeremonyEnd(m, dying, entropy); }
  }
  return out;
} // dhFrame

/**
 * Jedna půlka bliknutí obřadu — úvodních 2 × 17 (`$9610`) a pak 33 kol
 * rozpouštění (`$961F`), z nichž každé svoje bajty vyhodí **na první
 * půlce** svého bliknutí.
 *
 * @param {Object} m - Stroj.
 * @param {Object} dying - Stav obřadu.
 * @param {function(): number} entropy - Míchačce.
 * @returns {boolean} `true`, když byla poslední.
 */
function dhCeremonyHalf(m, dying, entropy) {
  var step = dying.step++;
  if (step < DH_INTRO_HALVES) {
    // `$9610`: sedmnáctkrát dvojicí `$01`, pak sedmnáctkrát dvojicí `$00`
    dhFlashHalf(m, (step >> 1) < DH_INTRO_FLASHES ? 1 : 0, step & 1, entropy);
    return false;
  }
  var at = step - DH_INTRO_HALVES;
  if (!(at & 1)) { dhRoundBytes(m, entropy); }               // `$961F`
  dhFlashHalf(m, 0, at & 1, entropy);                        // `$9643`
  return at + 1 >= DH_ROUND_HALVES;
} // dhCeremonyHalf

/**
 * Co obřad udělá, až doblikal: domaže bloky, umlčí hlasy a postaví
 * místnost znovu (`$964B`-`$96F6`).
 * @param {Object} m - Stroj.
 * @param {Object} dying - Stav obřadu.
 * @param {function(): number} entropy - Míchačce.
 * @returns {Object} `done`.
 */
function dhCeremonyEnd(m, dying, entropy) {
  dhClearBlocks(m);                                           // `$964B`
  // ★ A `$965B` taky (viz `$95EC` výš): krájený obřad je ten, co běží ve
  // hře, takže i on musí na konci rozpouštění oba hlasy umlčet.
  sndSilenceTwo(m);                                           // `$965B`
  if (dying.how === DH_BY_LIFT) { dhEraseLiftColumn(m); }     // `$9663`
  dhRebuild(m, entropy);                                      // `$966C`
  dhResume(m);                                                // `$96F6`
  return {done: 1};
} // dhCeremonyEnd

var death = {
  die: dhDie, start: dhStart, frame: dhFrame, copyBlocks: dhCopyBlocks, dissolve: dhDissolve,
  DELAY: DH_DELAY, FRAME_CYCLES: DH_FRAME_CYCLES,
  flashIntro: dhFlashIntro, roundBytes: dhRoundBytes, flash: dhFlash,
  clearBlocks: dhClearBlocks, eraseLiftColumn: dhEraseLiftColumn,
  rebuild: dhRebuild, resume: dhResume, pick: dhPick,
  ROUNDS: DH_ROUNDS,
  BLOCKS: DH_BLOCKS, PENALTY: DH_PENALTY,
  BY_TOUCH: DH_BY_TOUCH, BY_FALL: DH_BY_FALL, BY_LIFT: DH_BY_LIFT
};
// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
if (typeof self !== 'undefined') {
  self.death = death;
  self.dhDie = dhDie;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = death; }
