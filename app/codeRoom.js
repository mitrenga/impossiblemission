// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The code room — `$A771`, and there are **two of them** in every fortress
 * (`sources/docs/disasm_notes.md` §35).
 *
 * A piece of furniture whose content is `$FB` is not furniture: `$9907`
 * jumps — **jumps, does not call** — to `$A771`, so the search never comes
 * back and the room takes over. Five things about it are worth knowing.
 *
 * 1. ★ **It is a board of thirty-two cells, not a picture.** `$A8BE` is the
 *    board, four rows of eight, and `$A8DE` paints a cell by writing four
 *    characters by three rows of colour RAM from `$D8A4`. Nothing is drawn
 *    anywhere else.
 * 2. ★ **The tones are shuffled, the board is not.** `$A780` lays out
 *    sixteen values — `0`-`7` and `9`-`16` — shuffles them by thirty-two
 *    swaps against slot 0 and then throws `$74`+1 of them into **random
 *    free cells**. The order they were thrown in is the order they sound.
 * 3. ★ **The puzzle is to click them in rising order.** `$A85E` compares
 *    the tone just clicked with `$78`, the last one, and anything that is
 *    not **greater** resets the run to one (`$A8B5`). Get `$74`+1 of them
 *    in a row and the room is won.
 * 4. ★ **Winning raises one of the two counters in the shaft's panel** —
 *    the very ones the security terminal spends (§29): `$A86C` picks the
 *    one by the **bottom bit of the level** and `$3439,Y` goes up by one,
 *    capped at `$89`. And the level itself goes up, capped at thirteen,
 *    so the room gets harder each time.
 * 5. ★ **Each of the two rooms keeps its own level**: `$75` for room `$11`
 *    and `$76` for room `$1B` (`$A774` and `$A8A7`).
 *
 * ★ And playing one tone is **thirty-three frames** (`$A950`), in which the
 * hand still moves — `$A9DA JSR $3E08` is inside the tone's own loop.
 */

/** the board: thirty-two cells, four rows of eight (`$A8BE`) */
var CR_BOARD = 0xA8BE, CR_CELLS = 0x20, CR_COLUMNS = 8;

/** the sixteen shuffled tones `$A771` builds itself (`$B21F`) */
var CR_TONES = 0xB21F, CR_TONE_COUNT = 16;

/** the three tables one tone is played out of (`$A97C`) */
var CR_FREQ_LO = 0xA9F8, CR_FREQ_HI = 0xAA00, CR_COLORS = 0xAA08;

/** where the board's colour RAM starts, and what a lit cell is */
var CR_PAINT = 0xD8A4, CR_LIT = 0x0D;

/** the two counters in the shaft's panel, and the digit that may not be passed */
var CR_COUNTERS = 0x3439, CR_COUNTER_SPOTS = 0xA21A, CR_COUNTER_TOP = 0x89;

/** zero page */
var CR_LEVEL = 0x74,        // how many tones this room asks for, less one
    CR_LEVEL_A = 0x75,      // …kept per room: `$11` here
    CR_LEVEL_B = 0x76,      // …and `$1B` here
    CR_RUN = 0x77,          // how many right in a row, less one (`$FF` none)
    CR_LAST = 0x78,         // the tone the run stands on
    CR_ROOM = 0x7E,         // which room the agent is in
    CR_FRAME = 0xE0,        // the interrupt's counter
    CR_FIRE_EDGE = 0xDE;    // one push is one click

/** the two rooms that are code rooms, and the first of them */
var CR_ROOM_A = 0x11, CR_ROOM_B = 0x1B;

/** the joystick, port 2, active low (§7) */
var CR_JOY_FIRE = 0x10;

function crByte(v) { return v & 0xFF; }
function crLoad(m, a) { return rbLoad(m, a); }
function crStore(m, a, v) { rbStore(m, a, v); }
function crWord(m, a) { return crLoad(m, a) | (crLoad(m, a + 1) << 8); }
function crJoy(m) { return m.cr ? m.cr.joy : 0x7F; }

/**
 * What the code room needs to find in memory: the three tables one tone is
 * played out of. ★ Data of the program again (§24, §27, §34).
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} data - The parsed `data/special.json`.
 */
function crSeedMemory(mem, data) {
  var i, key;
  if (!data || !data.tables) { return; }
  for (key in data.tables) {
    if (!Object.prototype.hasOwnProperty.call(data.tables, key)) { continue; }
    var at = parseInt(data.tables[key].addr.replace('$', ''), 16);
    for (i = 0; i < data.tables[key].values.length; i++) {
      mem[(at + i) & 0xFFFF] = data.tables[key].values[i] & 0xFF;
    }
  }
} // crSeedMemory

/** `$AF2F` — the drawing position by so many characters (as everywhere) */
function crAdvance(m, delta) {
  var lo = crLoad(m, 0x10) + delta;
  crStore(m, 0x10, lo & 0xFF);
  crStore(m, 0x14, lo & 0xFF);
  var carry = lo > 0xFF ? 1 : (lo < 0 ? -1 : 0);
  if (carry) {
    crStore(m, 0x11, crByte(crLoad(m, 0x11) + carry));
    crStore(m, 0x15, crByte(crLoad(m, 0x15) + carry));
  }
} // crAdvance

/** `$A929` — the envelopes the three voices speak the tones with */
function crVoices(m) {
  crStore(m, 0xD405, 0x5A); crStore(m, 0xD40C, 0x5A); crStore(m, 0xD413, 0x58);
  crStore(m, 0xD406, 0x00); crStore(m, 0xD40D, 0x00); crStore(m, 0xD414, 0x00);
  crStore(m, 0xD402, 0x00); crStore(m, 0xD409, 0x00); crStore(m, 0xD410, 0x00);
  crStore(m, 0xD418, 0x05);
} // crVoices

/** `$A921` — a bright colour out of the mixer */
function crBright(m, entropy) {
  return (fgRandom(m.mem, entropy()) & 0x07) | 0x08;
} // crBright

/**
 * `$A73D` — what a code room does on **every pass of the main loop**: once
 * every sixteen frames the two shared sprite colours and two cells of the
 * console are re-shuffled, and eight frames later two more. ★ It is the one
 * thing about these rooms that runs while the agent is still walking.
 */
function crFlicker(m, entropy) {
  var phase = crLoad(m, CR_FRAME) & 0x0F;
  if (phase === 0) {
    crStore(m, 0xD025, fgRandom(m.mem, entropy()) & 0x0F);
    crStore(m, 0xD026, fgRandom(m.mem, entropy()) & 0x0F);
    crStore(m, 0xDB81, crBright(m, entropy));
    crStore(m, 0xDB85, crBright(m, entropy));
    return;
  }
  if (phase === 0x08) {
    crStore(m, 0xDB82, crBright(m, entropy));
    crStore(m, 0xDB86, crBright(m, entropy));
  }
} // crFlicker

/** `$A8DE` — one cell of the board lit: four characters by three rows */
function crPaintCell(m, cell) {
  crStore(m, 0x10, CR_PAINT & 0xFF); crStore(m, 0x11, CR_PAINT >> 8);
  var rows = cell >> 3;                                  // `$A8E8`
  for (; rows > 0; rows--) {
    crAdvance(m, 0x28); crAdvance(m, 0x28); crAdvance(m, 0x28);
  }
  var lo = crLoad(m, 0x10) + ((cell & 0x07) << 2);       // `$A8FC`
  crStore(m, 0x10, lo & 0xFF);
  if (lo > 0xFF) { crStore(m, 0x11, crByte(crLoad(m, 0x11) + 1)); }
  for (var row = 2; row >= 0; row--) {                   // `$A90A`
    for (var y = 3; y >= 0; y--) {
      crStore(m, (crWord(m, 0x10) + y) & 0xFFFF, CR_LIT);
    }
    crAdvance(m, 0x28);
  }
} // crPaintCell

/**
 * `$AA10` — the whole board in two colours, a checkerboard four cells wide.
 * It is what the win flashes with, and what a click outside the board
 * leaves behind.
 */
function crPaintBoard(m, a) {
  crStore(m, 0x10, CR_PAINT & 0xFF); crStore(m, 0x11, CR_PAINT >> 8);
  crStore(m, 0xE5, 0x03);
  for (var block = 3; block >= 0; block--) {             // `$AA1C`, `$E5`
    crStore(m, 0xE4, 0x02);
    for (var row = 2; row >= 0; row--) {                 // `$AA20`, `$E4`
      var y = 0x1F;
      while (y >= 0) {
        for (var x = 3; x >= 0 && y >= 0; x--, y--) {
          crStore(m, (crWord(m, 0x10) + y) & 0xFFFF, a);
        }
        a ^= 0x01;
      }
      crAdvance(m, 0x28);
      crStore(m, 0xE4, crByte(row - 1));
    }
    a ^= 0x01;
    crStore(m, 0xE5, crByte(block - 1));
  }
} // crPaintBoard

/**
 * `$A950` — one tone: the cell's sprite lights up, three voices sound an
 * octave apart and it lasts **thirty-three frames**.
 *
 * ★ The three voices are not three notes: `$A997` writes the same frequency
 * into voice 3, then halves it for voice 2 and again for voice 1, so one
 * tone is the same note in three octaves. ★ And whether the top octave is
 * halved once more is **bit 3 of the tone** (`$A98D`), which is why the
 * sixteen values are `0`-`7` and `9`-`16`.
 */
function* crPlay(m, tone, cell) {
  var x = (cell & 0x07) << 5;                            // `$A952`
  crStore(m, 0xD000, crByte(x + 0x3C));
  var msb = crLoad(m, 0xD010) & 0xFE;
  if (x + 0x3C > 0xFF) { msb |= 0x01; }
  crStore(m, 0xD010, msb);
  var high = cell & 0x18;                                // `$A96A`
  crStore(m, 0xD001, crByte(high*3 + 0x53));
  var index = tone & 0x07;                               // `$A979`
  // ★ Frekvence jde přes `$E4`/`$E5` a **zůstane tam**, půlená třikrát —
  // originál si pracovní dvojici po sobě neuklízí a měřidlo ji vidí
  crStore(m, 0xE4, crLoad(m, CR_FREQ_LO + index));       // `$A97F`
  crStore(m, 0xE5, crLoad(m, CR_FREQ_HI + index));       // `$A985`
  crStore(m, 0xD027, crLoad(m, CR_COLORS + index));
  var halve = function () {
    var lo = crLoad(m, 0xE4), hi = crLoad(m, 0xE5);
    crStore(m, 0xE5, hi >> 1);
    crStore(m, 0xE4, ((hi & 1) << 7) | (lo >> 1));
  };
  if (!(tone & 0x08)) { halve(); }                       // `$A98D` — o oktávu níž
  for (var voice = 0x0E; voice >= 0; voice -= 7) {       // `$A995`
    crStore(m, 0xD400 + voice, crLoad(m, 0xE4));
    crStore(m, 0xD401 + voice, crLoad(m, 0xE5));
    halve();
  }
  yield;                                                 // `$A9AC`
  crStore(m, 0xD015, crLoad(m, 0xD015) | 0x01);
  crStore(m, 0xD404, 0x43); crStore(m, 0xD40B, 0x43); crStore(m, 0xD412, 0x43);
  for (var n = 0x1F; n >= 0; n--) {                      // `$A9C6`
    yield;
    var pw = (crLoad(m, CR_FRAME) & 0x0F) | 0x08;
    crStore(m, 0xD403, pw); crStore(m, 0xD40A, pw); crStore(m, 0xD411, pw);
    crCursor(m);                                         // `$A9DA` — ruka jde dál
  }
  crStore(m, 0xD015, crLoad(m, 0xD015) & 0xFE);
  crStore(m, 0xD404, 0x00); crStore(m, 0xD40B, 0x00); crStore(m, 0xD412, 0x00);
} // crPlay

/** `$3E08` — the same hand the pocket computer has (§34) */
function crCursor(m) {
  m.pc = m.pc || {joy: 0x7F};
  m.pc.joy = crJoy(m);
  return pocketComputer.cursor(m);
} // crCursor

/**
 * `$A771` — the whole visit to a code room, from the search that opened it
 * to the level it leaves behind.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - The replaceable source (§8).
 */
function* crRun(m, entropy) {
  var i, x, y;
  crVoices(m);                                           // `$A929`
  var roomA = crLoad(m, CR_ROOM) === CR_ROOM_A;          // `$A776`
  crStore(m, CR_LEVEL, crLoad(m, roomA ? CR_LEVEL_A : CR_LEVEL_B));
  for (x = 7; x >= 0; x--) {                             // `$A782`
    crStore(m, CR_TONES + x, x);
    crStore(m, CR_TONES + 8 + x, crByte(x + 9));
  }
  for (y = 0x1F; y >= 0; y--) {                          // `$A791` — třicet dva výměn
    do { x = fgRandom(m.mem, entropy()) & 0x0F; } while (x === 0x0F);
    var keep = crLoad(m, CR_TONES + x);
    crStore(m, CR_TONES + x, crLoad(m, CR_TONES));
    crStore(m, CR_TONES, keep);
  }
  for (x = CR_CELLS - 1; x >= 0; x--) { crStore(m, CR_BOARD + x, 0xFF); }
  for (y = crLoad(m, CR_LEVEL); y >= 0; y--) {           // `$A7B6`
    do { x = fgRandom(m.mem, entropy()) & 0x1F; }
    while (!(crLoad(m, CR_BOARD + x) & 0x80));
    crPaintCell(m, x);                                   // `$A7C3`
    crStore(m, CR_BOARD + x, crLoad(m, CR_TONES + y));
    yield* crPlay(m, crLoad(m, CR_BOARD + x), x);        // `$A7CC`
  }
  crStore(m, 0xA0, 0x53); crStore(m, 0xA1, 0xB6);        // `$A7D2`
  crStore(m, 0xA2, 0x1D); crStore(m, 0xA3, 0x9A);
  crStore(m, 0xD009, 0x6D); crStore(m, 0xD008, 0x9E);
  crStore(m, 0xD010, crLoad(m, 0xD010) & 0xEF);
  crStore(m, 0xD015, (crLoad(m, 0xD015) & 0xFE) | 0x10);
  crStore(m, CR_RUN, 0xFF);                              // `$A7FE`
  var gaveUp = false, won = false;
  for (;;) {
    yield;                                               // `$A802`
    var hand = crCursor(m);
    if (crJoy(m) & CR_JOY_FIRE) { crStore(m, CR_FIRE_EDGE, 0x00); continue; }
    if (crLoad(m, CR_FIRE_EDGE) !== 0) { continue; }
    crStore(m, CR_FIRE_EDGE, crByte(crLoad(m, CR_FIRE_EDGE) + 1));
    // ★ `$A81B INX` a `$A826 INY` — **obojí o jedna nahoru** dřív, než se
    // z polohy ruky spočítá políčko; bez toho je celá mřížka o pixel vedle
    var col = crByte(crByte(hand.x + 1) - crLoad(m, 0xA2)) >> 4;
    crStore(m, 0xE4, col);                               // `$A824 STA $E4`
    var row = crByte(crByte(hand.y + 1) - crLoad(m, 0xA0));
    var base = -1;
    if (row < 0x16) { base = 0x00; }
    else if (row < 0x2E) { base = 0x08; }
    else if (row < 0x46) { base = 0x10; }
    else if (row < 0x5E) { base = 0x18; }
    if (base < 0) {                                      // `$A843` — mimo mřížku
      crPaintBoard(m, 0x01);
      gaveUp = true;
      break;
    }
    var cell = crByte(base + col);                       // `$A84B`
    var tone = crLoad(m, CR_BOARD + cell);
    if (tone & 0x80) { continue; }                       // prázdné políčko
    yield* crPlay(m, tone, cell);                        // `$A856`
    var run = crByte(crLoad(m, CR_RUN) + 1);
    crStore(m, CR_RUN, run);
    // ★ `$A85C BEQ` — **první klepnutí se bere vždycky**; potom musí být tón
    // **větší** než ten poslední, jinak se běh vrátí na jedna (`$A8B5`)
    if (run !== 0 && tone <= crLoad(m, CR_LAST)) {
      crStore(m, CR_LAST, tone);
      crStore(m, CR_RUN, 0x00);
      continue;
    }
    crStore(m, CR_LAST, tone);                           // `$A864`
    if (run !== crLoad(m, CR_LEVEL)) { continue; }
    won = true;
    break;
  }
  if (won) {
    // ★ `$A86C` — **počitadlo v panelu šachty**, to samé, které utrácí
    // bezpečnostní terminál (§29); které z těch dvou, říká spodní bit úrovně
    var spot = crLoad(m, CR_COUNTER_SPOTS + (crLoad(m, CR_LEVEL) & 0x01));
    var digit = crLoad(m, CR_COUNTERS + spot);
    if (digit < CR_COUNTER_TOP) {
      crStore(m, CR_COUNTERS + spot, crByte(digit + 1));
    }
    var a = 0x00;                                        // `$A880`
    crStore(m, 0xE6, 0x17);
    for (var flash = 0x17; flash >= 0; flash--) {
      crPaintBoard(m, a);
      yield* pocketComputer.wait(3);
      a ^= 0x01;
      crStore(m, 0xE6, crByte(flash - 1));
    }
    var level = crLoad(m, CR_LEVEL);                     // `$A896`
    if (level < 0x0D) { crStore(m, CR_LEVEL, crByte(level + 1)); }
  }
  crStore(m, 0xD015, crLoad(m, 0xD015) & 0xEF);          // `$A89F`
  crStore(m, roomA ? CR_LEVEL_A : CR_LEVEL_B, crLoad(m, CR_LEVEL));
  m.cr.won = won ? 1 : 0;
  m.cr.gaveUp = gaveUp ? 1 : 0;
} // crRun

/**
 * The room opens. ★ Like the pocket computer, the generator is advanced
 * once at once: `$A771` has no `$7F6B` of its own before the first tone, so
 * everything up to the first wait belongs to the frame the search ended in.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - The replaceable source.
 * @returns {Object} The session, for `crFrame`.
 */
function crStart(m, entropy) {
  m.cr = {joy: 0x7F, won: 0, gaveUp: 0};
  var st = {gen: crRun(m, entropy), done: false};
  return st;
} // crStart

/**
 * One frame of the code room.
 * @param {Object} m - The machine.
 * @param {Object} st - What `crStart` gave.
 * @param {number} joy - What `$DC00` would give; port 2, active low.
 * @returns {Object} `done`, and `won`/`gaveUp` once it is over.
 */
function crFrame(m, st, joy) {
  m.cr.joy = joy & 0xFF;
  var step = st.gen.next();
  if (step.done) { st.done = true; }
  return {done: st.done ? 1 : 0, won: m.cr.won, gaveUp: m.cr.gaveUp};
} // crFrame

// published the way every classic worker script is
var codeRoom = {
  seedMemory: crSeedMemory, start: crStart, frame: crFrame,
  flicker: crFlicker, paintBoard: crPaintBoard, paintCell: crPaintCell,
  BOARD: CR_BOARD, TONES: CR_TONES, ROOM_A: CR_ROOM_A, ROOM_B: CR_ROOM_B
};
if (typeof self !== 'undefined') { self.codeRoom = codeRoom; }
if (typeof module !== 'undefined' && module.exports) { module.exports = codeRoom; }
