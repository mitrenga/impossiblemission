// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * Before the fortress itself is drawn, the original lays out its **map**:
 * which room sits in which of the nine by six squares, and which of them are
 * joined by a lift shaft. That is `$B2B3`, called from `$398F` — one
 * subroutine, before `$7236` (`sources/docs/disasm_notes.md` §11), and it
 * draws the little picture the pocket computer shows while it does it.
 *
 * It is transcribed the same way as `fortressGen.js` and for the same
 * reason: it is the second half of what a game of Impossible Mission draws
 * at random, so without it a run cannot be repeated. The transcription works
 * on the machine's memory and the entropy is the one replaceable thing
 * (`ZADANI.md` §10.4).
 *
 * ★ Measured, entropy `$42`: the generator writes **`$FC01`-`$FFEB`**, and
 * that range is three things at once — the map's bitmap from `$FC00`, the
 * **nine by six grid of rooms** at `$FF96`-`$FFCB` (54 squares), and the four
 * shuffled tables of eight at `$FFCC`, `$FFD4`, `$FFDC`, `$FFE4`.
 */

var FM_TABLES = 0xFFCC;        // four tables of eight, shuffled first
var FM_GRID = 0xFF96;          // 9 x 6 squares, $FF while free
var FM_BITMAP = 0xFB78;        // the picture, $88 bytes to a row of squares
var FM_SHAPES = 0xB593;        // masks a room is punched out of the map with
var FM_SHAFT_A = 0xB633;       // masks for the two kinds of lift shaft
var FM_SHAFT_B = 0xB623;
var FM_COLUMNS = 9;
var FM_ROWS = 6;

/**
 * The pointer the original carries in `$18`/`$19`, and `$BF30` which adds to
 * it. It has to live in memory, because the drawing routines hand it around.
 * @param {Uint8Array} mem - The machine's memory.
 * @returns {{get: function(): number, set: function(number), add: function(number)}}
 */
function fmPointer(mem) {
  return {
    get: function () { return mem[0x18] | (mem[0x19] << 8); },
    set: function (v) { mem[0x18] = v & 255; mem[0x19] = (v >> 8) & 255; },
    add: function (d) { this.set((this.get() + d) & 0xFFFF); }
  };
} // fmPointer

/**
 * `$B3E8` — a row of the map, 0-5, drawn until it is one.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 * @returns {number} A row.
 */
function fmRow(mem, entropy) {
  var a;
  do { a = fgRandom(mem, entropy()) & 7; } while (a >= 6);
  return a;
} // fmRow

/**
 * `$B50C` — where in the bitmap a square lives: `$FB78`, plus `$88` for every
 * row up to and including this one, plus sixteen for every column but the
 * first (which is eight short).
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} x - Column, 0-8.
 * @param {number} y - Row, 0-5.
 */
function fmSeek(mem, x, y) {
  var ptr = fmPointer(mem);
  ptr.set(FM_BITMAP);
  for (var i = y; i >= 0; i--) { ptr.add(0x88); }
  if (x !== 0) { ptr.add(((x << 4) - 8) & 255); }
} // fmSeek

/**
 * `$B446` — put a room into the grid.
 *
 * It starts where it is told and walks: six rows down (wrapping), then the
 * next column (wrapping back to column one, never to zero), until a square is
 * free. Which is why the map always fills up and never runs out.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} value - The room to place.
 * @param {number} x - Where to start looking, column.
 * @param {number} y - Where to start looking, row.
 * @returns {{x: number, y: number}} Column asked for, row it ended up in.
 */
function fmPlaceRoom(mem, value, x, y) {
  for (;;) {
    mem[0xE5] = 5;
    for (;;) {
      mem[0xE4] = (y*9) & 255;                    // the multiply lands here first
      var cell = (y*9 + x) & 255;
      mem[0xE4] = x;
      if (mem[FM_GRID + cell] >= 0x80) {          // $FF: free
        mem[FM_GRID + cell] = value;
        return {x: x, y: y};
      }
      y = y + 1 >= FM_ROWS ? 0 : y + 1;
      mem[0xE5] = (mem[0xE5] - 1) & 255;
      if (mem[0xE5] === 0xFF) { break; }
    }
    x = x + 1 < 8 ? x + 1 : 1;                    // column 0 is only ever the start
  }
} // fmPlaceRoom

/**
 * `$B3F2` — place a room and punch its shape out of the map picture.
 *
 * Which shape depends on the room's own number: below `$10` it is one of four
 * small ones, `$10`-`$17` and `$18` upwards are the two tall ones (and the
 * tall one in a column other than the first is drawn eight bytes along).
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} value - The room.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {{x: number, y: number}} Column, and the row the room landed in.
 */
function fmDrawRoom(mem, value, x, y) {
  var at = fmPlaceRoom(mem, value, x, y);
  // ★ past: `$B446` vrací sloupec, na kterém **skutečně** místnost přistála,
  // ne ten, o který se žádalo — a od něj se odvíjí i kresba a šachta
  fmSeek(mem, at.x, at.y);
  mem[0xE7] = at.y;
  mem[0xE4] = at.x;
  var ptr = fmPointer(mem), sx, sy, a = value;
  if (a >= 0x10) {
    sx = 0x60;
    if (a >= 0x18) {
      if (at.x !== 0) { ptr.add(8); }
      sx = 0x80;
    }
    var odd = a & 1; a >>= 1;                     // LSR A
    if (odd) { sx = (sx + 0x10) & 255; }
    sx = (sx + 0x0F) & 255;
    sy = 0x0F;
  } else {
    var low = a & 1; a >>= 1;                     // LSR A
    sx = (a & 4) ? 0x47 : 0x17;
    if (low) { sx = (sx + 0x18) & 255; }
    sy = 0x17;
  }
  var base = ptr.get();
  for (; sy >= 0; sy--, sx--) {
    mem[(base + sy) & 0xFFFF] &= mem[FM_SHAPES + sx];
  }
  return {x: at.x, y: at.y};
} // fmDrawRoom

/**
 * `$B4F6` — may a lift shaft stop at this room?
 *
 * `$E8` says which kind of shaft is being drawn: `$C0` stops anywhere, `$40`
 * refuses the rooms `$10`-`$17`, `$80` refuses everything from `$18` up.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} room - What is in the square.
 * @returns {boolean} True when the shaft must keep going (the original's carry).
 */
function fmRefused(mem, room) {
  var kind = mem[0xE8];
  if (!(kind & 0x40)) { return room >= 0x18; }
  if (kind & 0x80) { return false; }
  return room >= 0x10 && room < 0x18;
} // fmRefused

/**
 * `$B52E` — one square's worth of lift shaft, drawn through the picture.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} x - Column, because column zero is drawn eight bytes back.
 */
function fmDrawShaft(mem, x) {
  var ptr = fmPointer(mem), y, base;
  if (mem[0xE8] & 0x40) {
    base = ptr.get();
    for (y = 7; y >= 0; y--) { mem[(base + y) & 0xFFFF] &= mem[FM_SHAFT_A + y]; }
  }
  if (mem[0xE8] & 0x80) {
    if (x === 0) { ptr.add(-8 & 0xFFFF); }
    base = ptr.get();
    for (y = 0x17; y >= 0x10; y--) { mem[(base + y) & 0xFFFF] &= mem[FM_SHAFT_B + y]; }
  }
} // fmDrawShaft

/**
 * `$B47E` — run a lift shaft from a room until it reaches another one it is
 * allowed to stop at, upwards first and downwards if the top runs out.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} x - Column of the room the shaft starts at.
 * @param {number} y - Its row.
 */
function fmShaft(mem, x, y) {
  mem[0xE4] = (y*9) & 255;
  var cell = (y*9 + x) & 255;
  mem[0xE4] = x;
  var kind = mem[0xE8];
  if (kind !== 0xC0) {
    cell = (cell + (kind === 0x40 ? -1 : 1)) & 255;
    if (mem[FM_GRID + cell] < 0x80 && !fmRefused(mem, mem[FM_GRID + cell])) { return; }
  }
  mem[0xE6] = cell;
  mem[0xE5] = y;
  var from = cell, start = y, at = cell, row = y;
  for (;;) {                                      // upwards
    at = at - 9;
    if (at < 0) { break; }
    row--;
    if (mem[FM_GRID + at] >= 0x80) { continue; }
    if (fmRefused(mem, mem[FM_GRID + at])) { continue; }
    for (;;) {                                    // and paint it back down
      row++;
      if (row === start) { return; }
      fmSeek(mem, x, row);
      fmDrawShaft(mem, x);
    }
  }
  at = from; row = start;
  for (;;) {                                      // downwards
    at = at + 9;
    if (at >= 0x36) { return; }
    row++;
    if (mem[FM_GRID + at] >= 0x80) { continue; }
    if (fmRefused(mem, mem[FM_GRID + at])) { continue; }
    for (;;) {
      row--;
      if (row === start) { return; }
      fmSeek(mem, x, row);
      fmDrawShaft(mem, x);
    }
  }
} // fmShaft

/**
 * The whole of `$B2B3`: shuffle the four tables of eight, clear the picture
 * and the grid, then place the rooms and run the shafts between them.
 *
 * @param {Uint8Array} mem - The machine's memory, as it is on entry to `$398F`.
 * @param {(function(): number|number)} entropy - The replaceable source, or a
 *   constant byte (which is what the traced original runs with).
 */
function generateFortressMap(mem, entropy) {
  var source = typeof entropy === 'function' ? entropy : function () { return entropy & 255; };
  var i, x, y, at;

  for (x = 0x1F; x >= 0; x--) { mem[FM_TABLES + x] = x; }
  for (mem[0xE4] = 0x0F; ; mem[0xE4] = (mem[0xE4] - 1) & 255) {
    for (var table = 0; table < 4; table++) {
      var base = FM_TABLES + table*8;
      x = fgRandom(mem, source()) & 7;
      var swap = mem[base + x];
      mem[base + x] = mem[base];
      mem[base] = swap;
    }
    if (mem[0xE4] === 0) { mem[0xE4] = 0xFF; break; }
  }

  for (i = 0; i < 256; i++) {
    mem[0xFC00 + i] = 0xFF; mem[0xFD00 + i] = 0xFF; mem[0xFE00 + i] = 0xFF;
  }
  for (x = 0x2F; x >= 0; x--) { mem[0xFF00 + x] = 0xFF; }
  for (x = 0x35; x >= 0; x--) { mem[FM_GRID + x] = 0xFF; }
  for (x = 0x65; x >= 0; x--) { mem[0xFF30 + x] = 0xFC; }

  // the seven rooms of the first table, each with a shaft from the third on
  for (x = 1; x < 8; x++) {
    y = fmRow(mem, source);
    at = fmDrawRoom(mem, mem[FM_TABLES - 1 + x], x, y);
    if (x >= 2) { mem[0xE8] = 0x40; fmShaft(mem, at.x, at.y); }
  }

  // nine more, each into a column drawn at random, with a shaft either way
  for (mem[0xE9] = 8; ; mem[0xE9] = (mem[0xE9] - 1) & 255) {
    var room = mem[0xFFD3 + mem[0xE9]];
    y = fmRow(mem, source);
    do { x = fgRandom(mem, source()) & 7; } while (x === 0);
    at = fmDrawRoom(mem, room, x, y);
    mem[0xE8] = 0xC0;
    fmShaft(mem, at.x, at.y);
    if (mem[0xE9] === 0) { mem[0xE9] = 0xFF; break; }
  }

  at = fmDrawRoom(mem, mem[0xFFE4], 0, 0);        // the room in the corner
  mem[0xE8] = 0x80;
  fmShaft(mem, at.x, at.y);

  y = fmRow(mem, source);
  at = fmDrawRoom(mem, mem[0xFFDC], 8, y);
  mem[0xE8] = 0x40;
  fmShaft(mem, at.x, at.y);

  for (mem[0xE9] = 7; ; mem[0xE9]--) {
    var third = mem[0xFFDC + mem[0xE9]];
    do { x = fgRandom(mem, source()) & 0x0F; } while (x === 0 || x >= 9);
    y = fmRow(mem, source);
    at = fmDrawRoom(mem, third, x, y);
    mem[0xE8] = 0x40;
    fmShaft(mem, at.x, at.y);

    var fourth = mem[0xFFE4 + mem[0xE9]];
    x = fgRandom(mem, source()) & 7;
    y = fmRow(mem, source);
    at = fmDrawRoom(mem, fourth, x, y);
    mem[0xE8] = 0x80;
    fmShaft(mem, at.x, at.y);
    if (mem[0xE9] === 1) { mem[0xE9] = 0; break; }
  }
  mem[0x27] = 0x6B; mem[0x28] = 0xB8;
} // generateFortressMap

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var fortressMap = {
  generateFortressMap: generateFortressMap,
  GRID: FM_GRID, COLUMNS: FM_COLUMNS, ROWS: FM_ROWS, BITMAP: FM_BITMAP, TABLES: FM_TABLES
};
// ve workeru je `self` globál, takže tyhle řádky nic nemění; pod Node je každý
// klasický skript ve vlastní obálce a bez nich by ho sourozenci neviděli
if (typeof self !== 'undefined') {
  self.fortressMap = fortressMap;
  self.generateFortressMap = generateFortressMap;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = fortressMap; }
