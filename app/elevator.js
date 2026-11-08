// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The shaft and the lift — the second of the two loops the game has
 * (`sources/docs/disasm_notes.md` §19, §20).
 *
 * ★ **The shaft does not scroll by pixels, it is rebuilt by character
 * rows.** One step of the lift moves the whole window of the shaft (screen
 * rows 0 to 14) by exactly one row and puts together a new row at the edge
 * that was uncovered: going up at the top (`$7749` into `$4000`), going
 * down at the bottom (`$7631` into `$4230`). The six columns of the shaft
 * itself (`$10`-`$17`) are never moved — that is where the cabin is.
 *
 * ★ **A step is two frames.** Both `$855A` (up) and `$8590` (down) wait for
 * a raster line first (`$A3` and `$3B`), then do their work, and then wait
 * until the frame counter `$E0` has gone up by **two**. So the lift moves
 * at 25 rows a second while the agent walks at one step every third frame.
 *
 * ★ **The lift stops on its own at a doorway, and letting go of the stick
 * does not stop it.** The ride loop `$3A85` asks the stick only whether the
 * *other* direction has been asked for; with the stick at rest it takes
 * another step all the same. It breaks out when `$1F` or `$20` — the phase
 * of the door being drawn on either side — reaches `$0B`, and at the two
 * ends of the shaft (`$1D` and `$1E`). That is why the lift of Impossible
 * Mission always comes to rest level with a door.
 *
 * What the doors are made of is not a picture either: five static tables
 * (`data/shaft.json`) and the colour of the room behind the door, which is
 * read out of the fortress the generator shuffled (`$78DC` → `$FF96` →
 * `$0E70` → the first byte of the room's record, §12). Between doorways the
 * wall is **shuffled**, two characters at a time, by the same mixer as
 * everything else (`$82D6`, §8).
 *
 * The transcription works on the machine's memory for the same reason
 * `player.js` and `roomBuild.js` do: run it on the memory the original had
 * before a step and every byte it writes has to come out the same
 * (`tools/matchelevator.mjs` against `tools/traceelevator.py`).
 */

/** the cable: three phases, `$0DBD` indexed by this */
var EL_CABLE = 0x1B;

/** the sub-row, 0 to 5: six steps of the lift make one character row */
var EL_SUB = 0x1C;

/** the two ends of the shaft: at the top `$855A` does nothing, at the bottom `$8590` */
var EL_AT_TOP = 0x1D, EL_AT_BOTTOM = 0x1E;

/** the phase of the doorway on each side (`$1F` right, `$20` left), `$FF` = none */
var EL_DOOR = 0x1F;

/** the colour of the room behind that doorway (`$23` right, `$24` left) */
var EL_DOOR_COLOUR = 0x23;

/** the two voices of the lift's tone: they climb here and decay in `$3A2B` */
var EL_TONE1 = 0x25, EL_TONE2 = 0x26;
/** the SID registers `$3A1B` writes by name */
var EL_FREHI1 = 0xD401, EL_VCREG1 = 0xD404,
    EL_FREHI2 = 0xD408, EL_VCREG2 = 0xD40B;

/** where the cabin is in the fortress — and, as it happens, sprite 6 */
var EL_CAB_X = 0x27, EL_CAB_Y = 0x28;

/** the two pairs of pointers the scrolls carry, screen and colour */
var EL_DST = 0x10, EL_SRC = 0x12, EL_CDST = 0x14, EL_CSRC = 0x16;

/** and the one the picture of the fortress is read through (`$787F`) */
var EL_ROW_PTR = 0x18;

/** the scratch the shaft shares with everything else */
var EL_E4 = 0xE4, EL_E5 = 0xE5, EL_E6 = 0xE6, EL_E8 = 0xE8, EL_E9 = 0xE9;

/** the screen of the game, its last shaft row, and the colour behind them */
var EL_SCREEN = 0x4000, EL_ROW14 = 0x4230;
var EL_COLOUR = 0xD800, EL_COLOUR14 = 0xDA30;

/** the static tables `data/shaft.json` carries (`tools/dumpshaft.py`) */
var EL_TOP_RESTORE = 0x0D00, EL_CABLE_CHARS = 0x0DBD, EL_CEILING = 0x0DC0,
    EL_FLOOR = 0x0DC8, EL_POST = 0x0DD0, EL_OUTER = 0x0DD2, EL_SPAN = 0x0DD4,
    EL_MASK = 0x0DD6, EL_DOOR_OPEN = 0x0DD8, EL_DOOR_LINTEL = 0x0E00,
    EL_DOOR_SILL = 0x0E28, EL_COLOUR_LO = 0x0E50, EL_COLOUR_HI = 0x0E5E,
    EL_PICTURE = 0x78A4, EL_FLASH = 0x741F;

/** what the shuffle of the fortress left behind (§11, §12) */
var EL_GRID = 0xFF96, EL_ROOM_PTRS = 0x0E70, EL_MARKS = 0xFF30;

/** the cabin's mark on the map is sprite 6; the agent is sprites 1 to 3 */
var EL_SP6X = 0xD00C, EL_SP6Y = 0xD00D, EL_SP6COL = 0xD02D;
var EL_SP1X = 0xD002, EL_MSIGX = 0xD010;
// ★ `$8E5F`, kabina jako sprajt 0, je **krok agenta** (`$8724`), ne výtah —
// bydlí v `app/player.js` (`plCabin`) a nekopíruje se sem

function elByte(v) { return v & 0xFF; }
function elLoad(m, a) { return rbLoad(m, a); }
function elStore(m, a, v) { rbStore(m, a, v); }
function elWord(m, a) { return elLoad(m, a) | (elLoad(m, a + 1) << 8); }

/* -------------------------------------------------------------- the map */

/**
 * `$787F` — one byte of the picture of the fortress the map shuffle drew
 * (`$FC08` and five more rows of `$88` bytes, §11). It is what tells the
 * shaft whether there is a room to open a door into.
 *
 * ★ The caller's `Y` goes through `$E9` and comes back, so the byte is
 * passed in and out here as well: it is zero page and a comparison sees it.
 *
 * @param {Object} m - The machine.
 * @param {number} a - The row of the fortress, already offset by the caller.
 * @param {number} carry - 0 when that subtraction borrowed, and then there
 *   is no row and the answer is `$FF` (`$787A`).
 * @param {number} y - What the caller had in `Y`.
 * @returns {number} The byte, or `$FF`.
 */
function elPictureByte(m, a, carry, y) {
  if (!carry) { return 0xFF; }
  elStore(m, EL_E9, y);
  elStore(m, EL_E8, a & 0x07);
  var row = (a & 0xF8) >> 2;                       // AND #$F8, LSR, LSR
  var at = elWord(m, EL_PICTURE + row);
  elStore(m, EL_ROW_PTR, at & 0xFF);               // ★ `$18`/`$19`, ne `$10`
  elStore(m, EL_ROW_PTR + 1, at >> 8);
  var i = elByte(elByte(elLoad(m, EL_CAB_X) - 0x6B) + elLoad(m, EL_E8));
  return elLoad(m, (at + i) & 0xFFFF);
} // elPictureByte

/**
 * `$78B5` — the cabin's square of the 9 × 6 grid the map shuffle left at
 * `$FF96` (§11): nine to a row, and a column every sixteen of `$27`.
 * @param {Object} m - The machine.
 * @param {number} a - The row of the fortress, already offset by the caller.
 * @param {number} carry - 0 when that subtraction borrowed (then the row is 0).
 * @returns {number} The index into the grid.
 */
function elGridIndex(m, a, carry) {
  var v = carry ? a : 0;
  v &= 0xF8;
  elStore(m, EL_E9, v);
  v = elByte((v >> 3) + v);                        // ★ osmkrát řádek + řádek = 9×
  elStore(m, EL_E9, v);
  var col = elByte(elLoad(m, EL_CAB_X) - 0x6B) >> 4;
  return elByte(col + v);
} // elGridIndex

/**
 * `$78D2` / `$78DC` — the colour of the room the lift is passing, which is
 * the **first byte of that room's record** (§12). The record is found the
 * long way round: the grid at `$FF96` says which room, `$0E70` says where
 * its record is, and the original writes that address into its own next
 * instruction.
 *
 * @param {Object} m - The machine.
 * @param {number} side - 0 right, 1 left; the room to the right is the next
 *   square of the grid (`$78E6`: `TXA`, `BNE`, `INY`).
 * @param {number} offset - `$B6` going down (`$78DC`), `$BA` going up (`$78D2`).
 * @returns {number} The colour.
 */
function elRoomColour(m, side, offset) {
  var a = elLoad(m, EL_CAB_Y) - offset;
  var index = elGridIndex(m, elByte(a), a >= 0 ? 1 : 0);
  if (side === 0) { index = elByte(index + 1); }
  var room = elLoad(m, (EL_GRID + index) & 0xFFFF);
  var record = elWord(m, EL_ROOM_PTRS + elByte(room << 1));
  return elLoad(m, record);
} // elRoomColour

/* ------------------------------------------------------------ the cabin */

/**
 * `$B757` — where the cabin is on the little map of the fortress at the
 * bottom of the shaft screen, and the character that marks it. ★ The mark
 * is also written into `$FF30`, one byte a square, so the map remembers
 * where the lift has been.
 * @param {Object} m - The machine.
 * @returns {number} The character to draw.
 */
function elMarkCabin(m) {
  var col = elByte(elLoad(m, EL_CAB_X) - 0x68) >> 3;
  elStore(m, EL_E4, col);
  var row = elByte(elByte(elLoad(m, EL_CAB_Y) - 0xB8) & 0xF8) << 1;
  elStore(m, EL_E5, elByte(row));
  // ★ všechny tři `ADC` jdou s nulovým přenosem: `$E5` je násobek šestnácti
  var a = elByte((elByte(row) >> 4) + elByte(row) + col + elLoad(m, EL_E6));
  elStore(m, (EL_MARKS + a) & 0xFFFF, elByte(a + 0x8A));
  return elByte(a + 0x8A);
} // elMarkCabin

/**
 * `$73E4` — the cabin, once a pass of the shaft loop: sprite 6 goes where
 * `$27`/`$28` say, its colour flashes out of `$741F`, and the mark is drawn
 * on the map at the bottom of the screen (`$42B2` + row).
 * @param {Object} m - The machine.
 */
function elCabin(m) {
  elStore(m, EL_SP6X, elLoad(m, EL_CAB_X));
  elStore(m, EL_SP6Y, elLoad(m, EL_CAB_Y));
  elStore(m, EL_SP6COL, elLoad(m, EL_FLASH + ((elLoad(m, 0xE0) >> 2) & 7)));
  elStore(m, EL_E6, 1);
  var mark = elMarkCabin(m);
  elStore(m, EL_DST, 0x8A);
  elStore(m, EL_DST + 1, 0x42);
  // `$AF2F` posouvá **oba** ukazatele, `$10`/`$11` i `$14`/`$15`
  for (var x = elLoad(m, EL_E5) >> 4; x >= 0; x--) {
    var v = elLoad(m, EL_DST) + 0x28;
    elStore(m, EL_DST, v); elStore(m, EL_CDST, v);
    if (v > 0xFF) {
      elStore(m, EL_DST + 1, elByte(elLoad(m, EL_DST + 1) + 1));
      elStore(m, EL_CDST + 1, elByte(elLoad(m, EL_CDST + 1) + 1));
    }
  }
  elStore(m, (elWord(m, EL_DST) + elLoad(m, EL_E4)) & 0xFFFF, mark);
} // elCabin

/* ------------------------------------------------------------- the tone */

/**
 * `$85B3` — the tone of the lift climbs a little with every step; the shaft
 * loop lets it fall again (`$3A2B`). The two bytes of zero page are the
 * pitch, and `$85C7` (M6, `app/sound.js`) turns them into the two voices.
 * @param {Object} m - The machine.
 */
function elTone(m) {
  if (elLoad(m, EL_TONE1) < 0x20) {
    elStore(m, EL_TONE1, elByte(elLoad(m, EL_TONE1) + 4));
  }
  if (elLoad(m, EL_TONE2) < 0x18) {
    elStore(m, EL_TONE2, elByte(elLoad(m, EL_TONE2) + 3));
  }
  sndLift(m);
} // elTone

/**
 * `$3A1B` — and the other half of it, once a pass of the shaft loop: the
 * tone decays until it is silent.
 *
 * ★ **A tone that is only let fall never stops.** The pitch of voice 1 is
 * written out on every pass (`$3A1D`), and **on the pass where it reaches
 * zero the same zero goes into `VCREG1` and `VCREG2`** (`$3A22`, `$3A25`) —
 * that, not the falling pitch, is what ends the lift's noise. The two
 * voices are gated on with a sustain of 8 (`$85B3`), so without those two
 * writes they sustain for ever and the lift keeps humming after it has
 * stopped. The high byte of voice 2 is written at `$3A39` as well, and from
 * `$26` — which is zero once `$26` has run out.
 *
 * @param {Object} m - The machine.
 */
function elToneDecay(m) {
  var a = elLoad(m, EL_TONE1);
  elStore(m, EL_FREHI1, a);                        // `$3A1D`
  if (!a) {
    elStore(m, EL_VCREG1, 0);                      // `$3A22` — a
    elStore(m, EL_VCREG2, 0);                      // `$3A25` — the lift goes quiet
    return;
  }
  elStore(m, EL_TONE1, elByte(a - 4));
  var b = elLoad(m, EL_TONE2);
  if (b) { b = elByte(b - 3); elStore(m, EL_TONE2, b); }
  elStore(m, EL_FREHI2, b);                        // `$3A39`
} // elToneDecay

/* ----------------------------------------------------------- the scroll */

/**
 * `$73CA` — one step down: the sub-row goes up, and every sixth step the
 * cabin is a whole character row lower. The cable turns with it.
 * @param {Object} m - The machine.
 */
function elAdvance(m) {
  var sub = elByte(elLoad(m, EL_SUB) + 1);
  if (sub >= 6) { sub = 0; elStore(m, EL_CAB_Y, elByte(elLoad(m, EL_CAB_Y) + 1)); }
  elStore(m, EL_SUB, sub);
  var cable = elByte(elLoad(m, EL_CABLE) + 1);
  elStore(m, EL_CABLE, cable >= 3 ? 0 : cable);
} // elAdvance

/**
 * `$8568` — the same thing backwards, at the top of the step up.
 * @param {Object} m - The machine.
 */
function elRetreat(m) {
  var sub = elByte(elLoad(m, EL_SUB) - 1);
  if (sub & 0x80) { sub = 5; elStore(m, EL_CAB_Y, elByte(elLoad(m, EL_CAB_Y) - 1)); }
  elStore(m, EL_SUB, sub);
  var cable = elByte(elLoad(m, EL_CABLE) - 1);
  elStore(m, EL_CABLE, (cable & 0x80) ? 2 : cable);
} // elRetreat

/**
 * `$74C0` — the shaft moves **down** the screen, because the lift is going
 * up: rows 0 to 13 are copied to 1 to 14 and row 14 is then rebuilt. Only
 * the screen; the colour is recomputed from scratch by `$75A5`.
 *
 * ★ The first thing it does is wipe the floor of the shaft if it was drawn,
 * because once the lift has moved the floor is no longer at the bottom.
 * @param {Object} m - The machine.
 */
function elScrollDown(m) {
  var x, y;
  if (elLoad(m, EL_AT_BOTTOM)) {
    for (x = 5; x >= 0; x--) { elStore(m, 0x4241 + x, 0x28); }
    elStore(m, EL_AT_BOTTOM, 0);
  }
  elStore(m, EL_SRC, 0x08); elStore(m, EL_SRC + 1, 0x42);       // $4208, řádek 13
  elStore(m, EL_DST, 0x30); elStore(m, EL_DST + 1, 0x42);       // $4230, řádek 14
  for (x = 13; x >= 0; x--) {
    var dst = elWord(m, EL_DST), src = elWord(m, EL_SRC);
    for (y = 0x27; y >= 0x17; y--) { elStore(m, dst + y, elLoad(m, src + y)); }
    for (y = 0x10; y >= 0x00; y--) { elStore(m, dst + y, elLoad(m, src + y)); }
    elStore(m, EL_DST + 1, elLoad(m, EL_SRC + 1));
    elStore(m, EL_DST, elLoad(m, EL_SRC));
    var lo = elLoad(m, EL_SRC) - 0x28;
    elStore(m, EL_SRC, lo);
    if (lo < 0) { elStore(m, EL_SRC + 1, elByte(elLoad(m, EL_SRC + 1) - 1)); }
  }
} // elScrollDown

/**
 * `$744B` — and the other way: rows 1 to 14 to 0 to 13, **screen and
 * colour together**, because going down nothing recomputes the colour.
 *
 * ★ And first it puts the ceiling back if it was drawn (`$0D00` on to
 * `$4011`), for the same reason `$74C0` wipes the floor.
 * @param {Object} m - The machine.
 */
function elScrollUp(m) {
  var x, y, pass;
  if (elLoad(m, EL_AT_TOP)) {
    for (x = 5; x >= 0; x--) {
      elStore(m, 0x4011 + x, elLoad(m, EL_TOP_RESTORE + x));
    }
    elStore(m, 0xD813, 0); elStore(m, 0xD814, 0);
    elStore(m, EL_AT_TOP, 0);
  }
  var starts = [[0x00, 0x28], [0x17, 0x3F]];      // sloupce 0-16, pak 23-39
  for (pass = 0; pass < 2; pass++) {
    elStore(m, EL_E4, 1 - pass);
    elStore(m, EL_DST, starts[pass][0]); elStore(m, EL_CDST, starts[pass][0]);
    elStore(m, EL_SRC, starts[pass][1]); elStore(m, EL_CSRC, starts[pass][1]);
    elStore(m, EL_DST + 1, 0x40); elStore(m, EL_SRC + 1, 0x40);
    elStore(m, EL_CDST + 1, 0xD8); elStore(m, EL_CSRC + 1, 0xD8);
    for (x = 13; x >= 0; x--) {
      var dst = elWord(m, EL_DST), src = elWord(m, EL_SRC);
      var cdst = elWord(m, EL_CDST), csrc = elWord(m, EL_CSRC);
      for (y = 0x10; y >= 0; y--) {
        elStore(m, dst + y, elLoad(m, src + y));
        elStore(m, cdst + y, elLoad(m, csrc + y));
      }
      elStore(m, EL_DST + 1, elLoad(m, EL_SRC + 1));
      elStore(m, EL_DST, elLoad(m, EL_SRC));
      var lo = elLoad(m, EL_SRC) + 0x28;
      elStore(m, EL_SRC, lo);
      if (lo > 0xFF) { elStore(m, EL_SRC + 1, elByte(elLoad(m, EL_SRC + 1) + 1)); }
      elStore(m, EL_CDST + 1, elLoad(m, EL_CSRC + 1));
      elStore(m, EL_CDST, elLoad(m, EL_CSRC));
      lo = elLoad(m, EL_CSRC) + 0x28;
      elStore(m, EL_CSRC, lo);
      if (lo > 0xFF) { elStore(m, EL_CSRC + 1, elByte(elLoad(m, EL_CSRC + 1) + 1)); }
    }
    elStore(m, EL_DST, 0x17); elStore(m, EL_CDST, 0x17);
  }
  elStore(m, EL_E4, 0xFF);
} // elScrollUp

/* ----------------------------------------------------------- the colour */

/**
 * `$7612` — one colour row of one side, seventeen cells wide.
 * @param {Object} m - The machine.
 * @param {number} side - 0 right, 1 left.
 * @param {number} row - 0 to 13, an index into `$0E50`/`$0E5E`.
 * @param {number} colour - What to write.
 */
function elColourRow(m, side, row, colour) {
  var at = elLoad(m, EL_COLOUR_LO + row) | (elLoad(m, EL_COLOUR_HI + row) << 8);
  var y = elLoad(m, EL_SPAN + side);
  for (var x = 0x10; x >= 0; x--, y--) { elStore(m, at + y, colour); }
} // elColourRow

/**
 * `$75A5` — the colour of both sides of the shaft, all fourteen rows of it,
 * recomputed from the phase of the doorway. It runs on the way **up** only;
 * on the way down the colour scrolls with the screen.
 *
 * ★ Read it as five stripes that paint over each other, not as five cases:
 * the door's frame (`$08`), its edge (`$01`), the room behind it (`$23`),
 * its floor (`$09`) and the plain wall (`$01`) each land on one row, and
 * which row is what the phase says.
 *
 * @param {Object} m - The machine.
 */
function elColours(m) {
  for (var side = 1; side >= 0; side--) {
    elStore(m, EL_E4, side);
    var a = elLoad(m, EL_DOOR + side), row;
    if (a & 0x80) {
      row = 0x0D;                                   // `$75AD` — žádné dveře
    } else {
      if (a < 0x0E) { elColourRow(m, side, a, 0x08); }
      if (a < 0x0F && a >= 0x01) { elColourRow(m, side, a - 1, 0x01); }
      if (a < 0x10 && a >= 0x02) {
        elColourRow(m, side, a - 2, elLoad(m, EL_DOOR_COLOUR + side));
      }
      if (a < 0x15 && a >= 0x07) { elColourRow(m, side, a - 7, 0x09); }
      if (a < 0x08) { continue; }                   // `$75ED` — zeď nikde
      row = a - 0x08;
    }
    var at = elLoad(m, EL_COLOUR_LO + row) | (elLoad(m, EL_COLOUR_HI + row) << 8);
    var y = elLoad(m, EL_OUTER + side);
    for (var x = 0x0F; x >= 0; x--, y--) { elStore(m, at + y, 0x01); }
  }
} // elColours

/* ------------------------------------------------------- the new row */

/**
 * `$76E2` / `$7805` — the wall between two doorways. ★ On every other
 * sub-row it is **shuffled**, two characters at a time, by the mixer
 * (`$82D6`); on the others it is copied off the row next to it with one
 * added or taken away, which is how the brickwork keeps going.
 *
 * @param {Object} m - The machine.
 * @param {number} side - 0 right, 1 left.
 * @param {number} up - 1 on the way up (row 0), 0 on the way down (row 14).
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function elWall(m, side, up, entropy) {
  var row = up ? EL_SCREEN : EL_ROW14;
  var colour = up ? EL_COLOUR : EL_COLOUR14;
  var y = elLoad(m, EL_OUTER + side), x;
  if (!(elLoad(m, EL_SUB) & 1)) {
    for (x = 7; x >= 0; x--) {
      fgRandom(m.mem, entropy());
      var a = fgRandom(m.mem, entropy()) & 0x1C;
      if (up) { a |= 0x01; }
      elStore(m, row + y, a);
      a = elByte(a + 2);
      y--;
      elStore(m, row + y, a);
      elStore(m, colour + y + 1, 0x01);
      elStore(m, colour + y, 0x01);
      y--;
    }
  } else {
    // ★ soused: nahoru je to řádek 1 o jedna míň, dolů řádek 13 o jedna víc
    for (x = 0x0F; x >= 0; x--, y--) {
      elStore(m, row + y, elByte(elLoad(m, row + (up ? 0x28 : -0x28) + y)
                                 + (up ? -1 : 1)));
    }
  }
  return elLoad(m, EL_CABLE_CHARS + elLoad(m, EL_CABLE));   // `$7707` / `$782C`
} // elWall

/**
 * `$7631` — the row that appears at the bottom (`$4230`) when the lift goes
 * down, for both sides of the shaft.
 *
 * ★ The phase of the doorway, `$1F` and `$20`, counts **down** from `$15`
 * to `$FF`, and each value is one row of the door: `$15` the opening,
 * `$10` the sill, `$0F` the solid top, the rest wall. At `$FF` there is no
 * door, and a new one may start — if the sub-row is right, if the picture
 * of the fortress says there is a room there, and if its mask agrees.
 *
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function elNewRowDown(m, entropy) {
  for (var side = 1; side >= 0; side--) {
    var y = elLoad(m, EL_OUTER + side), x, post, a = elLoad(m, EL_DOOR + side);
    elStore(m, EL_E4, side);
    post = -1;
    if (!(a & 0x80)) {
      elStore(m, EL_DOOR + side, elByte(a - 1));
      if (a === 0x15) {
        elStore(m, EL_E5, elLoad(m, EL_DOOR_COLOUR + side));
        for (x = 0x0F; x >= 0; x--, y--) {
          elStore(m, EL_ROW14 + y, elLoad(m, EL_DOOR_OPEN + y));
          elStore(m, EL_COLOUR14 + y, elLoad(m, EL_E5));
        }
        y = elLoad(m, EL_POST + side);
        elStore(m, EL_COLOUR14 + y, elLoad(m, EL_E5));
        elStore(m, EL_ROW14 + y, 0x28);
        continue;
      }
      if (a === 0x10) {
        y = elLoad(m, EL_SPAN + side);
        for (x = 0x10; x >= 0; x--, y--) {
          elStore(m, EL_ROW14 + y, elLoad(m, EL_DOOR_SILL + y));
          elStore(m, EL_COLOUR14 + y, 0x01);
        }
        continue;
      }
      if (a === 0x0F) {
        for (x = 0x0F; x >= 0; x--, y--) {
          elStore(m, EL_ROW14 + y, 0x21);
          elStore(m, EL_COLOUR14 + y, 0x08);
        }
        post = 0x23;
      } else if (a > 0x0F) {
        continue;                                   // `$7654` — nekreslí se nic
      } else {
        post = elWall(m, side, 0, entropy);
      }
    } else if (!elLoad(m, EL_SUB)
               && !(elPictureByte(m, elByte(elLoad(m, EL_CAB_Y) - 0xB8),
                                  elLoad(m, EL_CAB_Y) >= 0xB8 ? 1 : 0, y)
                    & elLoad(m, EL_MASK + side))) {
      elStore(m, EL_DOOR_COLOUR + side, elRoomColour(m, side, 0xB6));
      elStore(m, EL_DOOR + side, 0x15);
      for (x = 0x0F; x >= 0; x--, y--) {
        elStore(m, EL_ROW14 + y, elLoad(m, EL_DOOR_LINTEL + y));
        elStore(m, EL_COLOUR14 + y, 0x09);
      }
      post = 0x22;
    } else {
      post = elWall(m, side, 0, entropy);
    }
    y = elLoad(m, EL_POST + side);                   // `$76A9`
    elStore(m, EL_ROW14 + y, post);
    elStore(m, EL_COLOUR14 + y, 0x08);
  }
  // `$7725` — a když je pod kabinou dno pevnosti, nakreslí se a výtah stojí
  if (elLoad(m, EL_SUB) === 0x04) {
    var below = elLoad(m, EL_CAB_Y);
    // ★ `CLC` před `SBC #$B5` znamená `$28 - $B6`, ne `- $B5`
    if (below >= 0xE6
        || elPictureByte(m, elByte(below - 0xB6), below >= 0xB6 ? 1 : 0, 0) === 0xFF) {
      for (var i = 7; i >= 0; i--) {
        elStore(m, 0x4240 + i, elLoad(m, EL_FLOOR + i));
      }
      elStore(m, EL_AT_BOTTOM, elByte(elLoad(m, EL_AT_BOTTOM) + 1));
    }
  }
} // elNewRowDown

/**
 * `$7749` — and the row that appears at the top (`$4000`) when the lift
 * goes up. The mirror of `$7631`: the phase counts **up** from `$00` to
 * `$15` and then to `$FF`, so the same door is drawn in the other order.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function elNewRowUp(m, entropy) {
  for (var side = 1; side >= 0; side--) {
    var y = elLoad(m, EL_OUTER + side), x, post, a = elLoad(m, EL_DOOR + side);
    elStore(m, EL_E4, side);
    post = -1;
    if (!(a & 0x80)) {
      var next = elByte(a + 1);
      elStore(m, EL_DOOR + side, next >= 0x16 ? 0xFF : next);
      if (a === 0x00) {
        y = elLoad(m, EL_SPAN + side);
        for (x = 0x10; x >= 0; x--, y--) {
          elStore(m, EL_SCREEN + y, elLoad(m, EL_DOOR_SILL + y));
          elStore(m, EL_COLOUR + y, 0x01);
        }
        continue;
      }
      if (a === 0x01) {
        elStore(m, EL_E5, elLoad(m, EL_DOOR_COLOUR + side));
        for (x = 0x0F; x >= 0; x--, y--) {
          elStore(m, EL_SCREEN + y, elLoad(m, EL_DOOR_OPEN + y));
          elStore(m, EL_COLOUR + y, elLoad(m, EL_E5));
        }
        y = elLoad(m, EL_POST + side);
        elStore(m, EL_COLOUR + y, elLoad(m, EL_E5));
        elStore(m, EL_SCREEN + y, 0x28);
        continue;
      }
      if (a === 0x06) {
        for (x = 0x0F; x >= 0; x--, y--) {
          elStore(m, EL_SCREEN + y, elLoad(m, EL_DOOR_LINTEL + y));
          elStore(m, EL_COLOUR + y, 0x09);
        }
        post = 0x22;
      } else if (a < 0x06) {
        continue;                                   // `$7775` — nekreslí se nic
      } else {
        post = elWall(m, side, 1, entropy);
      }
    } else if (elLoad(m, EL_SUB) === 0x04
               && !(elPictureByte(m, elByte(elLoad(m, EL_CAB_Y) - 0xBB),
                                  elLoad(m, EL_CAB_Y) >= 0xBB ? 1 : 0, y)
                    & elLoad(m, EL_MASK + side))) {
      elStore(m, EL_DOOR_COLOUR + side, elRoomColour(m, side, 0xBA));
      elStore(m, EL_DOOR + side, 0x00);
      for (x = 0x0F; x >= 0; x--, y--) {
        elStore(m, EL_SCREEN + y, 0x21);
        elStore(m, EL_COLOUR + y, 0x08);
      }
      post = 0x23;
    } else {
      post = elWall(m, side, 1, entropy);
    }
    y = elLoad(m, EL_POST + side);                   // `$77CB`
    elStore(m, EL_SCREEN + y, post);
    elStore(m, EL_COLOUR + y, 0x08);
  }
  // `$784A` — a když je nad kabinou strop pevnosti, nakreslí se a výtah stojí
  if (elLoad(m, EL_SUB) === 0x05) {
    var above = elLoad(m, EL_CAB_Y);
    if (elPictureByte(m, elByte(above - 0xBB), above >= 0xBB ? 1 : 0, 0) === 0xFF) {
      for (var i = 7; i >= 0; i--) {
        elStore(m, 0x4010 + i, elLoad(m, EL_CEILING + i));
      }
      elStore(m, 0xD813, 0x0F); elStore(m, 0xD814, 0x0F);
      elStore(m, EL_AT_TOP, elByte(elLoad(m, EL_AT_TOP) + 1));
    }
  }
} // elNewRowUp

/* -------------------------------------------------------------- a step */

/**
 * `$855A` — one step of the lift **up**. Does nothing once the shaft has a
 * ceiling (`$1D`).
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 * @returns {number} 1 if the lift moved.
 */
function elUp(m, entropy) {
  if (elLoad(m, EL_AT_TOP)) { return 0; }
  elRetreat(m);
  elScrollDown(m);
  elColours(m);
  elNewRowUp(m, entropy);
  elTone(m);
  return 1;
} // elUp

/**
 * `$8590` — one step of the lift **down**. Does nothing once the shaft has
 * a floor (`$1E`).
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 * @returns {number} 1 if the lift moved.
 */
function elDown(m, entropy) {
  if (elLoad(m, EL_AT_BOTTOM)) { return 0; }
  elScrollUp(m);
  elNewRowDown(m, entropy);
  elTone(m);
  elAdvance(m);
  return 1;
} // elDown

/**
 * `$3A5E` — is the agent standing in the cabin? Only then does the stick
 * drive the lift instead of the agent.
 * @param {Object} m - The machine.
 * @returns {boolean} True when he is.
 */
function elInCabin(m) {
  if (elLoad(m, EL_MSIGX) & 0x02) { return false; }
  var x = elLoad(m, EL_SP1X);
  return x >= 0xA2 && x < 0xB7 && elLoad(m, 0x3F) === 0x0E;
} // elInCabin

/**
 * `$3A91` / `$3AB8` — ★ what stops a ride that is not at an end of the
 * shaft: **a doorway half drawn**. Phase `$0B` of either side is where the
 * lift lines up with a room, so the ride loop goes back to reading the
 * stick instead of taking another step.
 * @param {Object} m - The machine.
 * @returns {boolean} True when the lift has arrived somewhere.
 */
function elAtDoor(m) {
  return elLoad(m, EL_DOOR) === 0x0B || elLoad(m, EL_DOOR + 1) === 0x0B;
} // elAtDoor

/**
 * The tables `data/shaft.json` carries, put where the original has them.
 * The picture of the fortress and the grid are the shuffle's (§11), the
 * records of the rooms are `roomsLoader`'s — only these are static.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} shaft - The parsed `data/shaft.json`.
 */
function elSeedMemory(mem, shaft) {
  if (!shaft) { return; }
  var names = Object.keys(shaft.tables), i, j, t, at;
  for (i = 0; i < names.length; i++) {
    t = shaft.tables[names[i]];
    at = parseInt(t.addr.replace('$', ''), 16);
    for (j = 0; j < t.values.length; j++) { mem[at + j] = t.values[j] & 0xFF; }
  }
  for (i = 0; i < shaft.colorRows.rows.length; i++) {
    at = parseInt(shaft.colorRows.rows[i].replace('$', ''), 16);
    mem[EL_COLOUR_LO + i] = at & 0xFF;
    mem[EL_COLOUR_HI + i] = (at >> 8) & 0xFF;
  }
  for (i = 0; i < shaft.picture.rows.length; i++) {
    at = parseInt(shaft.picture.rows[i].replace('$', ''), 16);
    mem[EL_PICTURE + 2*i] = at & 0xFF;
    mem[EL_PICTURE + 2*i + 1] = (at >> 8) & 0xFF;
  }
} // elSeedMemory

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var elevator = {
  up: elUp, down: elDown, cabin: elCabin,
  toneDecay: elToneDecay, inCabin: elInCabin, atDoor: elAtDoor,
  seedMemory: elSeedMemory,
  scrollUp: elScrollUp, scrollDown: elScrollDown, colours: elColours,
  newRowUp: elNewRowUp, newRowDown: elNewRowDown,
  roomColour: elRoomColour, pictureByte: elPictureByte,
  gridIndex: elGridIndex, advance: elAdvance, markCabin: elMarkCabin,
  SCREEN: EL_SCREEN, ROW14: EL_ROW14
};
// ve workeru je `self` globál, takže tyhle řádky nic nemění; pod Node je každý
// klasický skript ve vlastní obálce a bez nich by ho sourozenci neviděli
if (typeof self !== 'undefined') {
  self.elevator = elevator;
  self.elUp = elUp;
  self.elDown = elDown;
  self.elCabin = elCabin;
  self.elToneDecay = elToneDecay;
  self.elInCabin = elInCabin;
  self.elAtDoor = elAtDoor;
  self.elGridIndex = elGridIndex;
  self.elScrollUp = elScrollUp;
  self.elNewRowDown = elNewRowDown;
  self.elAdvance = elAdvance;
  self.elSeedMemory = elSeedMemory;
  self.elMarkCabin = elMarkCabin;
  self.elPictureByte = elPictureByte;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = elevator; }
