// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The fortress of Impossible Mission is shuffled at the start of every game:
 * which furniture stands where, what is hidden in it, how the platforms are
 * laid out, which thirty-six puzzle pieces belong together, and which of the
 * eight passwords the control room wants. A remake that cannot repeat a
 * shuffle has nothing to compare with a recording, so this is not an
 * extraction of one fortress — it is the original's generator, transcribed
 * (`MILNIKY.md` M2, `sources/docs/disasm_notes.md` §9).
 *
 * The original generator is `$7236`, six subroutines in a row, and it works
 * on the machine's memory: it reads its tables from it and writes the
 * fortress back into it. The transcription keeps that shape — it takes a
 * 64 KB `Uint8Array` — because that is what makes it provable: run it on the
 * memory the original had when it entered `$7236` and every byte it writes
 * has to come out the same (`tools/matchfortressgen.mjs`).
 *
 * The one thing that is **not** transcribed is where the entropy comes from.
 * The original mixes in the raster line (`EOR $D012` at `$82E3`); here that
 * is a replaceable source, which is exactly what `ZADANI.md` §10.4 asks for:
 * the mixer stays literal, only its input is seeded.
 */

/** where the generator's tables live, all of them read-only (disasm_notes §9) */
var FG_ROOMS = 0x20D6;          // 30 pointers to rooms, walked backwards
var FG_TEMPLATE_DEST = 0x1FDA;  // destinations for phase 2, $FF-terminated
var FG_TEMPLATE_SRC = 0x1D64;   // the stream of templates itself
var FG_TEMPLATE_HI = 0xB06F;    // the original self-modifies this high byte
var FG_FURNITURE_TILES = 0x2212; // 32 tile codes phase 1 draws from
var FG_PASSWORDS = 0x208E;      // 8 passwords, 9 letters each
var FG_PASSWORD_DEST = 0x4FB5;
var FG_PASSWORD_MASK = 0x345D;
var FG_PATTERNS = 0x26E3;       // 16 patterns of 8 bytes for the grid
var FG_GRID = 0xC9F0;           // 162*8 = 1296 bytes of fortress grid
var FG_PIECES = 0xBFC0;         // 36 puzzle pieces, 4 bytes each
var FG_PAIRS = 0xC100;          // 16x16 matrix that stops a pair repeating
var FG_MARKS = 0xB21F;          // 16 group marks, shuffled
var FG_SLOTS = 0x30F3;          // 128 pointers to searchable furniture

/** what a searched piece of furniture can hold (disasm_notes §9, phase 6) */
var FG_EMPTY = 0xFF;
var FG_TERMINAL_A = 0xFC;
var FG_TERMINAL_B = 0xFD;

/** the letters of a password are screen codes with `a` at $66 */
var FG_LETTER_BASE = 0x66;

/**
 * The original's mixer, `$82D6`, instruction for instruction — including the
 * carry, which `SBC` reads from the `LSR` above it.
 *
 * Its state is two bytes of zero page (`$EB`, `$EC`), so it lives in the
 * memory image like everything else and a run can be resumed from a dump.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} input - What the original gets from `$D012`: the entropy.
 * @returns {number} The next value, 0-255.
 */
function fgRandom(mem, input) {
  var a = mem[0xEB], c;
  c = a & 1; a >>= 1;                       // LSR A
  c = a & 1; a >>= 1;                       // LSR A
  var t = a - mem[0xEB] - (1 - c);          // SBC $EB
  c = t >= 0 ? 1 : 0; a = t & 255;
  c = a & 1; a >>= 1;                       // LSR A
  var ec = (mem[0xEC] << 1) | c;            // ROL $EC
  c = (ec >> 8) & 1; mem[0xEC] = ec & 255;
  mem[0xEB] = ((c << 7) | (mem[0xEB] >> 1)) & 255;   // ROR $EB
  return (mem[0xEB] ^ input) & 255;
} // fgRandom

/**
 * A 16-bit pointer in zero page, the way the original carries one around
 * ($18/$19, advanced by `$BF30`).
 * @param {Uint8Array} mem - The machine's memory.
 * @returns {{get: function(): number, set: function(number), add: function(number)}}
 */
function fgPointer(mem) {
  return {
    get: function () { return mem[0x18] | (mem[0x19] << 8); },
    set: function (value) { mem[0x18] = value & 255; mem[0x19] = (value >> 8) & 255; },
    add: function (delta) { this.set((this.get() + delta) & 0xFFFF); }
  };
} // fgPointer

/**
 * Phase 1 (`$B07E`) — the furniture and the decoration of all thirty rooms.
 *
 * Every room is a list of three-byte entries. The first byte of each entry is
 * the tile, and that is what gets shuffled: a random index into the table of
 * thirty-two tiles. Rooms whose list is followed by a second `$FF` keep the
 * whole table; the others are restricted to its upper half.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source (see the header).
 */
function fgFurniture(mem, entropy) {
  for (var x = 0x3A; x >= 0; x -= 2) {
    var room = mem[FG_ROOMS + x] | (mem[FG_ROOMS + x + 1] << 8);
    var y = 0;
    mem[0xE4] = 0;                                      // STY $E4
    while (mem[(room + y) & 0xFFFF] !== 0xFF) { y = (y + 1) & 255; }
    y = (y + 1) & 255;                                  // step past the $FF
    if (mem[(room + y) & 0xFFFF] !== 0xFF) { mem[0xE4] = 0x10; }
    for (y = 0; mem[(room + y) & 0xFFFF] !== 0xFF; y = (y + 3) & 255) {
      var pick = (fgRandom(mem, entropy()) & 0x1F) | mem[0xE4];
      mem[(room + y) & 0xFFFF] = mem[FG_FURNITURE_TILES + pick];
    }
  }
} // fgFurniture

/**
 * Phase 2 (`$B03B`) — the fixed templates copied into sixteen rooms.
 *
 * There is no randomness here at all: it is one long stream of `$FF`-ended
 * blocks poured into the destinations listed at `$1FDA`, and a destination is
 * finished when a block ends immediately after the one before it (two `$FF`
 * in a row). It is transcribed anyway, because it writes into the same room
 * data phase 1 just shuffled and the order matters.
 *
 * @param {Uint8Array} mem - The machine's memory.
 */
function fgTemplates(mem) {
  var ptr = fgPointer(mem), x = 0;
  mem[FG_TEMPLATE_HI] = (FG_TEMPLATE_SRC >> 8) & 255;   // the self-modified byte
  ptr.set(FG_TEMPLATE_DEST);
  for (;;) {
    mem[0xE4] = mem[ptr.get()];
    var high = mem[(ptr.get() + 1) & 0xFFFF];
    if (high === 0xFF) { return; }
    mem[0xE5] = high;
    var dest = mem[0xE4] | (high << 8);
    var y = 0, byte = 0;
    mem[0xE6] = 0;
    do {
      do {                                              // one $FF-ended block
        mem[0xE6] = byte;
        // the source is `$1D64,X` with the high byte of the base in memory,
        // so it is the pair (base, X) that walks, not one 16-bit pointer
        byte = mem[(((mem[FG_TEMPLATE_HI] << 8) | (FG_TEMPLATE_SRC & 255)) + x) & 0xFFFF];
        mem[(dest + y) & 0xFFFF] = byte;
        x = (x + 1) & 255;
        if (x === 0) { mem[FG_TEMPLATE_HI] = (mem[FG_TEMPLATE_HI] + 1) & 255; }
        y = (y + 1) & 255;
      } while (byte !== 0xFF);
    } while (mem[0xE6] !== 0xFF);                       // two $FF = destination done
    ptr.add(2);
  }
} // fgTemplates

/**
 * Phase 3 (`$B0C3`) — the password the control room will ask for.
 *
 * ★ The eight of them are in the original's memory at `$208E`, nine letters
 * each: SWORDFISH, ASPARAGUS, ARTICHOKE, CROCODILE, ALLIGATOR, ALBATROSS,
 * BUTTERFLY, CORMORANT.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 * @returns {number} Which password, 0-7.
 */
function fgPassword(mem, entropy) {
  var which = fgRandom(mem, entropy()) & 7;
  mem[0xE4] = which;
  var y = which*9 + 8;
  for (var x = 8; x >= 0; x--, y--) {
    mem[FG_PASSWORD_DEST + x] = mem[FG_PASSWORDS + y];
  }
  for (x = 8; x >= 0; x--) { mem[FG_PASSWORD_MASK + x] = 0x53; }   // covered letters
  return which;
} // fgPassword

/**
 * `$B12D` — the borders and the floors stamped into one band of the grid.
 *
 * It advances the pointer by two blocks of its own, which is why the caller
 * only adds one: a band is three blocks of forty-eight bytes and the bands
 * overlap by two thirds.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {object} ptr - The zero page pointer (`fgPointer`).
 */
function fgBand(mem, ptr) {
  var base = ptr.get(), y;
  for (y = 0x28; y >= 0; y -= 8) { mem[(base + y) & 0xFFFF] = 0xFF; }
  for (var pass = 2; pass >= 0; pass--) {
    base = ptr.get();
    for (y = 7; y >= 0; y--) { mem[(base + y) & 0xFFFF] |= 0xC0; }
    for (y = 0x2F; y >= 0x28; y--) { mem[(base + y) & 0xFFFF] |= 0x03; }
    if (pass === 0) { break; }
    ptr.add(0x30);
  }
  base = ptr.get();
  for (y = 0x2F; y >= 0; y -= 5) {
    mem[(base + y) & 0xFFFF] = 0;
    mem[(base + y - 1) & 0xFFFF] = 0;
    mem[(base + y - 2) & 0xFFFF] = 0;
    mem[(base + y - 3) & 0xFFFF] = 0xFF;
    y -= 3;                                   // the four bytes just written
  }
} // fgBand

/**
 * Phase 4 (`$B0E9`) — the grid of the fortress, 1 296 bytes at `$C9F0`.
 *
 * First 162 patterns of eight bytes are drawn at random from the sixteen at
 * `$26E3`, then nine bands of `fgBand` stamp the borders and floors over
 * them. The bytes look like multicolor pairs, so this is the platform layout
 * the rooms are drawn from.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 */
function fgGrid(mem, entropy) {
  var ptr = fgPointer(mem);
  ptr.set(FG_GRID);
  for (var i = 0xA2; i > 0; i--) {
    mem[0xE4] = i;
    var x = ((fgRandom(mem, entropy()) & 0x0F) << 3) + 7;
    var base = ptr.get();
    for (var y = 7; y >= 0; y--, x--) { mem[(base + y) & 0xFFFF] = mem[FG_PATTERNS + x]; }
    ptr.add(8);
  }
  mem[0xE4] = 0;                                  // DEC $E4 / BNE left it at zero
  ptr.set(FG_GRID);
  for (i = 8; i >= 0; i--) {
    mem[0xE4] = i;
    fgBand(mem, ptr);
    ptr.add(0x30);
  }
  mem[0xE4] = 0xFF;                               // DEC $E4 / BPL fell through
} // fgGrid

/**
 * `$B22F` — may these two pieces be a pair?
 *
 * The matrix at `$C100` is sixteen by sixteen: a pair is refused when either
 * direction is already taken, and taken in both directions when it is
 * allowed. That is what keeps the nine puzzles solvable.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {number} x - Offset of the piece record.
 * @param {number} other - The candidate, 0-15.
 * @returns {boolean} True when the pair was accepted (the original's carry clear).
 */
function fgPair(mem, x, other) {
  var mark = mem[(FG_PIECES + 1 + x) & 0xFFFF];
  if (other === mark) { return false; }
  var one = ((other << 4) | mark) & 255;
  if (mem[FG_PAIRS + one] !== 0) { return false; }
  mem[0xE8] = one;                                // STY $E8
  var two = ((mark << 4) | other) & 255;
  if (mem[FG_PAIRS + two] !== 0) { return false; }
  mem[FG_PAIRS + two] = 0xFF;
  mem[FG_PAIRS + one] = 0xFF;
  return true;
} // fgPair

/**
 * Phase 5 (`$B176`) — the thirty-six puzzle pieces, nine puzzles of four.
 *
 * A record is four bytes: the puzzle, the puzzle's shuffled mark, the piece
 * it fits, and its shape (a random pair of bits plus its place in the four).
 * The marks are 0-15 shuffled by sixty-four swaps against slot 2.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 */
function fgPuzzle(mem, entropy) {
  var i, x;
  for (i = 0; i < 256; i++) { mem[FG_PAIRS + i] = 0; }
  for (x = 0x0F; x >= 0; x--) { mem[FG_MARKS + x] = x; }
  for (x = 0x3F; x >= 0; x--) {
    var pick = fgRandom(mem, entropy()) & 0x0F;
    if (pick < 3) { pick += 3; }
    var swap = mem[FG_MARKS + pick];
    mem[FG_MARKS + pick] = mem[FG_MARKS + 2];
    mem[FG_MARKS + 2] = swap;
  }
  x = 0x8C;
  for (var puzzle = 8; puzzle >= 0; puzzle--) {
    mem[0xE4] = puzzle;
    var mark = mem[FG_MARKS + puzzle];
    mem[0xE5] = mark;
    for (var y = 3; y >= 0; y--) {
      mem[(FG_PIECES + x) & 0xFFFF] = puzzle;
      mem[(FG_PIECES + 1 + x) & 0xFFFF] = mark;
      mem[0xE6] = y;
      mem[(FG_PIECES + 3 + x) & 0xFFFF] = (fgRandom(mem, entropy()) & 0x0C) | y;
      if (y > 0) { x -= 4; }
    }
    // the two partners, drawn until the matrix allows them
    for (var slot = 0; slot < 2; slot++) {
      var other;
      do {
        other = fgRandom(mem, entropy()) & 0x0F;
        mem[0xE7] = other;
      } while (other === mem[(FG_PIECES + 1 + x) & 0xFFFF]);
      while (!fgPair(mem, x, other)) { other = (other + 1) & 0x0F; mem[0xE7] = other; }
      mem[(FG_PIECES + 2 + slot*8 + x) & 0xFFFF] = other;
      mem[(FG_PIECES + 6 + slot*8 + x) & 0xFFFF] = other;
    }
    x -= 4;
  }
  mem[0xE4] = 0xFF;                               // DEC $E4 / BPL fell through
} // fgPuzzle

/**
 * `$B29A` — a free piece of furniture, drawn until one is free.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 * @param {object} ptr - The zero page pointer the original leaves it in.
 * @returns {number} Address of the free slot.
 */
function fgFreeSlot(mem, entropy, ptr) {
  for (;;) {
    var y = fgRandom(mem, entropy()) & 0xFE;
    var slot = mem[FG_SLOTS + y] | (mem[FG_SLOTS + y + 1] << 8);
    ptr.set(slot);
    if (mem[slot] === FG_EMPTY) { return slot; }
  }
} // fgFreeSlot

/**
 * Phase 6 (`$B263`) — what is in which piece of furniture.
 *
 * All 128 slots are emptied, then thirty-six of them get a puzzle piece
 * (0-35) and nine each get the two kinds of terminal. Everything else stays
 * empty — which is the manual's four outcomes of a search, in code.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {function(): number} entropy - The replaceable source.
 */
function fgContents(mem, entropy) {
  var x;
  var ptr = fgPointer(mem);
  for (x = 0xFE; ; x = (x - 2) & 255) {
    var slot = mem[FG_SLOTS + x] | (mem[FG_SLOTS + x + 1] << 8);
    ptr.set(slot);
    mem[slot] = FG_EMPTY;
    if (((x - 2) & 255) >= 0xFE) { break; }
  }
  for (x = 0x23; x >= 0; x--) { mem[fgFreeSlot(mem, entropy, ptr)] = x; }
  for (x = 8; x >= 0; x--) {
    mem[fgFreeSlot(mem, entropy, ptr)] = FG_TERMINAL_A;
    mem[fgFreeSlot(mem, entropy, ptr)] = FG_TERMINAL_B;
  }
} // fgContents

/**
 * The whole of `$7236`: six phases, in the original's order.
 *
 * @param {Uint8Array} mem - The machine's memory, as it is on entry to `$7236`.
 * @param {(function(): number|number)} entropy - The replaceable source of
 *   entropy, or a constant byte (which is what the traced original runs with).
 * @returns {{password: number}} What the caller needs to know about the draw.
 */
function generateFortress(mem, entropy) {
  var source = typeof entropy === 'function' ? entropy : function () { return entropy & 255; };
  fgFurniture(mem, source);
  fgTemplates(mem);
  var password = fgPassword(mem, source);
  fgGrid(mem, source);
  fgPuzzle(mem, source);
  fgContents(mem, source);
  return {password: password};
} // generateFortress

// published the way every classic worker script is (`svision/tools/classicScript.cjs`):
// in the worker through `self`, under Node through `module.exports` — the same file
var fortressGen = {
  generateFortress: generateFortress,
  random: fgRandom,
  PASSWORDS: FG_PASSWORDS, PASSWORD_DEST: FG_PASSWORD_DEST, LETTER_BASE: FG_LETTER_BASE,
  GRID: FG_GRID, PIECES: FG_PIECES, SLOTS: FG_SLOTS,
  EMPTY: FG_EMPTY, TERMINAL_A: FG_TERMINAL_A, TERMINAL_B: FG_TERMINAL_B
};
// ve workeru je `self` globál, takže tyhle řádky nic nemění; pod Node je každý
// klasický skript ve vlastní obálce a bez nich by ho sourozenci neviděli
if (typeof self !== 'undefined') {
  self.fortressGen = fortressGen;
  self.generateFortress = generateFortress;
  self.fgRandom = fgRandom;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = fortressGen; }
