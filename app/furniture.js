// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * Searching a piece of furniture — `$97F1`, the routine the whole game
 * hangs on (`sources/docs/disasm_notes.md` §27).
 *
 * The agent stands in front of something, pushes the stick up, a window
 * opens over his head, a bar counts down, and either he finds a piece of the
 * puzzle or he does not. Four things about it are worth knowing before
 * reading the code.
 *
 * 1. ★ **The window is not a picture, it is a character set.** The game
 *    puts codes `$00`-`$1F` on the screen and **rewrites their glyphs** at
 *    `$5000` while the window is open (`$9850`, `$993C`, `$99DF`). That is
 *    why the tables in `data/furniture.json` are glyphs, not bitmaps, and
 *    why the room's own character set is ruined for as long as it is open —
 *    the original does not care, because nothing else in the room uses codes
 *    under `$20`.
 * 2. ★ **What is under the window is saved and put back** (`$9BBB` into
 *    `$C100`/`$C120`, `$9C1B` out of it). The window therefore leaves no
 *    trace, and neither does the search — except on the furniture itself.
 * 3. ★ **The furniture remembers.** `$9B28` writes `$F0` into the record at
 *    `$4F5A,X` **and into the room's own record** through `$87`/`$86`, so a
 *    searched piece stays searched when the agent comes back (`ZADANI.md`
 *    §5). The one exception is the lift reset (`$FE`), which is not used up.
 * 4. ★ **Letting go of the stick stops it.** Unlike the lift in a room
 *    (§25), the search asks the stick **every frame** (`$98B8`, `$99C7`):
 *    let go while the bar is running and the window shuts with nothing
 *    found, and the piece is **not** marked searched.
 *
 * Like every other part of this remake it works on the machine's memory, so
 * running it on the memory the original had has to produce the same bytes
 * (`tools/matchsearch.mjs` against `tools/tracesearch.py`).
 */

/** the furniture records the search reads, six bytes a piece (`$4F55`) */
var FU_RECORDS = 0x4F55;

/** and what the six bytes are */
var FU_START_LO = 0, FU_START_HI = 1, FU_END_LO = 2, FU_END_HI = 3,
    FU_SEARCH = 4, FU_HOLDS = 5, FU_STRIDE = 6;

/** what a piece of furniture can hold (`$98F3`) */
// ★ `$FD` je **SNOOZE**, `$FC` **LIFT INIT** — jsou to **hesla**, ne
// terminály: v nábytku se **najdou** a utratí se až v bezpečnostním
// terminálu (§29). `$FE` je **řídicí místnost** (v pevnosti jedna, vždy
// místnost 5) a `$FB` **kódová místnost** (dvě, `$11` a `$1B`).
var FU_NOTHING = 0xFF, FU_CONTROL_ROOM = 0xFE, FU_CODE_ROOM = 0xFB,
    FU_PASSWORD = 0xFC, FU_EMPTIED = 0xF0;

/** the list of pieces found so far, ended by `$FF`, and their backgrounds */
var FU_FOUND = 0x4EF5, FU_FOUND_COLORS = 0x4F25;

/** how many pieces and how many terminals the agent has been through */
var FU_PIECES = 0xD6, FU_PASSWORDS = 0xD7;

/** the counters in the shaft's bottom panel, and where in it they sit */
var FU_COUNTERS = 0x3439, FU_COUNTER_SPOTS = 0xA21A, FU_COUNTER_MAX = 0x89;

/** the room's own record: the furniture list and the offset into it */
var FU_RECORD_PTR = 0x87, FU_RECORD_AT = 0x86, FU_RECORD_FIRST = 0x03,
    FU_RECORD_STRIDE = 0x04;

/** the character set the window's glyphs are written into (§6) */
var FU_CHARSET = 0x5000;

/** where the window's old contents wait while it is open (`$9BBB`) */
var FU_SAVED = 0xC100, FU_SAVED_COLOR = 0xC120;

/** the drawing position, shared with the room lift (`$AC1B`, §25) */
var FU_PTR = 0x10, FU_COLOR_PTR = 0x14;

/** the window: eight characters by four rows */
var FU_WIDE = 8, FU_TALL = 4;

/** the agent: his state, and the one the search puts him in (`$9835`) */
var FU_STATE = 0x3F, FU_SEARCHING = 0x0F;

/** how he died, and the blank a room is filled with */
var FU_DEATH = 0x43, FU_BLANK = 0x53, FU_WIPE = 0x52;

/** the floor characters `$9B6F` refuses to erase */
var FU_FLOOR_FROM = 0x45, FU_FLOOR_TO = 0x4C;

/** the joystick, port 2, active low (§7) */
var FU_JOY_UP = 0x01;

function fuByte(v) { return v & 0xFF; }
function fuLoad(m, a) { return rbLoad(m, a); }
function fuStore(m, a, v) { rbStore(m, a, v); }
function fuWord(m, a) { return fuLoad(m, a) | (fuLoad(m, a + 1) << 8); }

/**
 * ★ The band of tables `$99ED`-`$9B27` and the two terminal windows are
 * **data of the program**, not anything the fortress draws — the same trap
 * as the stream of robot programs (§24). Nothing in the remake puts them in
 * memory unless `fuSeedMemory` does, and **no `match*` can notice**, because
 * every gauge starts from a dump of the original's memory where they are.
 * `data/furniture.json` carries them and `tools/runworker.mjs` watches.
 */
var FU_T_PROGRESS = 0x99ED,          // čtyři fáze ukazatele postupu
    FU_T_WINDOW_FOUND = 0x99F1,      // rozvržení okna s nálezem
    FU_T_WINDOW_EMPTY = 0x9A11,      // rozvržení okna „nic"
    FU_T_WINDOW_SEARCHING = 0x9A31,  // rozvržení okna s ukazatelem
    FU_T_BAR_GLYPHS = 0x9A51,        // 64 glyfů ukazatele na `$5000`
    FU_T_BAR_STOP = 0x9A91,          // tři glyfy zarážky na `$5078`
    FU_T_EMPTY_WINDOW = 0x9A94,      // 144 glyfů okna „nic"
    FU_T_TERM_LO = 0x9B24,           // ukazatele na okna terminálu
    FU_T_TERM_HI = 0x9B26;

/**
 * What the search needs to find in memory before it can run once: the band
 * of tables, the two terminal windows, and the two places in the shaft's
 * panel where the counters sit.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} data - The parsed `data/furniture.json`.
 */
function fuSeedMemory(mem, data) {
  var i, at, w;
  if (!data) { return; }
  at = parseInt(data.block.addr.replace('$', ''), 16);
  for (i = 0; i < data.block.values.length; i++) {
    mem[at + i] = data.block.values[i] & 0xFF;
  }
  for (w = 0; w < data.terminalWindows.length; w++) {
    at = parseInt(data.terminalWindows[w].addr.replace('$', ''), 16);
    for (i = 0; i < data.terminalWindows[w].values.length; i++) {
      mem[at + i] = data.terminalWindows[w].values[i] & 0xFF;
    }
  }
  var spots = data.tables.counterSpots;
  at = parseInt(spots.addr.replace('$', ''), 16);
  for (i = 0; i < spots.values.length; i++) { mem[at + i] = spots.values[i] & 0xFF; }
} // fuSeedMemory

/* ------------------------------------------------------------- the window */

/**
 * `$9BBB` — where the window goes, and what was there before it.
 *
 * ★ The position comes from the agent's **left and bottom edges**, like
 * everything else about him (§17), and it is pulled back onto the screen by
 * hand: a column past `$1F` has `$0D` taken off it (`$9BC1`), so a window
 * never hangs over the right edge. Four rows of eight characters and their
 * colours go into `$C100` and `$C120` to wait.
 *
 * @param {Object} m - The machine.
 */
function fuOpen(m) {
  var edge = plLeftEdge(m);                              // `$9BBB`
  var a = fuByte((edge.c ? 0x80 : 0) | (edge.a >> 1));   // ROR A
  a = a >> 2;                                            // LSR A × 2
  if (a >= 0x1F) { a = fuByte(a - 0x0D); }               // `$9BC1`
  fuStore(m, 0xE4, fuByte(a + 1));                       // `$9BC7` STA / INC
  fuStore(m, 0xE6, 0);
  var bottom = plBottomEdge(m) - 0x60;                   // `$9BCF`
  if (bottom < 0) { bottom = 0; }
  bottom = fuByte(bottom) & 0xF8;
  fuStore(m, 0xE5, bottom);
  var wide = bottom * 4;                                 // ASL A / ROL $E6, dvakrát
  fuStore(m, 0xE6, (wide >> 8) & 0xFF);
  var sum = (wide & 0xFF) + bottom;                      // ADC $E5 → řádek * 40
  if (sum > 0xFF) { fuStore(m, 0xE6, fuByte(fuLoad(m, 0xE6) + 1)); }
  sum = fuByte(sum) + fuLoad(m, 0xE4);
  var hi = fuLoad(m, 0xE6) + 0x40 + (sum > 0xFF ? 1 : 0);
  fuStore(m, FU_PTR, fuByte(sum));
  fuStore(m, FU_COLOR_PTR, fuByte(sum));
  fuStore(m, FU_PTR + 1, fuByte(hi));
  fuStore(m, FU_COLOR_PTR + 1, fuByte(hi + 0x98));       // `$9BF7`, `$40` → `$D8`
  fuEachCell(m, function (screen, color, at) {           // `$9BFC`
    fuStore(m, FU_SAVED + at, fuLoad(m, screen));
    fuStore(m, FU_SAVED_COLOR + at, fuLoad(m, color));
  }, true);                                              // `$9C17 JSR $AF0F`
} // fuOpen

/**
 * `$9C1B` — the window closes and what was under it comes back. A frame of
 * its own, like everything the original draws (`$9C1B JSR $7F6B`).
 * @param {Object} m - The machine.
 */
function fuClose(m) {
  // ★ A **nevrací ukazatel**, na rozdíl od otevření: `$9C39` je rovnou `RTS`,
  // kdežto `$9C17` ještě udělá `JSR $AF0F`. Po zavření okna proto `$10`/`$11`
  // ukazují o čtyři řádky níž — a je to vidět, protože se to srovnává.
  fuEachCell(m, function (screen, color, at) {
    fuStore(m, screen, fuLoad(m, FU_SAVED + at));
    fuStore(m, color, fuLoad(m, FU_SAVED_COLOR + at));
  }, false);
} // fuClose

/**
 * The walk over the window's thirty-two cells that `$9BFC`, `$9C1E` and
 * `$9B9F` all do: eight across, four down, the pointer stepping a row at a
 * time and coming back to where it began (`$AF2F` four times, `$AF0F` once).
 * @param {Object} m - The machine.
 * @param {Function} what - `(screenAddr, colorAddr, index)` per cell.
 * @param {boolean} rewind - Whether the pointer goes back (`$AF0F`); only
 *   `$9BBB` does, `$9C1B` leaves it four rows down.
 */
function fuEachCell(m, what, rewind) {
  var at = 0, row, y;
  for (row = 0; row < FU_TALL; row++) {
    for (y = 0; y < FU_WIDE; y++) {
      what((fuWord(m, FU_PTR) + y) & 0xFFFF,
           (fuWord(m, FU_COLOR_PTR) + y) & 0xFFFF, at);
      at++;
    }
    fuMovePtr(m, 40);                                    // `$AF2F`
  }
  if (rewind) { fuMovePtr(m, -160); }                    // `$AF0F`
} // fuEachCell

/** `$AF2F` and `$AF0F`: both pointers by the same number of characters */
function fuMovePtr(m, delta) {
  var screen = (fuWord(m, FU_PTR) + delta) & 0xFFFF;
  var color = (fuWord(m, FU_COLOR_PTR) + delta) & 0xFFFF;
  fuStore(m, FU_PTR, screen & 0xFF); fuStore(m, FU_PTR + 1, screen >> 8);
  fuStore(m, FU_COLOR_PTR, color & 0xFF); fuStore(m, FU_COLOR_PTR + 1, color >> 8);
} // fuMovePtr

/**
 * `$9B96` — the window drawn: thirty-two characters out of one of the three
 * layouts, **right to left** in each row (`LDY #$07` … `DEY`), all in white.
 * ★ It waits a frame of its own first (`$9B9C`), so every window costs one.
 * @param {Object} m - The machine.
 * @param {number} layout - Where the layout is: `$99F1`, `$9A11` or `$9A31`.
 */
function fuDrawWindow(m, layout) {
  var at = 0, row, y;
  for (row = 0; row < FU_TALL; row++) {
    for (y = FU_WIDE - 1; y >= 0; y--) {
      fuStore(m, (fuWord(m, FU_PTR) + y) & 0xFFFF, fuLoad(m, layout + at));
      fuStore(m, (fuWord(m, FU_COLOR_PTR) + y) & 0xFFFF, 0x01);
      at++;
    }
    fuMovePtr(m, 40);
  }
  fuMovePtr(m, -160);
} // fuDrawWindow

/* ------------------------------------------------ which piece of furniture */

/**
 * `$97FA` — which piece of furniture the agent's hand is over.
 *
 * ★ The records are walked **six bytes at a time** and the room's own record
 * **four**, side by side (`$981C`), because the two lists are the same list
 * seen twice: `$4F55` is what the builder made of it and `$87`/`$86` is
 * where it came from. That second offset is the only reason a searched
 * piece stays searched.
 *
 * ★ And the rectangle test is **not a sixteen-bit comparison**, it is four
 * eight-bit ones in a row (`$9800`-`$981A`), so a piece of furniture that
 * straddled a page boundary would be found by the wrong half. None does.
 *
 * @param {Object} m - The machine, with `$10`/`$11` on the cell asked about.
 * @returns {number} The offset into `$4F55` of the piece, or -1.
 */
function fuUnderHand(m) {
  var x = 0, lo = fuLoad(m, FU_PTR), hi = fuLoad(m, FU_PTR + 1);
  fuStore(m, FU_RECORD_AT, FU_RECORD_FIRST);             // `$97FC`
  for (;;) {
    var at = FU_RECORDS + x;
    if (hi >= fuLoad(m, at + FU_START_HI)                // `$9800`
        && lo >= fuLoad(m, at + FU_START_LO)
        && fuLoad(m, at + FU_END_HI) >= hi
        && fuLoad(m, at + FU_END_LO) >= lo) {
      return x;                                          // `$9830`
    }
    x = fuByte(x + FU_STRIDE);                           // `$981C`
    fuStore(m, FU_RECORD_AT, fuByte(fuLoad(m, FU_RECORD_AT) + FU_RECORD_STRIDE));
    if (fuLoad(m, FU_RECORDS + x) === 0xFF) { return -1; }   // `$9828`
  }
} // fuUnderHand

/* --------------------------------------------------------------- the bar */

/**
 * `$984D` — the progress bar, set up from how long this piece takes.
 *
 * ★ The bar is **sixty-four bytes of glyphs** written straight into the
 * character set (`$5000`-`$503F`), with `$5040`-`$507F` filled with `$FF`
 * and three more glyphs at `$5078`. Then as many **whole** glyphs as
 * `search >> 5` are blanked and the remainder `search >> 3 & 3` picks one of
 * the four phases `$99ED`. So the bar is not an animation of a bar, it is
 * the number itself, drawn.
 *
 * @param {Object} m - The machine.
 * @param {number} search - How long this piece takes (`$4F59,X`).
 */
function fuBarSetup(m, search) {
  var i;
  for (i = 0x3F; i >= 0; i--) {                          // `$9850`
    fuStore(m, FU_CHARSET + i, fuLoad(m, FU_T_BAR_GLYPHS + i));
    fuStore(m, FU_CHARSET + 0x40 + i, 0xFF);
  }
  for (i = 2; i >= 0; i--) {                             // `$9860`
    fuStore(m, FU_CHARSET + 0x78 + i, fuLoad(m, FU_T_BAR_STOP + i));
  }
  fuStore(m, 0x18, 0x45); fuStore(m, 0x19, 0x50);        // `$9869`, `$5045`
  var whole = search >> 5;                               // `$9876`
  while (whole) {                                        // `$987B`
    for (i = 2; i >= 0; i--) { fuStore(m, fuWord(m, 0x18) + i, 0x00); }
    fuStore(m, 0x18, fuByte(fuLoad(m, 0x18) + 8));
    whole--;
  }
  fuBarPhase(m, (search >> 3) & 0x03);             // `$988E`
} // fuBarSetup

/**
 * `$98E5` — one phase of the bar into the three bytes the pointer is on.
 * @param {Object} m - The machine.
 * @param {number} phase - 0 to 3.
 */
function fuBarPhase(m, phase) {
  for (var i = 2; i >= 0; i--) {
    fuStore(m, fuWord(m, 0x18) + i, fuLoad(m, FU_T_PROGRESS + phase));
  }
} // fuBarPhase

/* ------------------------------------------------------------- the search */

/**
 * `$97F1` up to its first wait: find the furniture, open the window, put the
 * agent into the searching state and draw the bar.
 *
 * ★ `$9835 INC $3F` is how the agent starts searching — the state goes from
 * standing (`$0E`) to searching (`$0F`) by being **incremented**, which only
 * works because the loop let nothing else through (`$726B CPY #$0E`).
 *
 * @param {Object} m - The machine, `$10`/`$11` on the cell the hand is over.
 * @returns {Object|null} The search, or null when there is nothing there.
 */
function fuStart(m) {
  var x = fuUnderHand(m);
  if (x < 0) { return null; }                            // `$982F`
  fuOpen(m);                                             // `$9832`
  fuStore(m, FU_STATE, fuByte(fuLoad(m, FU_STATE) + 1)); // `$9835`
  plWritePointers(m);                                    // `$9837`
  fuStore(m, 0xE4, x);                                   // `$983F` STX $E4
  var out = {at: x, phase: 'window', unsupported: 0, found: 0,
             empty: 0, gaveUp: 0, died: 0, terminal: null};
  var search = fuLoad(m, FU_RECORDS + x + FU_SEARCH);
  // ★ `$9841 BNE` — **nulové prohledávání se nečeká**: skočí se rovnou na
  // výsledek, ve **stejném** průchodu, a okno s ukazatelem postupu se vůbec
  // nenakreslí. Je to nábytek, který dá, co má, hned
  if (search === 0) { fuDispatch(m, out); return out; }
  // ★ `$9846` — délka `$FF` není dlouhé prohledávání, je to
  // **bezpečnostní terminál** přes celou obrazovku (§29, `app/terminal.js`).
  // A `$9D09` se sem **nevrátí**: okno se nevrací a nábytek se nevyprazdňuje,
  // protože skončí i to, co prohledávání volalo.
  if (search === 0xFF) {
    out.phase = 'terminal';
    out.terminal = tmStart();
    return out;
  }
  fuBarSetup(m, search);                           // `$984D`
  return out;                                            // `$989C` si vezme snímek
} // fuStart

/**
 * One frame of a search — and **every** frame of it is one of these, because
 * the original waits for a frame in six different places inside `$97F1`.
 * The phases are those waits, in order:
 *
 * | fáze | co se v tom snímku udělá | kde to je |
 * |---|---|---|
 * | `window` | nakreslí se okno s ukazatelem postupu | `$989C` → `$9B96` |
 * | `bar` | ubere se z čítače a případně překreslí ukazatel | `$98A3` |
 * | `empty` | okno „nic" a jeho glyfy | `$99D6` |
 * | `wipe` | okno se vymaže, spočítá se nález a obrátí glyfy | `$990F` |
 * | `drawFound` | nakreslí se okno s nálezem | `$9B92` → `$9B96` |
 * | `terminal` | celoobrazovkový terminál, dokud z něj agent neodejde | `$9D09` |
 * | `hold` | čeká se, až se pustí páka | `$99B4` |
 * | `closing` | okno se vrátí a nábytek vyprázdní | `$9C1B` → `$9B28` |
 *
 * @param {Object} m - The machine.
 * @param {Object} search - What `fuStart` returned.
 * @param {number} joy - What `$DC00` would give.
 * @returns {{done: number, died: number, gaveUp: number}} What happened.
 */
function fuFrame(m, search, joy) {
  var i;
  switch (search.phase) {
  case 'terminal':                                       // `$9846` → `$9D09`
    var ran = terminal.frame(m, search.terminal, joy);
    search.found = ran.chose || search.found;
    return {done: ran.done, died: 0, gaveUp: 0};
  case 'controlRoom':                                    // `$98FD` → `$AA40`
    var inRoom = controlRoom.frame(m, search.control);
    if (search.control.gameOver === undefined) { search.control.gameOver = 0; }
    if (inRoom.speech !== undefined) { search.speech = inRoom.speech; }
    // ★ od `$AB23` běží obsluha `$838C`, která tiká **jen `$E0`** (§35)
    search.speaking = inRoom.speaking || 0;
    if (inRoom.gameOver) { search.gameOver = 1; }
    if (!inRoom.done) { return {done: 0, died: 0, gaveUp: 0}; }
    // ★ `$9904 JMP $98FA` — a odtud `$99D6`, tedy „nic tu není"
    search.phase = 'empty';
    return {done: 0, died: 0, gaveUp: 0};
  case 'codeRoom':                                       // `$9907` → `$A771`
    var inCode = codeRoom.frame(m, search.code, joy);
    if (!inCode.done) { return {done: 0, died: 0, gaveUp: 0}; }
    search.found = inCode.won ? 'codeRoom' : 'codeRoomGaveUp';
    // ★ **`JMP`, ne `JSR`**: `$A771` se vrací rovnou tomu, kdo volal `$97F1`,
    // takže se okno nezavírá ani nábytek nevyprazdňuje
    return {done: 1, died: 0, gaveUp: 0, noClose: 1};
  case 'window':                                         // `$9B96`
    fuDrawWindow(m, FU_T_WINDOW_SEARCHING);
    search.phase = 'bar';
    return {done: 0, died: 0, gaveUp: 0};
  case 'bar':
    return fuBarFrame(m, search, joy);
  case 'empty':                                          // `$99D6`
    fuDrawWindow(m, FU_T_WINDOW_EMPTY);
    for (i = 0x8F; i >= 0; i--) {                        // `$99DF`
      fuStore(m, FU_CHARSET + i, fuLoad(m, FU_T_EMPTY_WINDOW + i));
    }
    search.found = 'nothing';
    search.phase = 'hold';
    return {done: 0, died: 0, gaveUp: 0};
  case 'wipe':                                           // `$990F`
    fuWipe(m);
    search.found = fuFound(m, search);
    // ★ `$9B83` jsou **dva kusy a jen druhý si bere snímek**: glyfy se obrátí
    // hned tady (`$9B85`) a teprve kreslení okna (`$9B96`) čeká. Kdo to udělá
    // naráz, má okno o snímek pozadu a sadu ten snímek neobrácenou
    fuInvert(m);                                         // `$9B85`
    search.phase = 'drawFound';
    return {done: 0, died: 0, gaveUp: 0};
  case 'drawFound':                                      // `$9B96`
    fuDrawWindow(m, FU_T_WINDOW_FOUND);                  // `$9B92`
    search.phase = 'hold';
    return {done: 0, died: 0, gaveUp: 0};
  case 'closing':
    // ★ `$9C1B` **začíná čekáním na snímek** (`$9C1B JSR $7F6B`), takže se
    // okno vrací a nábytek vyprazdňuje až ten další — ve snímku, ve kterém
    // se páka pustila, se ještě nestane nic
    fuClose(m);
    if (search.empty) { fuEmpty(m); }                    // `$99D2`
    return {done: 1, died: search.died || 0, gaveUp: search.gaveUp || 0};
  default:
    return fuHoldFrame(m, search, joy);                  // `$99B4`
  }
} // fuFrame

/**
 * `$98A3` — one frame of the bar running down.
 *
 * ★ The bar is only redrawn **every eighth count** (`$98C2 AND #$07`), and
 * ★ the three-to-two step walks the pointer **back a glyph** when the one it
 * is on is already full (`$98D6`), which is what makes the bar eat its way
 * along instead of blinking in place.
 *
 * @param {Object} m - The machine.
 * @param {Object} search - What `fuStart` returned.
 * @param {number} joy - What `$DC00` would give.
 * @returns {{done: number, died: number, gaveUp: number}} What happened.
 */
function fuBarFrame(m, search, joy) {
  if (fuLoad(m, FU_DEATH)) {                             // `$98A6`
    search.phase = 'closing'; search.empty = 0;
    search.died = fuLoad(m, FU_DEATH);
    return {done: 0, died: 0, gaveUp: 0};
  }
  var at = FU_RECORDS + fuLoad(m, 0xE4) + FU_SEARCH;
  var left = fuByte(fuLoad(m, at) - 1);                  // `$98B3` DEC
  fuStore(m, at, left);
  if (left === 0) {                                      // `$98B6` → `$98F1`
    fuDispatch(m, search);
    return {done: 0, died: 0, gaveUp: 0};
  }
  if (joy & FU_JOY_UP) {                                 // `$98B8`, páka puštěná
    // ★ a **nábytek se nevyprázdní**: `$98BE` jde rovnou na `$9C1B` a `$9B28`
    // se vynechá, takže nedoprohledaný kus zůstane, jak byl
    search.phase = 'closing'; search.empty = 0; search.gaveUp = 1;
    return {done: 0, died: 0, gaveUp: 0};
  }
  if (left & 0x07) { return {done: 0, died: 0, gaveUp: 0}; }   // `$98C2`
  var phase = (left >> 3) & 0x03;                        // `$98C9`
  if (phase === 3 && fuLoad(m, fuWord(m, 0x18)) === 0xFF) {    // `$98D6`
    fuStore(m, 0x18, fuByte(fuLoad(m, 0x18) - 8));
  }
  fuBarPhase(m, phase);
  return {done: 0, died: 0, gaveUp: 0};
} // fuBarFrame

/**
 * `$98F1` — what was in it. ★ The byte at `$4F5A,X` is five things at once:
 * `$FF` nothing, `$FE` a lift reset, `$FB` the control room, `$FC`/`$FD` a
 * terminal, and **anything under `$FC` is the number of a puzzle piece**.
 *
 * @param {Object} m - The machine.
 * @param {Object} search - The search.
 * @returns {string} What it turned into: `'nothing'`, `'terminal'`,
 *   `'piece'`, or the name of a branch this does not do yet.
 */
function fuDispatch(m, search) {
  var x = fuLoad(m, 0xE4);
  fuStore(m, 0xEA, x);                                   // `$98F1`
  var holds = fuLoad(m, FU_RECORDS + x + FU_HOLDS);
  if (holds === FU_NOTHING) { search.phase = 'empty'; return; }      // `$98F6`
  // ★ **`JSR`, takže se vrátí** (`$9901`) — a `$9904 JMP $98FA` pak jde na
  // `$99D6`, tedy na „nic tu není". Řídicí místnost, která odmítne (heslo
  // není celé, §35), se od prázdného nábytku k nerozeznání neliší.
  if (holds === FU_CONTROL_ROOM) {                         // `$98FD` → `$AA40`
    search.control = controlRoom.start(m, function () { return m.entropy(); });
    // ★ **Odmítnutí je v témže průchodu**: `$AA42` se podívá na devět
    // písmen hesla a `RTS` přijde dřív, než se na cokoli čeká
    search.phase = search.control.done ? 'empty' : 'controlRoom';
    return;
  }
  // ★ **`JMP`, takže se nevrátí** (`$990B`): kódová místnost si vezme celý
  // průchod a prohledávání už nikdy nedokončí — okno se nevrací a nábytek
  // se nevyprazdňuje
  if (holds === FU_CODE_ROOM) {                            // `$9907` → `$A771`
    search.phase = 'codeRoom';
    search.code = codeRoom.start(m, function () { return m.entropy(); });
    return;
  }
  search.phase = 'wipe';
} // fuDispatch

/** `$9912` — the window wiped to `$52` before the answer is drawn into it */
function fuWipe(m) {
  for (var row = 0; row < FU_TALL; row++) {
    for (var y = FU_WIDE - 1; y >= 0; y--) {
      fuStore(m, (fuWord(m, FU_PTR) + y) & 0xFFFF, FU_WIPE);
    }
    fuMovePtr(m, 40);
  }
  fuMovePtr(m, -160);                                    // `$9923 JSR $AF0F`
} // fuWipe

/** `$9926` — a terminal or a piece, whichever the byte says */
function fuFound(m, search) {
  var holds = fuLoad(m, FU_RECORDS + fuLoad(m, 0xEA) + FU_HOLDS);
  return holds >= FU_PASSWORD ? fuPassword(m, holds)
                              : fuPiece(m, holds);
} // fuFound

/**
 * `$992C` — a **password**: `$FD` is SNOOZE, `$FC` is LIFT INIT. Its picture
 * comes out of one of the two blocks the pointers `$9B24`/`$9B26` name, and
 * ★ the count of it goes up in the **shaft's bottom panel** (`$3439`, which
 * `data/shaft.json` carries), never past `$88` — the panel holds a
 * screen-code digit, not a number.
 *
 * ★ It is **found** here and **spent** in the security terminal (§29); the
 * two are different things and the manual names them apart.
 *
 * @param {Object} m - The machine.
 * @param {number} holds - `$FC` or `$FD`.
 * @returns {string} `'password'`.
 */
function fuPassword(m, holds) {
  var which = holds - FU_PASSWORD;                       // `$992D SBC #$FC`
  // ★ Ukazatel jde **přes nultou stránku** (`$9932 STA $18`, `$9938 STA $19`)
  // a zůstane tam — je to vidět v každém výpisu po nálezu a měří se to.
  fuStore(m, 0x18, fuLoad(m, FU_T_TERM_LO + which));
  fuStore(m, 0x19, fuLoad(m, FU_T_TERM_HI + which));
  for (var i = 0x8F; i >= 0; i--) {                      // `$993C`
    fuStore(m, FU_CHARSET + i, fuLoad(m, fuWord(m, 0x18) + i));
  }
  fuStore(m, FU_PASSWORDS, fuByte(fuLoad(m, FU_PASSWORDS) + 1));   // `$9946`
  var spot = fuLoad(m, FU_COUNTER_SPOTS + which);        // `$9948`
  if (fuLoad(m, FU_COUNTERS + spot) < FU_COUNTER_MAX) {
    fuStore(m, FU_COUNTERS + spot, fuByte(fuLoad(m, FU_COUNTERS + spot) + 1));
  }
  return 'password';                                     // `$9956` je fáze `invert`
} // fuPassword

/**
 * `$995C` — a piece of the puzzle: counted, drawn and **written down**.
 *
 * ★ The list at `$4EF5` is kept ended by `$FF`: the code walks to the end,
 * moves the `$FF` one further and writes the number into the place it left
 * (`$9964`-`$99AB`), and the background colour of the room it was found in
 * goes into `$4F25`. That colour is what the pocket computer draws it on.
 *
 * ★ What is **not** here is `$9C3A`, which composes the piece's picture into
 * the character set out of the two shapes and the card (§15). That is the
 * pocket computer's own drawing and it belongs to M5; until it is written
 * the window shows the wipe. Everything the *game* needs of a find — that it
 * happened, which piece, on what, and that the furniture is now empty — is
 * here and is measured.
 *
 * @param {Object} m - The machine.
 * @param {number} holds - The piece, 0 to 35.
 * @returns {string} `'piece'`.
 */
function fuPiece(m, holds) {
  m.fuPartial = 'pieceShape';
  fuStore(m, FU_PIECES, fuByte(fuLoad(m, FU_PIECES) + 1));    // `$995C`
  // ★ `$995E JSR $9C3A` — obrázek dílku ze dvou tvarů a karty (§15). Do M5
  // tady chyběl a bylo to přiznané; od M5 ho skládá `app/pocketComputer.js`.
  // ★ A je to práce, která se originálu **do snímku nevejde** — otáčení
  // 144 bajtů až třicetkrát — takže výpis stavu padne doprostřed ní (§19).
  // Měřidlo se na tom snímku proto zastaví a řekne proč.
  if (typeof pocketComputer !== 'undefined') { pocketComputer.compose(m, holds); }
  var x = 0;                                             // `$9964`
  while (fuLoad(m, FU_FOUND + x) !== 0xFF) { x++; }
  fuStore(m, FU_FOUND + x + 1, 0xFF);                    // `$996E`
  // ★ **První dva nálezy si rovnou lehnou do okna počítače** (`$9976`):
  // `$C690` je odložená kopie přihrádky 0 a `$C840` přihrádky 3 (§34), a
  // jde tam **obrácený** obrázek (`EOR #$FF`). K tomu barva pozadí
  // místnosti do `$98`/`$9B` a příznak „obsazeno" do `$92`/`$95`. Třetí
  // a další nález jde jen do seznamu — do okna ho dostane až listování.
  if (x < 2 && typeof pocketComputer !== 'undefined') {
    var parked = x === 0 ? 0xC690 : 0xC840;              // `$9980` / `$9999`
    for (var y = 0x8F; y >= 0; y--) {
      fuStore(m, parked + y, fuLoad(m, 0x5000 + y) ^ 0xFF);
    }
    fuStore(m, x === 0 ? 0x98 : 0x9B, fuLoad(m, 0xD021)); // `$9988`
    fuStore(m, x === 0 ? 0x92 : 0x95, 0x01);              // `$998D`
  }
  fuStore(m, FU_FOUND + x, holds);                       // `$99AB`
  fuStore(m, FU_FOUND_COLORS + x, fuLoad(m, 0xD021));    // `$99AE`
  return 'piece';
} // fuPiece

/** `$9B85` — the glyphs of the window inverted, all 144 of them */
function fuInvert(m) {
  for (var i = 0x8F; i >= 0; i--) {
    fuStore(m, FU_CHARSET + i, fuLoad(m, FU_CHARSET + i) ^ 0xFF);
  }
} // fuInvert

/**
 * `$9B28` — the furniture is empty now, and the screen forgets it.
 *
 * ★ Two writes, not one: `$4F5A,X` is the copy the search reads and
 * `($87),Y` is the room's **own record**, so the emptiness survives leaving
 * the room. ★ And the lift reset (`$FE`) is **not** used up — it is the one
 * thing a room gives more than once.
 *
 * The erasing goes **upwards** from the record's corner, four rows of the
 * piece's width, and then one row more — but only where the character is not
 * a floor (`$45`-`$4B`), because furniture stands on floors.
 *
 * @param {Object} m - The machine.
 */
function fuEmpty(m) {
  var x = fuLoad(m, 0xEA), at = FU_RECORDS + x;
  if (fuLoad(m, at + FU_HOLDS) === FU_CONTROL_ROOM) { return; }   // `$9B2B`
  fuStore(m, at + FU_HOLDS, FU_EMPTIED);                 // `$9B2F`
  fuStore(m, (fuWord(m, FU_RECORD_PTR) + fuLoad(m, FU_RECORD_AT)) & 0xFFFF,
          FU_EMPTIED);                                   // `$9B34`
  fuStore(m, 0x18, fuLoad(m, at + FU_START_LO));         // `$9B3A`
  fuStore(m, 0x19, fuLoad(m, at + FU_START_HI));
  var width = fuByte(fuLoad(m, at + FU_END_LO) - fuLoad(m, at + FU_START_LO));
  var row, y;
  for (row = 3; row >= 0; row--) {                       // `$9B4D`
    for (y = width; y >= 0; y--) {
      fuStore(m, (fuWord(m, 0x18) + y) & 0xFFFF, FU_BLANK);
    }
    var lo = fuLoad(m, 0x18) - 0x28;                     // `$9B59`
    fuStore(m, 0x18, fuByte(lo));
    if (lo < 0) { fuStore(m, 0x19, fuByte(fuLoad(m, 0x19) - 1)); }
  }
  if (fuLoad(m, 0x19) < 0x40) { return; }                // `$9B67`
  for (y = width; y >= 0; y--) {                         // `$9B6F`
    var ch = fuLoad(m, (fuWord(m, 0x18) + y) & 0xFFFF);
    if (ch >= FU_FLOOR_FROM && ch < FU_FLOOR_TO) { return; }
    fuStore(m, (fuWord(m, 0x18) + y) & 0xFFFF, FU_BLANK);
  }
} // fuEmpty

/**
 * `$99B4` — the window stays until the stick lets go, and then everything
 * goes back: the picture under it, and the furniture emptied.
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give.
 * @returns {{done: number, died: number}} Whether the search is over.
 */
function fuHoldFrame(m, search, joy) {
  if (fuLoad(m, FU_DEATH)) {                             // `$99B7`
    search.phase = 'closing'; search.empty = 1;
    search.died = fuLoad(m, FU_DEATH);
    return {done: 0, died: 0, gaveUp: 0};
  }
  if (!(joy & FU_JOY_UP)) { return {done: 0, died: 0, gaveUp: 0}; }  // `$99C7`
  search.phase = 'closing'; search.empty = 1;            // `$99CD`
  return {done: 0, died: 0, gaveUp: 0};
} // fuHoldFrame

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var furniture = {
  start: fuStart, frame: fuFrame, barFrame: fuBarFrame, dispatch: fuDispatch,
  holdFrame: fuHoldFrame, empty: fuEmpty, underHand: fuUnderHand,
  open: fuOpen, close: fuClose, drawWindow: fuDrawWindow, foundPiece: fuPiece,
  seedMemory: fuSeedMemory,
  RECORDS: FU_RECORDS, CHARSET: FU_CHARSET, FOUND: FU_FOUND
};
if (typeof self !== 'undefined') {
  self.furniture = furniture;
  self.fuStart = fuStart;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = furniture; }
