// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The security terminal — `$9D09`, and what the game calls a password
 * (`sources/docs/disasm_notes.md` §29).
 *
 * A piece of furniture whose search time is `$FF` is not furniture at all:
 * `$9846` hands it to `$9D09`, which **takes the whole screen**. Four things
 * about it are worth knowing.
 *
 * 1. ★ **It borrows the screen and gives it back.** The picture goes to
 *    `$C100`, the colours to `$0400`, and the VIC registers onto the
 *    **stack** — all sixteen sprite positions, the fifteen colours and the
 *    four mode registers, pushed and pulled in order. Nothing else in the
 *    game does that.
 * 2. ★ **The terminal's screen is packed by runs.** Two streams of pairs
 *    (how many − 1, what): characters from `$3633`, colours from `$37A9`,
 *    and ★ a colour with bit 7 means **take `$E7`** — the background of the
 *    room the agent came from. That is how the terminal is coloured by the
 *    room it stands in.
 * 3. ★ **Its character set is the shaft's** (`$4800`): `$9DCF` just takes
 *    two off `$D018`. There is no terminal font.
 * 4. ★ **What it spends is a digit in the shaft's panel.** `$3439` holds
 *    two screen codes, `$80`-`$88`; searching a `$FC`/`$FD` terminal raises
 *    one (§27) and choosing here lowers it — under `$81`, that is `'0'`, the
 *    answer is „password required" and nothing happens.
 *
 * ★ And the menu is timed by a **delay loop**, not by frames (`$9787`, about
 * 16 700 cycles, so a poll lands roughly every 0,85 snímku). It does not
 * matter, and that is measurable rather than lucky: `$83` latches, so one
 * push is one move whatever the rate. This is polled once a frame.
 */

/** where the room's picture and colours wait while the terminal has the screen */
var TM_SAVED_SCREEN = 0xC100, TM_SAVED_COLOR = 0x0400;

/** the screen and colour memory the VIC shows (§6) */
// ★ **25 řádků, ne 24**: `$9DE6` uloží 24 a smyčka končí `DEC $E4 / BPL`,
// takže proběhne pětadvacetkrát — celá obrazovka C64, 1 000 buněk
var TM_SCREEN = 0x4000, TM_COLOR = 0xD800, TM_CELLS = 1000, TM_COLUMNS = 40;

/**
 * ★ **Odkládá se ale `$400` bajtů, ne `$3E8`** — `$9D22` jede `LDY #$00` …
 * `INY / BNE` nad **čtyřmi celými stránkami**, tedy `$4000`-`$43FF`.
 * A v tom zbytku za obrazovkou leží **ukazatele sprajtů `$43F8`-`$43FF`**,
 * které si terminál přepisuje na svoje (`$9DC6`). Kdo odloží jen tisíc
 * bajtů, vrátí se do hry s ukazateli terminálu — a roboti jsou rozsypaní
 * (nahlásil operátor 2026-09-20).
 */
var TM_SAVED_BYTES = 0x400;

/** the two packed streams and the tables, as `data/terminal.json` lays them */
var TM_RUNS_CHARS = 0x3633, TM_RUNS_COLORS = 0x37A9;
var TM_T_COLORS = 0x9EDA,        // 14 bajtů do `$D021`
    TM_T_SPRITE_POS = 0x9EE8,    // 17 do `$D000`
    TM_T_SPRITE_PTR = 0x9EF9,    // 8 do `$43F8`
    TM_T_CURSOR_STEPS = 0x9FE0,  // o kolik řádků − 1 kurzor skočí
    TM_T_CURSOR = 0x9FED,        // tři znaky kurzoru
    TM_T_ROWS = 0x9FF0,          // odsazení řádků textu
    TM_T_TEXT = 0xA011,          // osm řádků po 24 znacích
    TM_T_ANSWER_AT = 0xA216,     // dvě adresy rámečku odpovědi
    TM_T_COUNTERS = 0xA21A,      // kam v panelu šachty leží počitadla
    TM_T_ANSWERS = 0xA21C,       // dvě hlášky po devatenácti
    TM_T_MENU = 0xA242;          // odsazení tří položek menu

/** the two tables the lift reset works from, and the lists it copies back */
var TM_LIFT_WHERE = 0x1FDA, TM_LIFT_FROM = 0x2016;

/** the counters in the shaft's bottom panel, and the digit that means none */
var TM_COUNTERS = 0x3439, TM_COUNTER_NONE = 0x81;

/** the cursor, the room, and the byte the terminal is coloured from */
var TM_CURSOR = 0x8A, TM_ROOM = 0x7E, TM_TINT = 0xE7;

/** the stack pointer the terminal parks, so a choice can reach the return */
var TM_STACK = 0xE8;

/**
 * ★ **`$A1E5` je zdržení, ne výpočet** — a je to ta část odpovědi, kterou
 * hráč vidí. Mezi nakresleným rámečkem („password required" / „password
 * accepted") a překreslením menu přes něj (`$A1FA`) stojí **prázdná dvojitá
 * smyčka**, čtyři průchody `INX/BNE` × `INY/BNE` řízené `$E4`:
 *
 *     4 × (255×1284 + 1283) + 4×5 + 3×3 + 2 + 9 = **1 314 852 cyklů**
 *
 * tedy **66,9 snímku PAL** (19 656 cyklů na snímek, R-038), zaokrouhleno na
 * **67**. Je to táž past jako `$9787` v obřadu umírání (§31): přepis ji měl
 * jako obyčejný `for` bez hranice snímku, takže se rámeček nakreslil a v tomtéž
 * snímku ho překreslení menu zase smazalo — v prohlížeči po výstřelu **nebylo
 * vidět vůbec nic**, ačkoli se heslo utratilo a výtahy se opravdu vrátily
 * (nahlásil operátor 2026-09-22). ★ `matchsecurity` na to nedosáhne, protože
 * měří **zastávky**, tedy stav na vrcholu průchodu menu — a ten je po zdržení
 * i bez něj týž; prázdná smyčka v paměti nic nenechá.
 */
var TM_ANSWER_CYCLES = 1314852, TM_FRAME_CYCLES = 19656,
    TM_ANSWER_FRAMES = Math.round(TM_ANSWER_CYCLES / TM_FRAME_CYCLES);

/** what a choice does: `$47` back to sleeping, and the orb's flag */
var TM_SNOOZE = 0x47, TM_SNOOZE_VALUE = 0x40, TM_ORB = 0x6D;

/** the room's record, the drawing position and the blank */
var TM_RECORD = 0x81, TM_PTR = 0x10, TM_COLOR_PTR = 0x14, TM_BLANK = 0x53;

/** how the agent died — the lift reset draws elsewhere when he is dead */
var TM_DEATH = 0x43;

/** the joystick, port 2, active low (§7) */
var TM_JOY_UP = 0x01, TM_JOY_DOWN = 0x02, TM_JOY_FIRE = 0x10;

/** the latch that makes one push one move (`$83`), and the fire edge (`$DE`) */
var TM_LATCH = 0x83, TM_FIRE_EDGE = 0xDE;

function tmByte(v) { return v & 0xFF; }
function tmLoad(m, a) { return rbLoad(m, a); }
function tmStore(m, a, v) { rbStore(m, a, v); }
function tmWord(m, a) { return tmLoad(m, a) | (tmLoad(m, a + 1) << 8); }

/**
 * What the terminal needs to find in memory: the two packed streams, the
 * tables and the pristine lift lists. ★ All of it is **data of the
 * program** — the same trap as the stream of robot programs (§24) and the
 * tables of the search (§27).
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} data - The parsed `data/terminal.json`.
 */
function tmSeedMemory(mem, data) {
  var i, at, key;
  if (!data) { return; }
  at = parseInt(data.screen.chars.addr.replace('$', ''), 16);
  for (i = 0; i < data.screen.runs.chars.length; i++) {
    mem[at + i] = data.screen.runs.chars[i] & 0xFF;
  }
  at = parseInt(data.screen.colors.addr.replace('$', ''), 16);
  for (i = 0; i < data.screen.runs.colors.length; i++) {
    mem[at + i] = data.screen.runs.colors[i] & 0xFF;
  }
  for (key in data.tables) {
    if (!Object.prototype.hasOwnProperty.call(data.tables, key)) { continue; }
    at = parseInt(data.tables[key].addr.replace('$', ''), 16);
    for (i = 0; i < data.tables[key].values.length; i++) {
      mem[at + i] = data.tables[key].values[i] & 0xFF;
    }
  }
} // tmSeedMemory

/* ------------------------------------------------------------- the screen */

/**
 * `$9DF8` — the terminal's screen out of the two packed streams.
 *
 * ★ The pair is **(how many − 1, what)** and the count comes **first**
 * (`$9E00` reads `$3633,X`, `$9DFC` reads `$3634,X`), so a run of one is a
 * zero. ★ The character stream is longer than a page, so the original steps
 * its index in a byte and **increments the high byte of its own `LDA`**
 * when it wraps (`$9E11`); the colour stream is short enough not to need it.
 * ★ And a colour with bit 7 set means **take `$E7`** instead.
 *
 * @param {Object} m - The machine.
 */
function tmBuildScreen(m) {
  tmStore(m, TM_PTR, 0x00); tmStore(m, TM_COLOR_PTR, 0x00);     // `$9DD8`
  tmStore(m, TM_PTR + 1, 0x40); tmStore(m, TM_COLOR_PTR + 1, 0xD8);
  var chars = TM_RUNS_CHARS, colors = TM_RUNS_COLORS, tint = tmLoad(m, TM_TINT);
  var row, y, count, value;
  for (row = 0; row <= 24; row++) {                             // `$9DE6`, `$E4`
    for (y = 0; y < TM_COLUMNS;) {                              // `$9DFA`
      count = tmLoad(m, chars); value = tmLoad(m, chars + 1);
      chars += 2;
      for (; count >= 0 && y < TM_COLUMNS; count--, y++) {
        tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, value);
      }
    }
    for (y = 0; y < TM_COLUMNS;) {                              // `$9E1D`
      count = tmLoad(m, colors); value = tmLoad(m, colors + 1);
      colors += 2;
      if (value & 0x80) { value = tint; }                       // `$9E22`
      for (; count >= 0 && y < TM_COLUMNS; count--, y++) {
        tmStore(m, (tmWord(m, TM_COLOR_PTR) + y) & 0xFFFF, value);
      }
    }
    tmMovePtr(m, TM_COLUMNS);                                   // `$AF2F`
  }
} // tmBuildScreen

/** `$AF2F` and `$AF17`: both pointers by the same number of characters */
function tmMovePtr(m, delta) {
  // ★ **Barevný ukazatel se nepřičítá, kopíruje se**: `$AF24` je
  // `STA $10 / STA $14`, tedy do obou jde **táž** dolní půlka, a jen přenos
  // zvedne `$11` i `$15` zvlášť. Dokud oba vyjdou ze stejného místa, je to
  // totéž jako přičítat — a jakmile se jeden nastaví sám (`$9F1A` sáhne
  // jen na `$10`), rozejdou se a **barevný jde za obrazovým**. Přičítat
  // obě čísla zvlášť je chyba, která se pozná až tady (2026-09-20).
  var lo = tmLoad(m, TM_PTR) + delta;
  tmStore(m, TM_PTR, lo & 0xFF);
  tmStore(m, TM_COLOR_PTR, lo & 0xFF);
  var carry = lo > 0xFF ? 1 : (lo < 0 ? -1 : 0);
  if (carry) {
    tmStore(m, TM_PTR + 1, tmByte(tmLoad(m, TM_PTR + 1) + carry));
    tmStore(m, TM_COLOR_PTR + 1, tmByte(tmLoad(m, TM_COLOR_PTR + 1) + carry));
  }
} // tmMovePtr

/** `$9FFF` — one row of the terminal's text, 24 characters from `$A011` */
function tmPutRow(m, from) {
  for (var y = 0; y < 0x18; y++) {
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, tmLoad(m, TM_T_TEXT + tmByte(from + y)));
  }
} // tmPutRow

/** `$9FE2` — the cursor, three characters where the pointer is */
function tmPutCursor(m) {
  for (var y = 2; y >= 0; y--) {
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, tmLoad(m, TM_T_CURSOR + y));
  }
} // tmPutCursor

/** three blanks where the cursor was (`$9FA7`, `$9FC5`) */
function tmEraseCursor(m) {
  for (var y = 2; y >= 0; y--) {
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, TM_BLANK);
  }
} // tmEraseCursor

/* -------------------------------------------------------------- borrowing */

/**
 * `$9D09` up to the menu: the room's picture and the VIC's registers are put
 * away, the terminal's screen is built and the picture comes back on.
 *
 * ★ The registers go onto the **6502 stack** — `$D015`, `$D01D`, `$D017`,
 * `$D01C`, then seventeen of `$D000`-`$D010` and fifteen of `$D020`-`$D02E`.
 * This keeps them in a list instead, and remembers where the first one went
 * (`$E8`), because one choice reaches back for it (`$A0EA`).
 *
 * @param {Object} m - The machine.
 * @returns {Object} The terminal, ready for its menu.
 */
function tmOpen(m) {
  sndTerminal(m);                                         // `$9D17` — a v terminálu je ticho
  var i, saved = {spena: tmLoad(m, 0xD015), expandX: tmLoad(m, 0xD01D),
                  expandY: tmLoad(m, 0xD017), multicolor: tmLoad(m, 0xD01C),
                  sprites: [], colors: []};
  for (i = 0; i < TM_SAVED_BYTES; i++) {                  // `$9D22`, čtyři celé stránky
    tmStore(m, TM_SAVED_SCREEN + i, tmLoad(m, TM_SCREEN + i));
    tmStore(m, TM_SAVED_COLOR + i, tmLoad(m, TM_COLOR + i));
  }
  // ★ `$9D55 TSX / STX $E8` si pamatuje **ukazatel zásobníku**, aby se přes
  // něj dalo sáhnout na uschované `$D015` (`$A0EA`). Zásobník 6502 se tu
  // neemuluje — registry čekají v `saved` — takže `$E8` zůstane, jak je.
  for (i = 0; i <= 0x10; i++) { saved.sprites.push(tmLoad(m, 0xD000 + i)); }
  for (i = 0; i <= 0x0E; i++) { saved.colors.push(tmLoad(m, 0xD020 + i)); }

  // ★ `$9D7A` — čím se terminál obarví: **pozadí místnosti, ze které se do
  // něj vešlo**, vždycky svítivé (`| $08`)
  tmStore(m, TM_TINT, (tmLoad(m, 0xD021) & 0x0F) | 0x08);
  var multi = tmLoad(m, 0xD022) & 0x0F;                   // `$9D83`
  for (i = 0; i <= 3; i++) { tmStore(m, 0x9EE0 + i, multi); }
  tmStore(m, 0x9EDB, multi);
  tmStore(m, 0x9EDC, multi === 0x0C ? 0x0B : 0x0C);       // `$9D93`

  tmStore(m, 0xD011, tmLoad(m, 0xD011) & 0xEF);           // `$9D0C`, obraz zhasne
  tmStore(m, 0xD01D, 0); tmStore(m, 0xD017, 0); tmStore(m, 0xD01C, 0);
  tmStore(m, 0xD015, 0xFF);                               // `$9DA9`
  for (i = 0x0D; i >= 0; i--) {                           // `$9DB0`
    tmStore(m, 0xD021 + i, tmLoad(m, TM_T_COLORS + i));
  }
  for (i = 0x10; i >= 0; i--) {                           // `$9DBB`
    tmStore(m, 0xD000 + i, tmLoad(m, TM_T_SPRITE_POS + i));
  }
  for (i = 0x07; i >= 0; i--) {                           // `$9DC6`
    tmStore(m, 0x43F8 + i, tmLoad(m, TM_T_SPRITE_PTR + i));
  }
  // ★ `$9DCF` — sada terminálu žádná není, jsou to **dvě níž**: ze sady
  // místnosti (`$04`, `$5000`) na sadu šachty (`$02`, `$4800`)
  tmStore(m, 0xD018, tmByte(tmLoad(m, 0xD018) - 2));
  tmBuildScreen(m);
  tmStore(m, 0xD011, tmLoad(m, 0xD011) | 0x10);           // `$9E48`, a rozsvítí
  // ★ Hlavička a kurzor **tady ještě nejsou**: `$9E50 JSR $9F01` je až za
  // rozsvícením obrazu, takže past `$9E50` je vidí nenapsané.
  return {phase: 'menu', saved: saved, chose: 0, done: 0, headed: 0};
} // tmOpen

/**
 * `$9F01` — the head of the menu: the room's number in decimal, the eight
 * rows of text, and the cursor on the last item.
 *
 * ★ The number is turned into two characters by **subtracting ten until it
 * borrows** and the two are written **into the text itself** (`$A03B`,
 * `$A03C`) — the terminal says which room it is by rewriting its own screen
 * data.
 *
 * @param {Object} m - The machine.
 */
function tmHeader(m) {
  var a = tmLoad(m, TM_ROOM), tens = 0xFF;                // `$9F01`
  while (a >= 10) { a -= 10; tens = tmByte(tens + 1); }
  tens = tmByte(tens + 1);
  tmStore(m, 0xA03C, tmByte(a + 0x8B));
  tmStore(m, 0xA03B, tmByte(tens + 0x8B));
  tmStore(m, TM_PTR, 0x7E); tmStore(m, TM_PTR + 1, 0x40);  // `$9F1A`, `$407E`
  // ★ `$9F22` se ptá rastru, a je to **spolehnutí na to, že je vysoko**:
  // pod `$FB` by skočilo na `$9F3B` s **neurčeným `Y`**. V praxi vysoko je
  // (kód před tím udělal spoustu práce) a větev se **vezme** — napíše tři
  // `$95` a posune **jen `$10`**, ne barevný ukazatel.
  var y;
  for (y = 2; y >= 0; y--) {                               // `$9F29`
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, 0x95);
  }
  tmStore(m, TM_PTR, tmByte(tmLoad(m, TM_PTR) + 4));       // `$9F34`
  for (y = 0x0E; y >= 0; y--) {                            // `$9F3B`
    tmPutRow(m, tmLoad(m, TM_T_ROWS + y));
    tmMovePtr(m, TM_COLUMNS);
  }
  tmStore(m, TM_CURSOR, 0x02);                             // `$9F4E`
  tmStore(m, TM_PTR, 0xAE); tmStore(m, TM_PTR + 1, 0x42);  // `$9F52`, `$42AE`
  tmPutCursor(m);
} // tmHeader

/* ---------------------------------------------------------------- the menu */

/**
 * `$9F68` — one look at the stick.
 *
 * ★ The original looks about **every 0,85 snímku** (a delay loop, `$9787`),
 * not once a frame — and it does not matter, because `$83` latches: one push
 * is one move whatever the rate. The fire button has its own edge (`$DE`).
 *
 * @param {Object} m - The machine.
 * @param {Object} term - What `tmOpen` returned.
 * @param {number} joy - What `$DC00` would give.
 */
function tmMenuFrame(m, term, joy) {
  // ★ Pořadí je to, co dělá smyčka: **nejdřív dopadne čtení z minulého
  // průchodu** (`$9F92`-`$9FDD`), pak se čte střelba (`$9F68`) a nakonec
  // páka (`$9F89`) — a ta se projeví až příště. Past záznamu sedí přesně
  // mezi posledními dvěma, takže se to musí dělat v tomhle pořadí.
  tmActStick(m, term);
  var fire = joy & TM_JOY_FIRE;
  if (!fire && tmLoad(m, TM_FIRE_EDGE)) {                  // `$9F68`
    // ★ `$9F73` si **kreslicí polohu schová na zásobník** a `$9F7C` ji
    // vrátí: volba si `$10`/`$11` přestaví po svém (rámeček odpovědi je
    // jinde než kurzor), ale kurzor musí zůstat, kde byl.
    var keepLo = tmLoad(m, TM_PTR), keepHi = tmLoad(m, TM_PTR + 1);
    tmChoose(m, term, keepLo, keepHi);
    // ★ **Odchod se sem nevrátí**: `$A0DD` sundá čtyři bajty ze zásobníku,
    // takže `$9F7C` ani `$9F82` neproběhnou — kreslicí poloha se nevrací
    // a `$DE` zůstane, jak bylo. U ostatních voleb obojí ano — ale až za
    // zdržením `$A1E5`, tedy v `tmAnswerDone`.
  } else {
    tmStore(m, TM_FIRE_EDGE, fire);                        // `$9F84`
  }
  term.stick = joy & (TM_JOY_UP | TM_JOY_DOWN);            // `$9F89`
} // tmMenuFrame

/**
 * `$9F92`-`$9FDD` — co udělá páka přečtená **minulý** průchod.
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 */
function tmActStick(m, term) {
  var stick = term.stick;
  if (stick === undefined) { return; }
  if (stick === (TM_JOY_UP | TM_JOY_DOWN)) {               // páka na střed
    tmStore(m, TM_LATCH, 0);                               // `$9F92` → `$9F66`
    return;
  }
  if (tmLoad(m, TM_LATCH)) { return; }                     // `$9F96`, drží se
  tmStore(m, TM_LATCH, 1);                                 // `$9F9A`
  var at = tmLoad(m, TM_CURSOR);
  // ★ `$9F9C CMP #$02; BCC` — rozhoduje se **pod dvěma**, ne rovností: páka
  // dolů dá 1, nahoru 2, a **obě naráz dá nulu**, kterou originál bere jako
  // dolů. Kdo se zeptá na rovnost s jedničkou, chová se u obou pák jinak.
  if (stick < 2) {                                         // `$9FBF`, dolů
    if (at >= 2) { return; }                               // `$9FC1`
    tmEraseCursor(m);
    tmMovePtr(m, TM_COLUMNS * (tmLoad(m, TM_T_CURSOR_STEPS + at) + 1));
    tmStore(m, TM_CURSOR, at + 1);
  } else {                                                 // `$9FA0`, nahoru
    if (at === 0) { return; }
    tmStore(m, TM_CURSOR, at - 1);
    tmEraseCursor(m);
    tmMovePtr(m, -TM_COLUMNS * (tmLoad(m, TM_T_CURSOR_STEPS + (at - 1)) + 1));
  }
  tmPutCursor(m);
} // tmActStick

/* ------------------------------------------------------------- the choice */

/**
 * `$A0D1` — the button. ★ The third item is not a thing the terminal does,
 * it is **four bytes off the stack** (`$A0DD`): the terminal and the search
 * that opened it both return at once, which is why leaving is instant.
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 */
function tmChoose(m, term, keepLo, keepHi) {
  var at = tmLoad(m, TM_CURSOR);
  if (at >= 2) {                                           // `$A196` → `$A19A RTS`
    term.chose = 'leave';                                  // `$A0DD`
    term.phase = 'close';
    return;
  }
  // ★ **Odpověď se nakreslí teď a dopadne za 67 snímků**: mezi rámečkem
  // a překreslením menu stojí zdržení `$A1E5` (viz `TM_ANSWER_FRAMES`), a
  // teprve za ním se volba provede — `$A0D4` je až za `JSR $A194`.
  term.answer = {at: at, ok: tmAnswerDraw(m, term), wait: TM_ANSWER_FRAMES,
                 keepLo: keepLo, keepHi: keepHi};
  term.phase = 'answer';
} // tmChoose

/**
 * `$A1F7`-`$A215` a `$A0D4` — co se stane, **až zdržení doběhne**: menu se
 * překreslí přes rámeček a přijatá volba se provede.
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 */
function tmAnswerDone(m, term) {
  var answer = term.answer;
  tmAnswerClose(m);                                        // `$A1F7`-`$A212`
  if (answer.ok) {                                         // `$A0D4`
    if (answer.at === 0) { tmLiftReset(m); term.chose = 'liftReset'; }
    else { tmSnooze(m, term); term.chose = 'snooze'; }
  }
  tmStore(m, TM_PTR + 1, answer.keepHi);                   // `$9F7C`
  tmStore(m, TM_PTR, answer.keepLo);
  tmStore(m, TM_FIRE_EDGE, 0);                             // `$9F82`
  term.answer = null;
  term.phase = 'menu';
} // tmAnswerDone

/**
 * `$A194` — the answer box: „password required" or „password accepted".
 *
 * ★ What is counted is a **screen code in the shaft's panel** (`$3439`),
 * `$80` to `$88`. Under `$81` — that is `'0'` — the answer is „required" and
 * nothing is spent; otherwise one is taken and the answer is „accepted".
 * ★ The third item of the menu never gets here (`$A196`), and comes back
 * **accepted**, which is what lets it leave.
 *
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 * @returns {boolean} Whether the choice goes through.
 */
function tmAnswerDraw(m, term) {
  var at = tmLoad(m, TM_CURSOR), i, y;
  if (at >= 2) { return true; }                            // `$A196`
  tmStore(m, TM_PTR, tmLoad(m, TM_T_ANSWER_AT + at));      // `$A19B`
  tmStore(m, TM_PTR + 1, tmLoad(m, TM_T_ANSWER_AT + 2 + at));
  for (i = 2; i >= 0; i--) {                               // `$A1A7`, tři řádky
    y = 0x16;
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, TM_BLANK); y--;
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, TM_BLANK); y--;
    for (; y >= 0; y--) { tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, 0xFD); }
    tmMovePtr(m, TM_COLUMNS);
  }
  var spot = tmLoad(m, TM_T_COUNTERS + at);                // `$A1C0`
  var digit = tmLoad(m, TM_COUNTERS + spot);
  var from = 0x12, ok = digit >= TM_COUNTER_NONE;
  if (ok) {                                                // `$A1CA`
    from = 0x25;
    tmStore(m, TM_COUNTERS + spot, tmByte(digit - 1));
  }
  tmMovePtr(m, -TM_COLUMNS); tmMovePtr(m, -TM_COLUMNS);    // `$A1D2`
  for (y = 0x13, i = from; y >= 1; y--, i--) {             // `$A1DC`
    tmStore(m, (tmWord(m, TM_PTR) + y) & 0xFFFF, tmLoad(m, TM_T_ANSWERS + i));
  }
  // ★ a tady je **konec první půlky**: `$A1E5` čeká 67 snímků a rámeček je
  // po tu dobu na obrazovce. Zbytek dodělá `tmAnswerClose`.
  return ok;
} // tmAnswerDraw

/**
 * `$A1F7`-`$A212` — druhá půlka odpovědi: menu se překreslí **přes rámeček**.
 * Na stroji je to až za zdržením `$A1E5`, proto je to vlastní rutina.
 * @param {Object} m - The machine.
 */
function tmAnswerClose(m) {
  var at = tmLoad(m, TM_CURSOR), i;
  tmMovePtr(m, -TM_COLUMNS);                               // `$A1F7`
  var menu = at*3 + 2;                                     // `$A1FA`
  for (i = 2; i >= 0; i--, menu--) {                       // `$A206`
    tmPutRow(m, tmLoad(m, TM_T_MENU + menu));
    tmMovePtr(m, TM_COLUMNS);
  }
} // tmAnswerClose

/**
 * `$A0E2` — snooze: the robots go back to sleeping (`$47`), and ★ when the
 * room has **no orb**, sprite 0 is turned off in the copy of `$D015` that
 * waits on the stack (`$A0EA`) — so when the screen comes back, the bolt the
 * robots borrow is gone with them.
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 */
function tmSnooze(m, term) {
  tmStore(m, TM_SNOOZE, TM_SNOOZE_VALUE);
  if (tmLoad(m, TM_ORB) & 0x80) { term.saved.spena &= 0xFE; }
} // tmSnooze

/**
 * `$A0F5` — lift reset: every lift of the room goes back where it started.
 *
 * ★ It does it in **three passes over the room's own record**: the tiles are
 * erased where the lifts are now, the record is replaced by a pristine copy
 * from `$2016`, and the tiles are drawn where the lifts are again.
 * ★ And it draws into the **parked** picture (`$C100`/`$0400`), not the one
 * on the screen — the terminal has the screen — so the lifts have already
 * moved when it hands it back. Only a dead agent gets it drawn straight to
 * `$4000` (`$A102`).
 *
 * @param {Object} m - The machine.
 */
function tmLiftReset(m) {
  var base = tmWord(m, TM_RECORD), dead = tmLoad(m, TM_DEATH), y, count, i;
  var at = function (o) { return tmLoad(m, (base + tmByte(o)) & 0xFFFF); };

  for (y = 0; !(at(y) & 0x80);) {                          // `$A0F7`
    // ★ `$AC1B` nechá `Y` na **sloupci**, ne na počtu plošin — `$A109` proto
    // udělá `INY` a teprve pak čte. Vzít počet rovnou znamená erase přes půl
    // obrazovky, a je to vidět až na schované místnosti (2026-09-20).
    y = tmByte(tmCellAddress(m, base, y, dead, false) + 1);
    count = at(y);                                         // `$A10A`
    var keep = y;
    for (i = count; i >= 0; i--) {                         // `$A10F`
      tmEraseCursor(m);                                    // tři `$53`
      tmMovePtr(m, -TM_COLUMNS * 6);                       // `$AEEB`
    }
    y = keep;
    while (at(y) !== 0xFF) { y = tmByte(y + 1); }          // `$A120`
    y = tmByte(y + 1);
  }
  if (y === 0) { return; }                                 // `$A12A`

  for (i = 0; ; i += 2) {                                  // `$A130`
    if (tmLoad(m, TM_LIFT_WHERE + i) === tmLoad(m, TM_RECORD)
        && tmLoad(m, TM_LIFT_WHERE + i + 1) === tmLoad(m, TM_RECORD + 1)) { break; }
  }
  var from = tmLoad(m, TM_LIFT_FROM + i) | (tmLoad(m, TM_LIFT_FROM + i + 1) << 8);
  var last = 0;                                            // `$A14D`
  for (y = 0; ; y++) {                                     // `$A150`
    var v = tmLoad(m, (from + y) & 0xFFFF);
    tmStore(m, (base + y) & 0xFFFF, v);
    if (v === 0xFF && last === 0xFF) { break; }            // dva `$FF` za sebou
    last = v;
  }

  for (y = 0; !(at(y) & 0x80);) {                          // `$A161`
    y = tmByte(tmCellAddress(m, base, y, dead, true) + 1);  // `$A17E INY`
    count = at(y);                                         // `$A17F`
    for (i = count; i >= 0; i--) {
      rbLiftTile(m);                                       // `$AC4E`
      tmMovePtr(m, -TM_COLUMNS * 6);                       // `$AEEB`
    }
    while (at(y) !== 0xFF) { y = tmByte(y + 1); }          // `$A18B`
    y = tmByte(y + 1);
  }
} // tmLiftReset

/**
 * `$AC1B` with the twist the lift reset needs: while the terminal has the
 * screen, the room's picture is parked at `$C100` and its colours at
 * `$0400`, so the drawing goes **there**.
 * @param {Object} m - The machine.
 * @param {number} base - The room's record.
 * @param {number} y - The offset of the row byte.
 * @param {number} dead - `$43`.
 * @param {boolean} color - Whether the colour pointer is moved too.
 * @returns {number} The offset after the pair.
 */
function tmCellAddress(m, base, y, dead, color) {
  y = roomLift.cellAddress(m, base, y);                    // `$AC1B`
  if (dead) {                                              // `$A102`, `$A16D`
    tmStore(m, TM_PTR + 1, tmByte(tmLoad(m, TM_PTR + 1) - 0x81));
  } else if (color) {                                      // `$A177`
    tmStore(m, TM_COLOR_PTR + 1, tmByte(tmLoad(m, TM_COLOR_PTR + 1) + 0x2C));
  }
  return y;
} // tmCellAddress

/* -------------------------------------------------------------- giving back */

/**
 * `$9E53` — the room comes back: the picture, the colours, the character set
 * and every register that was put away, in the order the stack gives them.
 * @param {Object} m - The machine.
 * @param {Object} term - The terminal.
 */
function tmClose(m, term) {
  var i;
  tmStore(m, 0xD011, tmLoad(m, 0xD011) & 0xEF);            // `$9E5A`
  for (i = 0; i < TM_SAVED_BYTES; i++) {                   // `$9E62`
    tmStore(m, TM_SCREEN + i, tmLoad(m, TM_SAVED_SCREEN + i));
    tmStore(m, TM_COLOR + i, tmLoad(m, TM_SAVED_COLOR + i));
  }
  tmStore(m, 0xD018, tmByte(tmLoad(m, 0xD018) + 2));       // `$9E97`
  for (i = 0; i <= 0x0E; i++) { tmStore(m, 0xD020 + i, term.saved.colors[i]); }
  for (i = 0; i <= 0x10; i++) { tmStore(m, 0xD000 + i, term.saved.sprites[i]); }
  tmStore(m, 0xD01C, term.saved.multicolor);               // `$9EB6`
  tmStore(m, 0xD017, term.saved.expandY);
  tmStore(m, 0xD01D, term.saved.expandX);
  tmStore(m, 0xD015, term.saved.spena);
  tmStore(m, 0xD011, tmLoad(m, 0xD011) | 0x10);            // `$9ECD`
  term.done = 1;
} // tmClose

/**
 * One frame of the terminal — and there are only two kinds: the one that
 * builds it (`$9D09`, after its own `JSR $7F6B`) and the ones that watch the
 * stick. ★ Everything else inside `$9D09` waits on the **raster**, not on
 * `$E0`, so it all lands in the frame it started in.
 *
 * @param {Object} m - The machine.
 * @param {Object} term - What `tmStart` returned, or null the first time.
 * @param {number} joy - What `$DC00` would give.
 * @returns {{done: number, chose: (number|string)}} What happened.
 */
function tmFrame(m, term, joy) {
  if (term.phase === 'open') {
    var built = tmOpen(m);
    term.saved = built.saved;
    term.phase = 'menu';
    term.headed = 0;
    return {done: 0, chose: 0};
  }
  // ★ **Zdržení `$A1E5`**: rámeček s odpovědí drží 67 snímků a hra v nich
  // nečte ani páku, ani střelbu — je to prázdná smyčka uvnitř `$A194`.
  if (term.phase === 'answer') {
    term.answer.wait--;
    if (term.answer.wait > 0) { return {done: 0, chose: term.chose}; }
    tmAnswerDone(m, term);
    return {done: 0, chose: term.chose};
  }
  if (term.phase === 'menu') {
    if (!term.headed) {                                    // `$9F01`
      tmHeader(m);
      tmStore(m, TM_FIRE_EDGE, TM_JOY_FIRE);               // `$9F5D`, páka na středu
      tmStore(m, TM_LATCH, 1);                             // `$9F64`
      term.headed = 1;
    }
    tmMenuFrame(m, term, joy);
    if (term.phase !== 'close') { return {done: 0, chose: term.chose}; }
  }
  tmClose(m, term);                                        // `$9E53`
  return {done: 1, chose: term.chose};
} // tmFrame

/** `$9846` — the terminal begins; the frame after is `$9D09` itself */
function tmStart() {
  return {phase: 'open', saved: null, chose: 0, done: 0, headed: 0, answer: null};
}

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var terminal = {
  seedMemory: tmSeedMemory, buildScreen: tmBuildScreen,
  start: tmStart, frame: tmFrame, open: tmOpen, close: tmClose,
  liftReset: tmLiftReset, answer: tmAnswerDraw, answerClose: tmAnswerClose,
  ANSWER_FRAMES: TM_ANSWER_FRAMES,
  SCREEN: TM_SCREEN, CURSOR: TM_CURSOR, COUNTERS: TM_COUNTERS
};
if (typeof self !== 'undefined') {
  self.terminal = terminal;
  self.tmStart = tmStart;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = terminal; }
