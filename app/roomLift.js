// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The lift **inside a room** (`$AC81`, `sources/docs/disasm_notes.md` §23).
 *
 * ★ **This is not the furniture and not the shaft's lift.** A room can have
 * its own lifts — the columns of tiles the builder lays with `rbLiftTile`
 * (§12) — and `$AC81` is what asks, every single pass of the room loop
 * (`$728B`), whether the agent is standing at one of them. Only then does
 * the stick move him up or down instead of walking him.
 *
 * ★ It asks the room's **own record**, the one the builder drew the room
 * from, still pointed at by `$81` — and `$81` points at the **list of
 * lifts**, which sits in the record before the furniture (`$A4B9`). An entry
 * is a row, a column, how many stops the lift has, the rows of those stops,
 * and a byte with bit 7 set to close it; the list itself ends with a row
 * byte that has bit 7 set.
 *
 * ★ That is also why finding the row is a **subtraction loop** and not a
 * comparison (`$ACAF`, six rows a step): the stops of a lift are six
 * character rows apart, exactly as `rbUpSixRows` lays them.
 *
 * ★ And the entry says so twice over: the byte after the column is **how
 * many more platforms hang above the car**, six rows apart, and the builder
 * draws all of them (`$A4B9`, §12). A lift of Impossible Mission is not one
 * platform, it is a **column of them that moves as one** — which is why the
 * ride redraws every one of them on every half step, and why a remake that
 * moves only the one the agent stands on gets the room wrong.
 *
 * The ride itself (`$ACEB` up, `$AD7A` down) is §25. Three things about it
 * are worth knowing before reading it.
 *
 * 1. **A row is two frames**, like the shaft's lift (§20): the first frame
 *    draws the platforms half a row along (`$4C`-`$4E` over `$4F`-`$51`, two
 *    character rows), the second settles them on the row (`$49`-`$4B`) and
 *    blanks the one they left. The agent's three sprites go four pixels a
 *    frame, so eight a row.
 * 2. **One push is one stop.** `$83` goes up when a ride starts and only
 *    `$ACDB` — neither way asked for — puts it back, so holding the stick
 *    does nothing until it is let go. That is the opposite of the shaft,
 *    where letting go does not stop the lift.
 * 3. **The record is the state.** How far the car has come is the entry's
 *    own row byte and its index into the list of travels, both written back
 *    into the room's record — so a lift the agent leaves half way up is
 *    still there when he comes back.
 */

/** the agent's state: only standing (`$0E`) looks at the furniture at all */
var FN_STATE = 0x3F, FN_STANDING = 0x0E;

/** where the agent's feet are, in character rows and columns (`$AC90`, `$AC9B`) */
var FN_ROW_CELL = 0x52, FN_COL = 0x53;

/** the room's record at the list of lifts, where the builder left it (`$A4B9`) */
var FN_RECORD = 0x81;

/** the two latches the stick is read through, one a way (`$ACDB`, `$ACDF`) */
var FN_UP_LATCH = 0x83, FN_DOWN_LATCH = 0x85;

/** the joystick, port 2, active low (§7) */
var FN_JOY_UP = 0x01, FN_JOY_DOWN = 0x02;

/**
 * ★ The nine characters a platform is drawn out of (`$0DB4`, `$0DB7`,
 * `$0DBA`): three by three, and the three rows are **three phases of the
 * same platform**, not three parts of one. `$0DB4` is the platform sitting
 * on its row, `$0DBA` + `$0DB7` the same platform four pixels higher, split
 * over the two rows it then straddles. The builder only ever draws `$0DB4`
 * (`rbLiftTile`, §12); the ride is the only thing that uses the other two.
 */
var FN_TILE = 0x0DB4, FN_TILE_HALF_LOW = 0x0DBA, FN_TILE_HALF_HIGH = 0x0DB7;

/** the blank a room is filled with (`$A3B0`) — what a platform leaves behind */
var FN_BLANK = 0x53;

/** the colour the builder left for the lift's tiles (`$A4B9`) */
var FN_TILE_COLOR = 0x84;

/** the drawing position: screen in `$10`/`$11`, colour in `$14`/`$15` (`$AC1B`) */
var FN_PTR = 0x10, FN_COLOR_PTR = 0x14;

/** where the built room is (`$C100`) and where the shown one is (`$4000`, §6) */
var FN_BUILT = 0xC1, FN_SHOWN_OFFSET = 0x7F;

/** the scratch the ride carries its counts in (`$AD02`-`$AD21`) */
var FN_E4 = 0xE4, FN_E5 = 0xE5, FN_E6 = 0xE6;

/** how the agent died (`$43`) — the ride's own value is 3 (`$AD2E`) */
var FN_DEATH = 0x43, FN_DEATH_LIFT = 0x03;

/** the three sprites of the agent, in the VIC and in zero page (`$AEC5`) */
var FN_SPRITE_Y = 0xD003, FN_SPRITE_ZP = 0x002D;

/** how far the drawing position moves, and which routine of the original does it */
var FN_ROW = 40;                 // `$AF17` −1, `$AF2F` +1
var FN_FIVE_ROWS = 200;          // `$AF07` −5
var FN_SIX_ROWS = 240;           // `$AEEB` −6, `$AF1F` +6
var FN_SEVEN_ROWS = 280;         // `$AEFB` −7

function fnByte(v) { return v & 0xFF; }
function fnLoad(m, a) { return rbLoad(m, a); }
function fnStore(m, a, v) { rbStore(m, a, v); }

/**
 * `$AC81` — which lift of the room, if any, the agent is standing at.
 *
 * ★ Two things about the answer are worth knowing. It is computed from the
 * agent's **bottom and left edges**, not from his sprite position, so it
 * moves with his state like everything else does (§17); and asking costs
 * `$52` and `$53` **whether or not anything is found**, which is why they
 * change every pass the agent stands still.
 *
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give.
 * @returns {number} The index into the room's record where the lift's
 *   columns start, or -1 when the agent is not standing at a lift.
 */
function fnUnderAgent(m, joy) {
  if (fnLoad(m, FN_STATE) !== FN_STANDING) { return -1; }   // `$AC83`
  fnStore(m, FN_ROW_CELL, fnByte(plBottomEdge(m) - 0x32) >> 3);  // `$AC87`
  var edge = plLeftEdge(m);                                 // `$AC92`
  var a = fnByte((edge.c ? 0x80 : 0) | (edge.a >> 1));      // `ROR A`
  fnStore(m, FN_COL, fnByte(a - 0x0B) >> 2);

  var base = fnLoad(m, FN_RECORD) | (fnLoad(m, FN_RECORD + 1) << 8);
  var at = function (y) { return fnLoad(m, (base + fnByte(y)) & 0xFFFF); };
  var y = 0, x, row, matched;
  for (;;) {
    x = at(y + 2);                                          // `$ACA1`, kolik zastávek
    row = at(y);                                            // `$ACA6`
    if (row & 0x80) { return -1; }                          // konec seznamu
    // ★ `$ACAB` — zastávka se nehledá porovnáním, ale **odčítáním po šesti**:
    // tak daleko od sebe je stavitel klade (`rbUpSixRows`, §12)
    matched = false;
    for (;;) {
      if (row === fnLoad(m, FN_ROW_CELL)) { matched = true; break; }
      row = fnByte(row - 6);
      x = fnByte(x - 1);
      if (x & 0x80) { break; }
    }
    if (matched) {
      y = fnByte(y + 1);                                    // `$ACB7`
      var left = at(y);
      if (fnLoad(m, FN_COL) >= left
          && fnByte(left + 1) >= fnLoad(m, FN_COL)) {       // `$ACBE`, s přenosem
        return fnByte(y);                                   // `$ACCF` — nalezeno
      }
    }
    // `$ACC6` — přeskoč zbytek položky: až po bajt se sedmým bitem
    do { y = fnByte(y + 1); } while (!(at(y) & 0x80));
    y = fnByte(y + 1);
  }
} // fnUnderAgent

/* ------------------------------------------------------- the drawing position */

/**
 * `$AC1B` — a (row, column) pair out of the record turned into a place on
 * the screen and the matching place in colour memory, the way the builder
 * does it too (`rbCellAddress`): `$C100 + row*40 + column` and `$D800 +` the
 * same offset, with the multiplication done as `*8 + *32` and the overflow
 * left in `$E5`, because the code after it reads it.
 *
 * @param {Object} m - The machine.
 * @param {number} base - Where the room's record starts (`$81`).
 * @param {number} y - The offset of the row byte in the record.
 * @returns {number} The offset after the pair, as the original leaves `Y`.
 */
function fnCellAddress(m, base, y) {
  var mem = m.mem, a, hi = 0;
  fnStore(m, FN_E5, 0);
  a = fnLoad(m, (base + fnByte(y)) & 0xFFFF); y = fnByte(y + 1);
  a = (a << 3) & 0xFF;                                  // ASL A × 3
  fnStore(m, FN_E4, a);
  a <<= 1; hi = (hi << 1) | (a > 0xFF ? 1 : 0); a &= 0xFF;   // ASL A / ROL $E5
  a <<= 1; hi = (hi << 1) | (a > 0xFF ? 1 : 0); a &= 0xFF;   // ASL A / ROL $E5
  fnStore(m, FN_E5, hi);
  a += fnLoad(m, FN_E4);
  if (a > 0xFF) { a &= 0xFF; fnStore(m, FN_E5, fnByte(fnLoad(m, FN_E5) + 1)); }
  a += fnLoad(m, (base + fnByte(y)) & 0xFFFF);
  if (a > 0xFF) { a &= 0xFF; fnStore(m, FN_E5, fnByte(fnLoad(m, FN_E5) + 1)); }
  fnStore(m, FN_PTR, a); fnStore(m, FN_COLOR_PTR, a);
  fnStore(m, FN_PTR + 1, fnByte(fnLoad(m, FN_E5) + FN_BUILT));
  fnStore(m, FN_COLOR_PTR + 1, fnByte(fnLoad(m, FN_E5) + 0xD8));
  return y;
} // fnCellAddress

/**
 * The six routines `$AEEB`, `$AEFB`, `$AF07`, `$AF17`, `$AF1F` and `$AF2F`,
 * which are one routine six times over: move the screen pointer and the
 * colour pointer by the same number of characters. They are written as one
 * here and the call sites say which of the six they are.
 *
 * @param {Object} m - The machine.
 * @param {number} delta - How many characters, signed.
 */
function fnMovePtr(m, delta) {
  var screen = fnLoad(m, FN_PTR) | (fnLoad(m, FN_PTR + 1) << 8);
  var color = fnLoad(m, FN_COLOR_PTR) | (fnLoad(m, FN_COLOR_PTR + 1) << 8);
  screen = (screen + delta) & 0xFFFF; color = (color + delta) & 0xFFFF;
  fnStore(m, FN_PTR, screen & 0xFF); fnStore(m, FN_PTR + 1, screen >> 8);
  fnStore(m, FN_COLOR_PTR, color & 0xFF); fnStore(m, FN_COLOR_PTR + 1, color >> 8);
} // fnMovePtr

/** the three characters of a row of a platform, in the colour `$84` */
function fnPutRow(m, from) {
  var screen = fnLoad(m, FN_PTR) | (fnLoad(m, FN_PTR + 1) << 8);
  var color = fnLoad(m, FN_COLOR_PTR) | (fnLoad(m, FN_COLOR_PTR + 1) << 8);
  for (var y = 2; y >= 0; y--) {
    fnStore(m, (screen + y) & 0xFFFF, fnLoad(m, from + y));
    fnStore(m, (color + y) & 0xFFFF, fnLoad(m, FN_TILE_COLOR));
  }
} // fnPutRow

/**
 * `$AC61` — a platform **between two rows**: the low half where the pointer
 * is, the high half one row above it. ★ It leaves the pointer on the upper
 * of the two rows (`$AC6F JSR $AF17`), which is what makes the caller's
 * arithmetic come out.
 * @param {Object} m - The machine.
 */
function fnDrawHalf(m) {
  fnPutRow(m, FN_TILE_HALF_LOW);
  fnMovePtr(m, -FN_ROW);                                // `$AF17`
  fnPutRow(m, FN_TILE_HALF_HIGH);
} // fnDrawHalf

/** `$AC4E` — a platform sitting on its own row, pointer left where it was */
function fnDrawWhole(m) { fnPutRow(m, FN_TILE); }

/** the three blanks a platform leaves behind, at an offset from the pointer */
function fnBlank(m, at) {
  var screen = fnLoad(m, FN_PTR) | (fnLoad(m, FN_PTR + 1) << 8);
  for (var y = 2; y >= 0; y--) {
    fnStore(m, (screen + at + y) & 0xFFFF, FN_BLANK);
  }
} // fnBlank

/**
 * `$AEC5` and `$AED8` — the agent's three sprites, four pixels a frame, in
 * the VIC and in the copy of their positions zero page keeps.
 * @param {Object} m - The machine.
 * @param {number} delta - −4 going up, +4 going down.
 */
function fnMoveAgent(m, delta) {
  for (var y = 4; y >= 0; y -= 2) {
    var v = fnByte(fnLoad(m, FN_SPRITE_Y + y) + delta);
    fnStore(m, FN_SPRITE_Y + y, v);
    fnStore(m, FN_SPRITE_ZP + y, v);
  }
} // fnMoveAgent

/* ---------------------------------------------------------------- the ride */

/**
 * `$ACEB` — up one stop, everything the original does **before** it first
 * waits for a frame: the latch, the drawing position, the travel out of the
 * list, and the record written back.
 *
 * ★ The travel is not a row number, it is **how far to this stop from the
 * one below it**, and which one the car is at is the entry's own index byte
 * (`$AD0E`). A byte with bit 7 in its place is the top of the list, and then
 * `$AD07` gives up — through `$ACDB`, so both latches go down again.
 *
 * @param {Object} m - The machine.
 * @param {number} y - What `fnUnderAgent` found: the offset of the column byte.
 * @returns {Object|null} The ride, or null when the car is already at the top.
 */
function fnStartUp(m, y) {
  var base = fnLoad(m, FN_RECORD) | (fnLoad(m, FN_RECORD + 1) << 8);
  var at = function (o) { return fnLoad(m, (base + fnByte(o)) & 0xFFFF); };
  var put = function (o, v) { fnStore(m, (base + fnByte(o)) & 0xFFFF, v); };
  if (fnLoad(m, FN_UP_LATCH)) {                         // `$ACED`
    fnRelease(m, false);
    m.fnRefused = 'latched';
    return null;
  }
  fnStore(m, FN_UP_LATCH, fnByte(fnLoad(m, FN_UP_LATCH) + 1));
  y = fnCellAddress(m, base, fnByte(y - 1));            // `$ACF1` DEY, `$ACF2`
  // ★ `$ACF5` — `$11 + $7F` turns `$C1xx` into `$40xx`: the ride draws into
  // the screen the VIC **shows**, not into the buffer the room was built in
  fnStore(m, FN_PTR + 1, fnByte(fnLoad(m, FN_PTR + 1) + FN_SHOWN_OFFSET));
  y = fnByte(y + 2);                                    // `$ACFC` — the index
  var target = fnByte(y + at(y) + 1);                   // `$ACFE` TYA/SEC/ADC
  fnStore(m, FN_E4, y);
  var travel = at(target);
  if (travel & 0x80) {                                  // `$AD07` — už je nahoře
    fnRelease(m, true);
    m.fnRefused = 'top';
    return null;
  }
  fnStore(m, FN_E5, travel);
  y = fnLoad(m, FN_E4);
  put(y, fnByte(at(y) + 1));                            // `$AD0E` — o stop výš
  y = fnByte(y - 1);
  fnStore(m, FN_E6, at(y));                             // kolik plošin
  y = fnByte(y - 2);
  put(y, fnByte(at(y) - fnLoad(m, FN_E5)));             // `$AD1C` — nový řádek
  return {dir: 1, rows: travel, half: 1, tail: 0};
} // fnStartUp

/**
 * `$AD7A` — down one stop. ★ Mirror of the way up but for two things: the
 * index goes **down first and then reads** (`$AD94`), so a zero index means
 * the car is already at the bottom and the routine just returns — leaving
 * `$83` up, so the stick has to be let go either way — and `$85` goes to
 * `$FF` for the whole ride, which is what stops `$95BC` from killing the
 * agent while the platform carries him down.
 *
 * @param {Object} m - The machine.
 * @param {number} y - The offset of the column byte.
 * @returns {Object|null} The ride, or null when the car is already at the bottom.
 */
function fnStartDown(m, y) {
  var base = fnLoad(m, FN_RECORD) | (fnLoad(m, FN_RECORD + 1) << 8);
  var at = function (o) { return fnLoad(m, (base + fnByte(o)) & 0xFFFF); };
  var put = function (o, v) { fnStore(m, (base + fnByte(o)) & 0xFFFF, v); };
  if (fnLoad(m, FN_UP_LATCH)) { m.fnRefused = 'latched'; return null; }  // `$AD7C`
  fnStore(m, FN_UP_LATCH, fnByte(fnLoad(m, FN_UP_LATCH) + 1));
  y = fnCellAddress(m, base, fnByte(y - 1));            // `$AD81` DEY, `$AD82`
  fnStore(m, FN_PTR + 1, fnByte(fnLoad(m, FN_PTR + 1) + FN_SHOWN_OFFSET));
  fnStore(m, FN_E5, y);                                 // `$AD8C` STY $E5
  y = fnByte(y + 2);                                    // the index
  if (at(y) === 0) { m.fnRefused = 'bottom'; return null; }   // `$AD92` — už je dole
  put(y, fnByte(at(y) - 1));
  y = fnByte(y + at(y) + 1);                            // `$AD99`
  var travel = at(y);
  fnStore(m, FN_E4, travel);
  y = fnByte(fnLoad(m, FN_E5) - 1);
  put(y, fnByte(at(y) + fnLoad(m, FN_E4)));             // `$ADA6` — nový řádek
  y = fnByte(y + 2);
  fnStore(m, FN_E6, at(y));
  fnStore(m, FN_DOWN_LATCH, 0xFF);                      // `$ADB3`
  return {dir: -1, rows: travel, half: 1, tail: 0};
} // fnStartDown

/**
 * `$ACDB` and `$ACDF` — the two latches, and the death the original checks
 * on the way out of both (`$ACE3`).
 * @param {Object} m - The machine.
 * @param {boolean} both - True for `$ACDB`, which drops the up latch too.
 */
function fnRelease(m, both) {
  if (both) { fnStore(m, FN_UP_LATCH, 0); }
  fnStore(m, FN_DOWN_LATCH, 0);
} // fnRelease

/**
 * One frame of a ride. ★ A row of travel is **two frames**, and the two are
 * not the same: the first draws every platform of the column half a row
 * along and the second settles it, which is what makes four pixels a frame
 * look like a platform moving rather than jumping.
 *
 * ★ Both halves walk the whole column — `$E6 + 1` platforms, six rows apart
 * — and then walk back, which is why the pointer ends each frame exactly one
 * row from where it began. And ★ the death the ride checks is checked **once
 * a row**, at the top of the first half (`$AD2A`, `$ADBE`), and it overwrites
 * whatever killed the agent with a 3.
 *
 * @param {Object} m - The machine.
 * @param {Object} ride - What `fnStartUp` or `fnStartDown` returned.
 * @returns {{done: number, died: number}} Whether the ride is over, and
 *   whether it ended because the agent died.
 */
function fnRideFrame(m, ride) {
  var count = fnLoad(m, FN_E6);
  // ★ `$AE14` — jen jízda dolů se na konci ještě **dva snímky nedělá nic**
  // (`LDA #$02 JSR $7F6D`), a teprve pak pustí `$85`
  if (ride.tail) {
    ride.tail--;
    if (ride.tail) { return {done: 0, died: 0}; }
    fnStore(m, FN_DOWN_LATCH, 0);                       // `$AE19` STX $85
    return {done: 1, died: 0};
  }

  if (ride.half === 1) {
    fnStore(m, FN_E5, count);
    if (fnLoad(m, FN_DEATH)) {                          // `$AD2A` / `$ADBE`
      fnStore(m, FN_DEATH, FN_DEATH_LIFT);
      return {done: 1, died: FN_DEATH_LIFT};
    }
    if (ride.dir < 0) { fnMovePtr(m, FN_ROW); }         // `$ADC9 JSR $AF2F`
    do {
      fnDrawHalf(m);                                    // `$AC61`
      fnMovePtr(m, -FN_FIVE_ROWS);                      // `$AF07`
      fnStore(m, FN_E5, fnByte(fnLoad(m, FN_E5) - 1));  // `$AD3B` DEC / BPL
    } while (!(fnLoad(m, FN_E5) & 0x80));
    fnRewind(m, count);
    fnMovePtr(m, -FN_ROW);                              // `$AF17`
    fnMoveAgent(m, ride.dir > 0 ? -4 : 4);              // `$AEC5` / `$AED8`
    ride.half = 2;
    return {done: 0, died: 0};
  }

  // ★ `$E5` je na vrcholu druhé půlky **pořád `$E6`**: první půlka ho
  // odpočítala do `$FF` a návrat (`fnRewind`) ho zvedl zpátky
  do {
    if (ride.dir > 0) {
      fnDrawWhole(m);                                   // `$AD53 JSR $AC4E`
      fnBlank(m, FN_ROW);                               // `$AD56` — řádek pod ní
      fnMovePtr(m, -FN_SIX_ROWS);                       // `$AEEB`
    } else {
      fnBlank(m, 0);                                    // `$ADEA` — řádek nad ní
      fnMovePtr(m, FN_ROW);                             // `$AF2F`
      fnDrawWhole(m);                                   // `$AC4E`
      fnMovePtr(m, -FN_SEVEN_ROWS);                     // `$AEFB`
    }
    fnStore(m, FN_E5, fnByte(fnLoad(m, FN_E5) - 1));    // `$AD64` / `$ADFC`
  } while (!(fnLoad(m, FN_E5) & 0x80));
  fnRewind(m, count);
  if (ride.dir < 0) { fnMovePtr(m, FN_ROW); }           // `$AE0B JSR $AF2F`
  fnMoveAgent(m, ride.dir > 0 ? -4 : 4);
  ride.half = 1;
  ride.rows = fnByte(ride.rows - 1);                    // `$AD76` / `$AE11` DEX
  if (ride.rows) { return {done: 0, died: 0}; }
  if (ride.dir < 0) { ride.tail = 2; return {done: 0, died: 0}; }
  return {done: 1, died: 0};
} // fnRideFrame

/**
 * `$AD3F`, `$AD68`, `$ADD6` and `$AE00` — the walk back. The original counts
 * `$E5` up from `$FF` to `$E6` and adds six rows a turn, so the pointer ends
 * where the drawing started and `$E5` ends at `$E6`. Both of those are
 * compared, so both are done.
 * @param {Object} m - The machine.
 * @param {number} count - `$E6`.
 */
function fnRewind(m, count) {
  do {
    fnMovePtr(m, FN_SIX_ROWS);                          // `$AF1F`
    fnStore(m, FN_E5, fnByte(fnLoad(m, FN_E5) + 1));
  } while (fnLoad(m, FN_E5) !== count);
} // fnRewind

/**
 * `$728B` — the room loop's fifth step, whole: find the lift the agent is
 * standing at, and let the stick ride it.
 *
 * ★ Once a ride starts the original **does not come back here** until it is
 * over: `$ACEB` and `$AD7A` wait for frames of their own, so the loop stands
 * still and neither the agent's step nor the floor check (`$728E`) runs.
 * Only the interrupt keeps going — which is why the robots do keep patrolling
 * while the agent is carried (§5).
 *
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give.
 * @returns {Object} `{at, wants, ride}` — where the lift is in the record,
 *   which way the stick is pushed at it (1 up, −1 down, 0 neither), and the
 *   ride it started, if it started one.
 */
function fnStep(m, joy) {
  // ★ Proč se nerozjel, se **pamatuje**: bez toho by nula u `matchroomlift`
  // neřekla, jestli se kdy vyzkoušel strop (`$AD07`), dno (`$AD92`) nebo
  // držená páka (`$ACED`, `$AD7C`) — a to jsou tři čtvrtiny rozhodování.
  m.fnRefused = 0;
  var found = fnUnderAgent(m, joy);
  if (found < 0) { return {at: -1, wants: 0, ride: null, refused: 0}; }
  if (!(joy & FN_JOY_UP)) {                                    // `$ACD3`
    return {at: found, wants: 1, ride: fnStartUp(m, found), refused: m.fnRefused};
  }
  if (!(joy & FN_JOY_DOWN)) {                                  // `$ACD6`
    return {at: found, wants: -1, ride: fnStartDown(m, found), refused: m.fnRefused};
  }
  fnRelease(m, true);                                          // `$ACDB`
  return {at: found, wants: 0, ride: null, refused: 0};
} // fnStep

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var roomLift = {
  under: fnUnderAgent, step: fnStep, rideFrame: fnRideFrame,
  cellAddress: fnCellAddress, movePointer: fnMovePtr,
  ROW: FN_ROW_CELL, COL: FN_COL, RECORD: FN_RECORD, SIX_ROWS: FN_SIX_ROWS
};
if (typeof self !== 'undefined') {
  self.roomLift = roomLift;
  self.fnStep = fnStep;
  self.fnRideFrame = fnRideFrame;
  self.fnUnderAgent = fnUnderAgent;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = roomLift; }
