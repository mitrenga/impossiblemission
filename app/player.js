// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The agent. Not an animation of one — **the original's own step**,
 * transcribed the way the two generators and the room builder before it
 * were (`sources/docs/disasm_notes.md` §19).
 *
 * The whole of what the game knows about the agent lives in zero page, so
 * this file works on the machine's memory for the same reason
 * `roomBuild.js` does: run it on the memory the original had at the start
 * of a frame and every byte it writes has to come out the same
 * (`tools/matchplayer.mjs` against `tools/traceplayer.py`).
 *
 * Three things are worth knowing before reading it.
 *
 * 1. **One pass = one frame.** Both loops of the game (`$7249` in a room,
 *    `$3A15` in the shaft) open with `JSR $7F6B`, which waits for `$E0`,
 *    the frame counter the raster interrupt raises once a frame. So the
 *    frame is the unit, exactly as the worker ticks it (R-038).
 * 2. **The agent walks every third frame.** `$3E` counts frames, `$40` is
 *    3, and `$86F3` lets the step through only when `$3E >= $40` (§17).
 *    Everything else — the clock, falling, the interrupt's own work —
 *    happens every frame.
 * 3. **The agent is three sprites**, `$2C`/`$2D`, `$2E`/`$2F`, `$30`/`$31`,
 *    and the ninth bit of all three x's sits in `$32`. That is why every
 *    move goes through one of four helpers (`$8AEF`, `$8B21`, `$8B51`,
 *    `$8B5F`): they move all three and keep the ninth bits right.
 */

/** where the agent is: 0 shaft, 1 room, 2 room being built (§19) */
var PL_PLACE = 0x1A;
/** which room the agent is in (`$7E`) — the two code rooms are `$11` a `$1B` (§35) */
var PL_ROOM = 0x7E;
// ★ **Pozor na jména**: `PL_TOP`/`PL_BOTTOM` jsou **hrany agenta** (`$3D`,
// `$3C`), ne konce šachty. Strop a dno šachty jsou `$1D` a `$1E` a jmenují
// se jinak — jinak je druhá deklarace tiše přebije (stálo to jeden běh).
var PL_CEILING = 0x1D, PL_SHAFT_FLOOR = 0x1E;

/** the three sprites, x and y alternating, and the ninth bits of the x's */
var PL_SPRITES = 0x2C, PL_MSIGX = 0x32;

/** the walk: how far a step is (`$8808`) and which way the agent faces */
var PL_STEP = 0x39, PL_FACING = 0x50;

/** last frame's edges: left/2, right/2, bottom, top (`$86FC`-`$8714`) */
var PL_LEFT = 0x3A, PL_RIGHT = 0x3B, PL_BOTTOM = 0x3C, PL_TOP = 0x3D;

/** this frame's edges, and the middles between them (`$893F`) */
var PL_NEW_TOP = 0x33, PL_NEW_BOTTOM = 0x34, PL_NEW_LEFT = 0x35,
    PL_NEW_RIGHT = 0x36, PL_MID_Y = 0x37, PL_MID_X = 0x38;

/** the frame counter of the interrupt, the tick and how many ticks a step is */
var PL_FRAME = 0xE0, PL_TICK = 0x3E, PL_DIVIDER = 0x40;

/** state (`$00`-`$0D` walk, `$0E` standing, `$0F` searching, `$10`-`$1B` somersault) */
var PL_STATE = 0x3F;

/** falling, landed, and how the agent died (`$43`: 1 robot, 2 fall, $FF time) */
var PL_FALL = 0x41, PL_LANDED = 0x42, PL_DEATH = 0x43;

/** the somersault the stick asked for, and the button's edge latch */
var PL_JUMP = 0x51, PL_LATCH = 0xDE;

/** the clock: frames, seconds, minutes, hours (BCD), and what stops it */
var PL_CLOCK_FRAMES = 0xD1, PL_SECONDS = 0xD2, PL_MINUTES = 0xD3,
    PL_HOURS = 0xD4, PL_CLOCK_STOP = 0xD5, PL_HOUR_BELL = 0xC1;

/** scratch the original uses and a comparison therefore covers */
var PL_SCRATCH = 0x79;           // $79-$7D: the ninth bit and the cell pointer
var PL_E4 = 0xE4;                // $E4-$E8: distances while resolving a move

/** the screen the collision asks: bank 1, `$4000` (§6) */
var PL_SCREEN = 0x4000;

/** the somersault's five tables, twelve entries each (`$8D05`, §17) */
var PL_SOM_Y1 = 0x8D05, PL_SOM_Y2 = 0x8D11, PL_SOM_Y3 = 0x8D1D,
    PL_SOM_X12 = 0x8D29, PL_SOM_X3 = 0x8D35;

/** the seven state tables, 28 entries each (`$8D41`, §17) */
var PL_PTR_BASE = 0x8D41, PL_PTR_ADDR = 0x8D5D, PL_MIRROR_COUNT = 0x8D95,
    PL_EDGE_TOP = 0x8DB1, PL_EDGE_BOTTOM = 0x8DCD, PL_EDGE_LEFT = 0x8DE9,
    PL_EDGE_RIGHT = 0x8E05;

/** the table of reversed bits the mirroring uses (`$3335` builds it, §1) */
var PL_FLIP = 0xC500;

/** the orb's flag and the list of pieces found so far (`$39BF`, `$39C1`) */
var PL_ORB = 0x6D, PL_FOUND = 0x4EF5;

/** where the sprite pointers of the agent's three sprites live (`$8749`) */
var PL_POINTERS = 0x43F9;

/**
 * ★ What the agent arrives in a room with (`$970E`, run once by the game's
 * own start-up at `$397F`): three sprite pointers and **three colours**,
 * `$01`/`$0B`/`$0B` — white and twice dark grey. The room builder does not
 * set them, so a remake that leaves them out draws the agent **black**.
 * The six bytes ride in `data/global.json`.
 */
var PL_DEFAULTS = 0x9708, PL_SPRITE_COLORS = 0xD028;

/** `$A35E` — which sprites the room turns on: its record's last byte, `$8E` */
var PL_SPENA = 0xD015, PL_ROOM_ENABLE = 0x8E;

/** the colour of the split, `$8D` — and in a room that is its background */
var PL_SPLIT_COLOUR = 0x8D;
/**
 * ★ Vektor přerušení a jeho dvě obsluhy: `$82E7` je ta herní (rastrové
 * clony, hodiny, roboti), `$838C` jen potvrdí rastr a zvedne `$E0` — běží
 * za úvodní řečí (`$391E`) a od `$AB23` v řídicí místnosti (§35). Model
 * z něj pozná, jestli se obraz dělí na pruhy.
 */
var PL_IRQ_VECTOR = 0xFFFE, PL_IRQ_GAME = 0x82E7, PL_IRQ_PLAIN = 0x838C;

/** the cabin's two colours (`$399B`) and where the agent's three sprites start */
var PL_CAB_COLOUR = 0x21, PL_CAB_MULTI = 0x22, PL_START_Y = 0x4EF0;

/** the byte the original modifies inside its own code while moving (`$8AEF`) */
var PL_CARRIES_SUB = 0x8AEE, PL_CARRIES_ADD = 0x8B20;

/** the joystick, port 2, active low (§7) */
var PL_JOY_UP = 0x01, PL_JOY_DOWN = 0x02, PL_JOY_LEFT = 0x04,
    PL_JOY_RIGHT = 0x08, PL_JOY_FIRE = 0x10;

function plByte(v) { return v & 0xFF; }
function plLoad(m, a) { return rbLoad(m, a); }
function plStore(m, a, v) { rbStore(m, a, v); }
function plSetWord(m, a, v) { plStore(m, a, v & 0xFF); plStore(m, a + 1, (v >> 8) & 0xFF); }

/* ------------------------------------------------------------------ edges */

/**
 * The agent's top edge, `$8C46`. Never above `$33` — the ceiling of the
 * playing field (`$8C4E`).
 * @param {Object} m - The machine.
 * @returns {number} Sprite y of the top edge.
 */
function plTopEdge(m) {
  var y = plLoad(m, PL_STATE);
  var a = plByte(plLoad(m, PL_EDGE_TOP + y) + plLoad(m, PL_SPRITES + 1));
  return a < 0x33 ? 0x33 : a;
} // plTopEdge

/**
 * The agent's bottom edge, `$8C55`.
 * @param {Object} m - The machine.
 * @returns {number} Sprite y of the bottom edge.
 */
function plBottomEdge(m) {
  var y = plLoad(m, PL_STATE);
  return plByte(plLoad(m, PL_EDGE_BOTTOM + y) + plLoad(m, PL_SPRITES + 1));
} // plBottomEdge

/**
 * `LSR $79` and the carry it puts out — the ninth bit of x on its way back
 * to the caller (`$8C79`).
 * @param {Object} m - The machine.
 * @param {number} sum - The low byte the edge routine computed.
 * @returns {{a: number, c: number}} The low byte and the ninth bit.
 */
function plShiftNinth(m, sum) {
  var v = plLoad(m, PL_SCRATCH);
  plStore(m, PL_SCRATCH, v >> 1);
  return {a: plByte(sum), c: v & 1};
} // plShiftNinth

/**
 * The agent's left edge, `$8C5E` — nine bits, so it comes back as a byte
 * and a carry. ★ Facing left it reads the left table, facing right it reads
 * **`$17` minus the right table**: the edges mirror with the agent, the same
 * way the sprite blocks do (§13, §17).
 * @param {Object} m - The machine.
 * @returns {{a: number, c: number}} Twice the pixel x, and its ninth bit.
 */
function plLeftEdge(m) {
  plStore(m, PL_SCRATCH, (plLoad(m, PL_MSIGX) & 0x02) >> 1);
  var y = plLoad(m, PL_STATE), x = plLoad(m, PL_SPRITES), a, sum;
  if (plLoad(m, PL_FACING) & 0x80) {
    a = plLoad(m, PL_EDGE_LEFT + y);
    sum = a + x;
    if (a & 0x80) {                                   // `$8C6E` záporný posun
      if (sum <= 0xFF) { plStore(m, PL_SCRATCH, 0); } // podtekl → devátý bit 0
      return plShiftNinth(m, sum);
    }
    if (sum > 0xFF) { return {a: plByte(sum), c: 1}; }
    return plShiftNinth(m, sum);
  }
  a = plByte(0x17 - plLoad(m, PL_EDGE_RIGHT + y));
  sum = a + x;
  if (sum > 0xFF) { plStore(m, PL_SCRATCH, 1); }
  return plShiftNinth(m, sum);
} // plLeftEdge

/**
 * The agent's right edge, `$8C95` — mirrored the same way.
 * @param {Object} m - The machine.
 * @returns {{a: number, c: number}} Twice the pixel x, and its ninth bit.
 */
function plRightEdge(m) {
  plStore(m, PL_SCRATCH, (plLoad(m, PL_MSIGX) & 0x02) >> 1);
  var y = plLoad(m, PL_STATE), x = plLoad(m, PL_SPRITES), a, sum;
  if (plLoad(m, PL_FACING) & 0x80) {
    a = plLoad(m, PL_EDGE_RIGHT + y);
  } else {
    a = plByte(0x17 - plLoad(m, PL_EDGE_LEFT + y));
  }
  sum = a + x;
  if (sum > 0xFF) { plStore(m, PL_SCRATCH, 1); }
  return plShiftNinth(m, sum);
} // plRightEdge

/* --------------------------------------------------------------- the floor */

/**
 * The one question the game asks the background, `$8CC3`: **what character
 * is at this point of the screen, and is it solid?**
 *
 * ★ Solid is `$45`-`$51`; `$53` is the blank the builder fills a room with
 * (`$A3B0`). The point comes in as a nine-bit x in *doubled* pixels (the
 * screen is multicolour) and a sprite y, and the conversion is the one
 * every part of the movement shares:
 *
 *     column = (pixel x − 24) / 8,  row = (sprite y − 50) / 8
 *
 * @param {Object} m - The machine.
 * @param {number} x - Twice the pixel x, low byte.
 * @param {number} y - Sprite y.
 * @param {number} carry - The ninth bit of x.
 * @returns {{a: number, c: number}} What the routine leaves in A, and
 *   whether the cell is solid.
 */
function plCell(m, x, y, carry) {
  plStore(m, 0x7B, 0);
  // ★ `$8CC3` nechává v `Y` **sloupec**, na který se ptalo (`$8CF1 TAY`), a
  // `$9296` z něj skládá adresu buňky (§27) — takže se vrací taky. Když se
  // rutina vrátí dřív, `Y` zůstane, s čím přišla.
  var yOut = plByte(y);
  var a = plByte(y) - 0x32;
  if (a < 0) { return {a: plByte(a), c: 0, y: yOut}; }
  a &= 0xF8;
  plStore(m, 0x7A, a);
  var wide = a * 4;                            // dvakrát ASL A / ROL $7B
  plStore(m, 0x7B, (wide >> 8) & 0xFF);
  var sum = (wide & 0xFF) + a;                 // ADC $7A → řádek * 40
  if (sum > 0xFF) { plStore(m, 0x7B, plByte(plLoad(m, 0x7B) + 1)); }
  plStore(m, 0x7C, plByte(sum));
  plStore(m, 0x7D, plByte(plLoad(m, 0x7B) + (PL_SCREEN >> 8)));
  var shifted = ((carry ? 0x80 : 0) | (plByte(x) >> 1));   // ROR A
  var off = shifted - 0x0C;
  if (off < 0) { return {a: plByte(off), c: 0, y: yOut}; }
  var column = off >> 2;
  yOut = column;                                         // `$8CF1 TAY`
  if (column >= 0x28) { return {a: column, c: 0, y: yOut}; }
  var ch = plLoad(m, ((plLoad(m, 0x7D) << 8) | plLoad(m, 0x7C)) + column);
  return {a: ch, c: (ch >= 0x45 && ch < 0x52) ? 1 : 0, y: yOut};
} // plCell

/* ------------------------------------------------- moving all three sprites */

/**
 * `$8AEF` — take `$E4` off the x of all three sprites and fix the ninth bits.
 * @param {Object} m - The machine.
 */
function plSubX(m) {
  var carries = 0, x, v;
  for (x = 4; x >= 0; x -= 2) {
    v = plLoad(m, PL_SPRITES + x) - plLoad(m, PL_E4);
    plStore(m, PL_SPRITES + x, plByte(v));
    carries = plByte((carries << 1) | (v >= 0 ? 1 : 0));
  }
  plStore(m, PL_CARRIES_SUB, carries);
  var msigx = plLoad(m, PL_MSIGX), mask;
  for (mask = 0x02; mask <= 0x08; mask <<= 1) {
    if (!(carries & 1)) { msigx &= plByte(~mask); }
    carries >>= 1;
  }
  plStore(m, PL_CARRIES_SUB, carries);
  plStore(m, PL_MSIGX, msigx);
} // plSubX

/**
 * `$8B21` — add `delta` to the x of all three sprites and fix the ninth bits.
 * @param {Object} m - The machine.
 * @param {number} delta - What the Y register carried in.
 */
function plAddX(m, delta) {
  var carries = 0, x, v;
  for (x = 4; x >= 0; x -= 2) {
    v = plByte(delta) + plLoad(m, PL_SPRITES + x);
    plStore(m, PL_SPRITES + x, plByte(v));
    carries = plByte((carries << 1) | (v > 0xFF ? 1 : 0));
  }
  plStore(m, PL_CARRIES_ADD, carries);
  var msigx = plLoad(m, PL_MSIGX), mask;
  for (mask = 0x02; mask <= 0x08; mask <<= 1) {
    if (carries & 1) { msigx |= mask; }
    carries >>= 1;
  }
  plStore(m, PL_CARRIES_ADD, carries);
  plStore(m, PL_MSIGX, msigx);
} // plAddX

/**
 * `$8B51` — take `$E4` off the y of all three sprites.
 * @param {Object} m - The machine.
 */
function plSubY(m) {
  for (var x = 4; x >= 0; x -= 2) {
    plStore(m, PL_SPRITES + 1 + x, plByte(plLoad(m, PL_SPRITES + 1 + x) - plLoad(m, PL_E4)));
  }
} // plSubY

/**
 * `$8B5F` — add `delta` to the y of all three sprites.
 * @param {Object} m - The machine.
 * @param {number} delta - What the Y register carried in.
 */
function plAddY(m, delta) {
  for (var x = 4; x >= 0; x -= 2) {
    plStore(m, PL_SPRITES + 1 + x, plByte(plLoad(m, PL_SPRITES + 1 + x) + plByte(delta)));
  }
} // plAddY

/* ---------------------------------------------------------------- the stick */

/**
 * `$87EB` — left and right off the stick. ★ Nothing pressed puts the agent
 * into **standing** (`$0E`) and the step to zero; a step is **five pixels**
 * either way (`$8808`/`$880E`).
 * @param {Object} m - The machine.
 * @param {number} joy - The byte the game would read from `$DC00`.
 */
function plReadStick(m, joy) {
  if (plLoad(m, PL_STATE) >= 0x10) { return; }
  var sides = joy & (PL_JOY_LEFT | PL_JOY_RIGHT);
  if (sides === (PL_JOY_LEFT | PL_JOY_RIGHT)) {
    plStore(m, PL_STATE, 0x0E);
    plStore(m, PL_STEP, 0x00);
    return;
  }
  if (sides & PL_JOY_LEFT) {                 // ★ vlevo má přednost (bit 2)
    plStore(m, PL_FACING, 0x01);
    plStore(m, PL_STEP, 0x05);
  } else {
    plStore(m, PL_FACING, 0x80);
    plStore(m, PL_STEP, 0xFB);
  }
} // plReadStick

/* ----------------------------------------------------------------- the move */

/**
 * `$8857` — the step itself. Walking moves the three sprites sideways by
 * `$39`; the somersault is twelve frames out of the five tables (§17), and
 * ★ each sprite's ninth bit is **toggled** on its own carry, which is why
 * the original modifies the two branches in its own code.
 * @param {Object} m - The machine.
 */
function plMove(m) {
  var state = plLoad(m, PL_STATE);
  if (state < 0x10) {
    var step = plLoad(m, PL_STEP), carry = 0, x, v;
    for (x = 4; x >= 0; x -= 2) {
      v = step + plLoad(m, PL_SPRITES + x);
      plStore(m, PL_SPRITES + x, plByte(v));
      carry = v > 0xFF ? 1 : 0;
    }
    var msigx = plLoad(m, PL_MSIGX);
    if (step & 0x80) {                       // doleva
      if (!carry) { msigx &= 0xF1; }
    } else if (carry) {
      msigx |= 0x0E;
    }
    plStore(m, PL_MSIGX, msigx);
    return;
  }

  var i = state - 0x10, facing = plLoad(m, PL_FACING) & 0x80, delta, sum;
  plStore(m, PL_SPRITES + 1,
          plByte(plLoad(m, PL_SPRITES + 1) + plLoad(m, PL_SOM_Y1 + i)));
  plStore(m, PL_SPRITES + 3,
          plByte(plLoad(m, PL_SPRITES + 3) + plLoad(m, PL_SOM_Y2 + i)));
  plStore(m, PL_SPRITES + 5,
          plByte(plLoad(m, PL_SPRITES + 5) + plLoad(m, PL_SOM_Y3 + i)));

  delta = plLoad(m, PL_SOM_X3 + i);
  if (facing) { delta = plByte(-delta); }
  sum = delta + plLoad(m, PL_SPRITES + 4);
  plStore(m, PL_SPRITES + 4, plByte(sum));
  // ★ `$88AC` si do svého kódu uloží BCC nebo BCS podle znaménka posunu:
  // devátý bit se překlápí, když posun přeteče na svou stranu
  if ((delta & 0x80) ? !(sum > 0xFF) : (sum > 0xFF)) {
    plStore(m, PL_MSIGX, plLoad(m, PL_MSIGX) ^ 0x08);
  }

  delta = plLoad(m, PL_SOM_X12 + i);
  if (facing) { delta = plByte(-delta); }
  sum = delta + plLoad(m, PL_SPRITES);
  plStore(m, PL_SPRITES, plByte(sum));
  if ((delta & 0x80) ? !(sum > 0xFF) : (sum > 0xFF)) {
    plStore(m, PL_MSIGX, plLoad(m, PL_MSIGX) ^ 0x02);
  }
  sum = delta + plLoad(m, PL_SPRITES + 2);
  plStore(m, PL_SPRITES + 2, plByte(sum));
  if ((delta & 0x80) ? !(sum > 0xFF) : (sum > 0xFF)) {
    plStore(m, PL_MSIGX, plLoad(m, PL_MSIGX) ^ 0x04);
  }
  // ★ `$88F1`-`$88F3` — a **každý snímek salta hlas 3 znovu utne**, ne jen
  // ten, ve kterém salto začalo (`$8829`, `plAnimate`). `$8E77` se na stavy
  // `$10`-`$1B` neptá, takže bez tohohle by agent ve vzduchu šoupal nohama
  // (M6, `app/sound.js`).
  sndStore(m, 0xD412, 0x80);                             // `$88F3`
} // plMove

/**
 * `$8815` — which frame of which animation the agent is on. ★ The
 * somersault is asked for in `$51` (the button sets it, `$7279`/`$3A55`)
 * and starts at `$1B`; `$8842` counts it back down to `$10` and lands the
 * agent standing or walking, whichever the stick says.
 * @param {Object} m - The machine.
 * @param {number} joy - The byte the game would read from `$DC00`.
 */
function plAnimate(m, joy) {
  var y = plLoad(m, PL_STATE);
  if (y < 0x10) {
    if (plLoad(m, PL_JUMP)) {
      plStore(m, PL_JUMP, 0);
      plStore(m, PL_STATE, 0x1B);
      // ★ `$8827`-`$8829` — **salto krok utne**: hlas 3 pustí hradlo, takže
      // agent ve vzduchu nedupe. `$8E77` se na stav `$1B` neptá, tenhle
      // zápis tedy nemá kdo udělat za něj (M6, `app/sound.js`).
      sndStore(m, 0xD412, 0x80);                           // `$8829`
      return;
    }
    if (y === 0x0E) {
      if (plLoad(m, PL_STEP)) { plStore(m, PL_STATE, 0x0D); }
      return;
    }
    plStore(m, PL_STATE, y === 0 ? 0x0D : y - 1);
    return;
  }
  y -= 1;
  if (y < 0x10) {
    y = (joy & (PL_JOY_LEFT | PL_JOY_RIGHT)) === (PL_JOY_LEFT | PL_JOY_RIGHT)
      ? 0x0E : 0x0D;
  }
  plStore(m, PL_STATE, y);
} // plAnimate

/* ------------------------------------------------ keeping inside the world */

/**
 * `$8AA8` and `$8ACB` — is the cell beside the agent solid? Asked twice,
 * once at the middle of the agent and once eight pixels higher, so a wall
 * stops him whether it is at foot or head height. ★ In the middle of a
 * somersault (`$14`-`$18`) only the lower one counts.
 * @param {Object} m - The machine.
 * @param {number} at - Zero page byte holding half the x to test.
 * @returns {number} 1 when something is in the way.
 */
function plSideBlocked(m, at) {
  var x = plLoad(m, at) * 2, hit = plCell(m, x & 0xFF, plLoad(m, PL_MID_Y), x > 0xFF ? 1 : 0);
  if (hit.c) { return 1; }
  var state = plLoad(m, PL_STATE);
  if (state >= 0x14 && state < 0x19) { return 0; }
  hit = plCell(m, x & 0xFF, plByte(plLoad(m, PL_MID_Y) - 8), x > 0xFF ? 1 : 0);
  return hit.c;
} // plSideBlocked

/**
 * `$8CC3` at the middle of the agent, with the ninth bit the way `$8A15`
 * builds it (`SEC` then `ROL`, so the low bit is one).
 * @param {Object} m - The machine.
 * @param {number} y - Sprite y to test at.
 * @returns {number} 1 when the cell is solid.
 */
function plMidBlocked(m, y) {
  var x = plLoad(m, PL_MID_X) * 2 + 1;
  return plCell(m, x & 0xFF, y, x > 0xFF ? 1 : 0).c;
} // plMidBlocked

/**
 * `$88F7` — what the world does to the move that just happened.
 *
 * ★ In the shaft (`$1A = 0`) it is only a clamp: the agent may not walk
 * past `$C7` on the right or `$A8` on the left unless the lift is level
 * with a doorway (`$1F`/`$20` = `$0B`). **In a room** (`$893F`) it is the
 * real thing: the agent is walked from where he was to where he wants to
 * be, four or eight pixels at a time, and put back the moment a cell is
 * solid.
 * @param {Object} m - The machine.
 */
function plResolve(m) {
  if (plLoad(m, PL_PLACE)) { return plResolveRoom(m); }
  var edge, over, x;
  if (!(plLoad(m, PL_FACING) & 0x80)) {
    if (plLoad(m, 0x1F) === 0x0B) { return; }
    edge = plRightEdge(m);
    over = plByte(edge.a) - 0xC7;
    if (over < 0) { return; }
    plStore(m, PL_E4, over);
    for (x = 4; x >= 0; x -= 2) {
      plStore(m, PL_SPRITES + x, plByte(plLoad(m, PL_SPRITES + x) - over));
    }
    return;
  }
  if (plLoad(m, 0x20) === 0x0B) { return; }
  edge = plLeftEdge(m);
  if (edge.c) { return; }
  over = plByte(edge.a) - 0xA8;
  if (over >= 0) { return; }
  // ★ `$892D EOR #$FF` + `$892F ADC #$00` je **jedničkový** doplněk, ne
  // dvojkový: carry je v tu chvíli nulová (šlo se sem přes `BCC`), takže
  // se nepřičte. A `$8932` **nechá carry běžet mezi sprajty** — jeden CLC
  // na tři sčítání. Obojí se přepisuje tak, jak to je.
  var delta = plByte(~plByte(over)), carry = 0, v;
  for (x = 4; x >= 0; x -= 2) {
    v = delta + plLoad(m, PL_SPRITES + x) + carry;
    plStore(m, PL_SPRITES + x, plByte(v));
    carry = v > 0xFF ? 1 : 0;
  }
} // plResolve

/**
 * `$893F` — the collision of a room, four blocks of the same shape: work
 * out the new edges, then walk each of the four directions from the old
 * edge to the new one and stop at the first solid cell.
 * @param {Object} m - The machine.
 */
function plResolveRoom(m) {
  var a, edge, steps, rest;
  plStore(m, PL_NEW_TOP, plTopEdge(m));
  plStore(m, PL_NEW_BOTTOM, plByte(plBottomEdge(m) - 2));
  a = plByte(plLoad(m, PL_NEW_BOTTOM) - plLoad(m, PL_NEW_TOP)) >> 1;
  plStore(m, PL_MID_Y, plByte(a + plLoad(m, PL_NEW_TOP)));
  edge = plLeftEdge(m);
  plStore(m, PL_NEW_LEFT, plByte(((edge.c ? 0x80 : 0) | (edge.a >> 1))));
  edge = plRightEdge(m);
  plStore(m, PL_NEW_RIGHT, plByte(((edge.c ? 0x80 : 0) | (edge.a >> 1))));
  a = plByte(plLoad(m, PL_NEW_RIGHT) - plLoad(m, PL_NEW_LEFT)) >> 1;
  plStore(m, PL_MID_X, plByte(a + plLoad(m, PL_NEW_LEFT)));

  // 1. doprava (`$896A`), po čtyřech půlpixelech
  a = plLoad(m, PL_NEW_RIGHT) - plLoad(m, PL_RIGHT);
  if (a >= 0) {
    plStore(m, 0xE6, a);
    steps = a >> 2;
    var blocked = false;
    if (steps) {
      plStore(m, 0xE7, steps);
      do {
        plStore(m, PL_RIGHT, plByte(plLoad(m, PL_RIGHT) + 4));
        if (plSideBlocked(m, PL_RIGHT)) { blocked = true; break; }
        plStore(m, 0xE7, plByte(plLoad(m, 0xE7) - 1));
      } while (plLoad(m, 0xE7));
    }
    if (!blocked) {
      rest = plLoad(m, 0xE6) & 0x03;
      plStore(m, PL_RIGHT, plByte(rest + plLoad(m, PL_RIGHT)));
      blocked = !!plSideBlocked(m, PL_RIGHT);
    }
    if (blocked) {
      plStore(m, PL_RIGHT, plByte((plLoad(m, PL_RIGHT) & 0xFC) - 1));
      plStore(m, 0xE5, plByte(plLoad(m, PL_NEW_RIGHT) - plLoad(m, PL_RIGHT)));
      plStore(m, PL_E4, plByte(plLoad(m, 0xE5) << 1));
      plSubX(m);
      plStore(m, PL_MID_X, plByte(plLoad(m, PL_MID_X) - plLoad(m, 0xE5)));
    }
  }

  // 2. doleva (`$89B3`)
  a = plLoad(m, PL_LEFT) - plLoad(m, PL_NEW_LEFT);
  if (a >= 0) {
    plStore(m, 0xE6, a);
    steps = a >> 2;
    var hitLeft = false;
    if (steps) {
      plStore(m, 0xE7, steps);
      do {
        plStore(m, PL_LEFT, plByte(plLoad(m, PL_LEFT) - 4));
        if (plSideBlocked(m, PL_LEFT)) { hitLeft = true; break; }
        plStore(m, 0xE7, plByte(plLoad(m, 0xE7) - 1));
      } while (plLoad(m, 0xE7));
    }
    if (!hitLeft) {
      plStore(m, PL_E4, plLoad(m, 0xE6) & 0x03);
      plStore(m, PL_LEFT, plByte(plLoad(m, PL_LEFT) - plLoad(m, PL_E4)));
      hitLeft = !!plSideBlocked(m, PL_LEFT);
    }
    if (hitLeft) {
      // ★ `$89E4` počítá ze `$3A`, ale **zpátky ho neukládá** (na rozdíl od
      // pravé strany, kde `$8997` `$3B` přepíše)
      plStore(m, 0xE5, plByte(plByte((plLoad(m, PL_LEFT) & 0xFC) + 4)
                              - plLoad(m, PL_NEW_LEFT)));
      plAddX(m, plByte(plByte(plLoad(m, 0xE5) << 1) + 1));
      plStore(m, PL_MID_X, plByte(plLoad(m, PL_MID_X) + plLoad(m, 0xE5)));
    }
  }

  // 3. nahoru (`$89FD`), po osmi pixelech
  a = plLoad(m, PL_TOP) - plLoad(m, PL_NEW_TOP);
  if (a >= 0) {
    plStore(m, 0xE6, a);
    steps = a >> 3;
    var hitUp = false;
    if (steps) {
      plStore(m, 0xE7, steps);
      do {
        plStore(m, PL_TOP, plByte(plLoad(m, PL_TOP) - 8));
        if (plMidBlocked(m, plLoad(m, PL_TOP))) { hitUp = true; break; }
        plStore(m, 0xE7, plByte(plLoad(m, 0xE7) - 1));
      } while (plLoad(m, 0xE7));
    }
    if (!hitUp) {
      plStore(m, 0xE6, plLoad(m, 0xE6) & 0x07);
      plStore(m, PL_TOP, plByte(plLoad(m, PL_TOP) - plLoad(m, 0xE6)));
      hitUp = !!plMidBlocked(m, plLoad(m, PL_TOP));
    }
    if (hitUp) {
      var up = plByte(plByte(plByte(plLoad(m, PL_TOP) + 6) & 0xF8) + 2);
      var delta = plByte(up - plLoad(m, PL_NEW_TOP));
      plStore(m, PL_NEW_BOTTOM, plByte(delta + plLoad(m, PL_NEW_BOTTOM)));
      plAddY(m, delta);
      plStore(m, PL_MID_Y, plByte(delta + plLoad(m, PL_MID_Y)));
    }
  }

  // 4. dolů (`$8A57`)
  a = plLoad(m, PL_NEW_BOTTOM) - plLoad(m, PL_BOTTOM);
  if (a >= 0) {
    plStore(m, 0xE6, a);
    steps = a >> 3;
    var hitDown = false;
    if (steps) {
      plStore(m, 0xE7, steps);
      do {
        plStore(m, PL_BOTTOM, plByte(plLoad(m, PL_BOTTOM) + 8));
        if (plMidBlocked(m, plLoad(m, PL_BOTTOM))) { hitDown = true; break; }
        plStore(m, 0xE7, plByte(plLoad(m, 0xE7) - 1));
      } while (plLoad(m, 0xE7));
    }
    if (!hitDown) {
      plStore(m, PL_BOTTOM, plByte((plLoad(m, 0xE6) & 0x07) + plLoad(m, PL_BOTTOM)));
      hitDown = !!plMidBlocked(m, plLoad(m, PL_BOTTOM));
    }
    if (hitDown) {
      plStore(m, PL_BOTTOM,
              plByte(plByte(plByte(plLoad(m, PL_BOTTOM) - 0x0A) | 0x07) + 2));
      plStore(m, PL_E4, plByte(plLoad(m, PL_NEW_BOTTOM) - plLoad(m, PL_BOTTOM)));
      plSubY(m);
    }
  }
} // plResolveRoom

/* -------------------------------------------------------------- the picture */

/**
 * `$87D3` — the three sprites into the VIC, ninth bits and all.
 * @param {Object} m - The machine.
 */
function plWriteSprites(m) {
  for (var x = 5; x >= 0; x--) {
    plStore(m, 0xD002 + x, plLoad(m, PL_SPRITES + x));
  }
  plStore(m, 0xD010, (plLoad(m, 0xD010) & 0xF1) | plLoad(m, PL_MSIGX));
} // plWriteSprites

/**
 * `$8737`-`$87D2` — which block of sprite data each of the three sprites
 * points at, and ★ the one thing the game does to the data itself: when the
 * agent turns, `$8795` **mirrors his blocks in place** through the table of
 * reversed bits at `$C500` (§13). The 63rd byte of a block, the one the VIC
 * never reads, is where the original keeps which way the block faces.
 * @param {Object} m - The machine.
 */
function plWritePointers(m) {
  var enable = plLoad(m, 0xD015), state = plLoad(m, PL_STATE);
  var y = plLoad(m, PL_PTR_BASE + state);
  if (state >= 0x14 && state < 0x1A) {
    enable &= 0xFB;                                // prostřední sprajt zmizí
  } else {
    plStore(m, PL_POINTERS + 1, y);
    enable |= 0x04;
    y = plByte(y + 1);
  }
  plStore(m, PL_POINTERS + 2, y);
  y = plByte(y + 1);
  if (state >= 0x07 && state < 0x0E) { y = plByte(y + 1); }
  plStore(m, PL_POINTERS, y);
  plStore(m, 0xD015, enable);

  var at = state * 2;
  plStore(m, 0x18, plLoad(m, PL_PTR_ADDR + at));
  plStore(m, 0x19, plLoad(m, PL_PTR_ADDR + at + 1));
  var base = (plLoad(m, 0x19) << 8) | plLoad(m, 0x18);
  if (plLoad(m, base + 0x3F) === plLoad(m, PL_FACING)) { return; }
  plStore(m, base + 0x3F, plLoad(m, PL_FLIP + plLoad(m, base + 0x3F)));
  // ★ tři adresy, které si `$8768`-`$8792` sází do vlastního kódu, se liší
  // **jen spodním bajtem** — horní je pořád `$19`, takže se přetečení
  // nepřenáší (a nepřenášelo se ani v originálu)
  var high = plLoad(m, 0x19) << 8, low = plLoad(m, 0x18);
  var at0 = high | low, at1 = high | plByte(low + 1), at2 = high | plByte(low + 2);
  var i = plLoad(m, PL_MIRROR_COUNT + state), first, third;
  for (;;) {
    first = plLoad(m, at0 + i);
    third = plLoad(m, at2 + i);
    plStore(m, at2 + i, plLoad(m, PL_FLIP + first));
    plStore(m, at0 + i, plLoad(m, PL_FLIP + third));
    plStore(m, at1 + i, plLoad(m, PL_FLIP + plLoad(m, at1 + i)));
    i = plByte(i - 3);
    if ((i & 0x3F) === 0x3D) {
      i = plByte(i - 1);
      if (i === 0xFC) { break; }
    }
  }
} // plWritePointers

/**
 * `$8E5F` — in the shaft the cabin's sprite follows the agent from one side
 * of the doorway to the other.
 * @param {Object} m - The machine.
 */
function plCabin(m) {
  if (plLoad(m, PL_PLACE)) { return; }
  var at = 0xCA;
  if (!(plLoad(m, PL_MSIGX) & 0x02) && plLoad(m, PL_SPRITES) < 0xAC) { at = 0xA0; }
  plStore(m, 0xD000, at);
} // plCabin

/* --------------------------------------------------------- falling and time */

/**
 * `$AE2D` — the question the room loop asks every frame: **is the agent
 * standing on anything?** Only in a room, and only when he is not already
 * falling.
 * @param {Object} m - The machine.
 */
function plFloorCheck(m) {
  if (!plLoad(m, PL_PLACE)) { return; }
  if (plLoad(m, PL_FALL)) { return; }
  plGroundCheck(m);
} // plFloorCheck

/**
 * `$AE36` — the answer. ★ Which cells count depends on the state: standing
 * (`$0E`) and the first frame of a somersault (`$10`) ask about **two**
 * places, the four walking states about one, and every other state is
 * left alone entirely. A miss means `INC $41`, and that is a fall.
 * @param {Object} m - The machine.
 */
function plGroundCheck(m) {
  plStore(m, 0xE8, plByte(plBottomEdge(m) - 1));
  var edge = plLeftEdge(m);
  plStore(m, 0xE6, edge.a);
  plStore(m, 0xE7, edge.c);
  var state = plLoad(m, PL_STATE), left, right;
  if (state === 0x00 || state === 0x07) { left = 0x05; right = 0x08; }
  else if (state === 0x06 || state === 0x0D) { left = 0x09; right = 0x03; }
  else if (state === 0x0E) {
    if (plFootCell(m, 0x05, 0x06)) { return plStand(m); }
    left = 0x09; right = 0x02;
  } else if (state === 0x10) {
    if (plFootCell(m, 0x07, 0x08)) { return plStand(m); }
    left = 0x0D; right = 0x02;
  } else { return; }

  if (plFootCell(m, left, right)) { return plStand(m); }
  if (!(plLoad(m, PL_FACING) & 0x80)) {                 // `$AE91`
    var right9 = plRightEdge(m);
    if (!right9.c) { return plFall(m); }
    return right9.a >= 0x60 ? plStand(m) : plFall(m);
  }
  if (plLoad(m, 0xE7)) { return plFall(m); }            // `$AE9C`
  return plLoad(m, 0xE6) < 0x18 ? plStand(m) : plFall(m);
} // plGroundCheck

/** `$AEA9` — there is floor: the fall is off */
function plStand(m) { plStore(m, PL_FALL, 0); plStore(m, PL_LANDED, 0); }

/** `$AEA6` — there is not: one more frame of falling */
function plFall(m) { plStore(m, PL_FALL, plByte(plLoad(m, PL_FALL) + 1)); }

/**
 * `$AEB0` — the cell under one of the agent's feet. Which of the two
 * offsets counts is decided by which way he faces.
 * @param {Object} m - The machine.
 * @param {number} left - Offset while facing left.
 * @param {number} right - Offset while facing right.
 * @returns {number} 1 when there is floor there.
 */
function plFootCell(m, left, right) {
  var off = (plLoad(m, PL_FACING) & 0x80) ? left : right;
  var sum = off + plLoad(m, 0xE6);
  var high = (sum > 0xFF ? 1 : 0) + plLoad(m, 0xE7);
  return plCell(m, plByte(sum), plLoad(m, 0xE8), high & 1).c;
} // plFootCell

/**
 * `$8E21` and `$8E3F` — while the agent falls he keeps drifting the way he
 * was going, **one pixel a frame**, and the ninth bits go with him.
 * @param {Object} m - The machine.
 * @param {number} by - 1 or -1.
 */
function plDrift(m, by) {
  var x;
  if (by < 0 && plLoad(m, 0xD002) === 0) {              // `$8E41` před posunem
    plStore(m, 0xD010, plLoad(m, 0xD010) & 0xF1);
    plStore(m, PL_MSIGX, 0);
  }
  for (x = 4; x >= 0; x -= 2) {
    plStore(m, 0xD002 + x, plByte(plLoad(m, 0xD002 + x) + by));
    plStore(m, PL_SPRITES + x, plByte(plLoad(m, PL_SPRITES + x) + by));
  }
  if (by > 0 && plLoad(m, 0xD002) === 0) {              // `$8E2C` po posunu
    plStore(m, PL_MSIGX, 0x0E);
    plStore(m, 0xD010, plLoad(m, 0xD010) | 0x0E);
  }
} // plDrift

/**
 * `$861B` — a frame of falling. ★ The speed is `($41 >> 3) + 2`, at most 8,
 * so a fall accelerates; `$42` marks that the agent has bumped into a wall
 * and stops the drift. The floor is asked about the same way as when
 * walking (`$869A JSR $AE36`), and a fall that reaches `$F8` at the bottom
 * of the screen turns into **the fall that kills** (`$86C7`).
 * @param {Object} m - The machine.
 * @returns {Object} What happened.
 */
function plFallStep(m) {
  var out = {died: 0, transition: 0};
  plStore(m, 0xD412, 0x80);
  plAddY(m, plFallSpeed(m));
  if (!plLoad(m, PL_LANDED)) {
    plDrift(m, (plLoad(m, PL_FACING) & 0x80) ? -1 : 1);
    plStore(m, 0xE6, plByte(plBottomEdge(m) - 2));
    var edge = plLeftEdge(m), wall = false, hit;
    if (edge.c) {
      hit = plCell(m, edge.a, plLoad(m, 0xE6), 1);
      wall = (hit.a === 0x47 || hit.a === 0x48);
    } else if (edge.a < 0x18) {
      wall = true;                                      // `$8651` u okraje
    } else {
      hit = plCell(m, edge.a, plLoad(m, 0xE6), 0);
      wall = (hit.a === 0x47 || hit.a === 0x48);
    }
    plStore(m, 0xE7, edge.a);
    if (wall) {                                         // `$8664` odsun doprava
      plAddX(m, plByte(plByte((plLoad(m, 0xE7) & 0xF8) + 8) - plLoad(m, 0xE7)));
      plStore(m, PL_LANDED, plByte(plLoad(m, PL_LANDED) + 1));
    } else {
      var right = plRightEdge(m);
      plStore(m, 0xE7, right.a);
      hit = plCell(m, right.a, plLoad(m, 0xE6), right.c);
      if (hit.c && (hit.a === 0x47 || hit.a === 0x48)) { // `$868C` odsun doleva
        plStore(m, PL_E4, plByte((plLoad(m, 0xE7) & 0x07) + 1));
        plSubX(m);
        plStore(m, PL_LANDED, plByte(plLoad(m, PL_LANDED) + 1));
      }
    }
  }
  plGroundCheck(m);
  if (!plLoad(m, PL_FALL)) {                            // `$86AC` dosedl
    plStore(m, 0xE6, plBottomEdge(m));
    plStore(m, PL_E4, plByte(plByte(plByte(plLoad(m, 0xE6) - 2) & 0xF8) | 0x03));
    plStore(m, PL_E4, plByte(plLoad(m, 0xE6) - plLoad(m, PL_E4)));
    plSubY(m);
    plWriteSprites(m);
    return out;
  }
  plWriteSprites(m);
  if (plBottomEdge(m) >= 0xF8) { m.pl.deathFall = true; }
  return out;
} // plFallStep

/** the speed of a fall, `$8620`: `($41 >> 3) + 2`, never more than 8 */
function plFallSpeed(m) {
  var speed = (plLoad(m, PL_FALL) >> 3) + 2;
  return speed >= 9 ? 8 : speed;
} // plFallSpeed

/**
 * `$86C7` — the fall that kills, one frame of it. The original loops here
 * with `JSR $7F6B` in the middle, so a pass of this is a frame just the
 * same; when the agent's top edge is past `$F6` he is dead of it (`$43 = 2`).
 * @param {Object} m - The machine.
 * @returns {number} 2 when he has just died, 0 while he is still falling.
 */
function plDeathFall(m) {
  plAddY(m, plFallSpeed(m));
  plWriteSprites(m);
  if (plTopEdge(m) < 0xF6) { return 0; }
  plStore(m, PL_DEATH, 0x02);
  plStore(m, PL_FALL, 0);
  m.pl.deathFall = false;
  return 2;
} // plDeathFall

/**
 * `$8398` — the clock, in the interrupt, once a frame. ★ A game second is
 * **sixty frames**, a game hour therefore 216 000 of them; the clock runs
 * in BCD from twelve and the game ends at six (§19).
 * @param {Object} m - The machine.
 */
function plClock(m) {
  if (plLoad(m, PL_CLOCK_STOP)) { return; }
  if (plLoad(m, PL_HOURS) === 0x06) { return; }
  plStore(m, PL_CLOCK_FRAMES, plByte(plLoad(m, PL_CLOCK_FRAMES) + 1));
  if (plLoad(m, PL_CLOCK_FRAMES) === 0x3C) {
    plStore(m, PL_CLOCK_FRAMES, 0);
    var seconds = plBcdAdd(plLoad(m, PL_SECONDS), 1);
    plStore(m, PL_SECONDS, seconds);
    if (seconds >= 0x60) {
      plStore(m, PL_SECONDS, 0);
      plClockAdd(m, 1);                          // `$83C2`
    }
  }
} // plClock

/**
 * `$83C2` — **minuty k hodinám**, a je to jedna rutina pro dvě věci: tik
 * hodin ji volá s jednou minutou, ★ **umírání s deseti** (`$96EF`, §31).
 * Počítá se v `SED`, tedy v BCD, hodina po dvanácté je jedna, a na **šesté**
 * hodině hra končí — `$43` dostane `$FF`.
 * @param {Object} m - The machine.
 * @param {number} a - How many minutes, in BCD.
 */
function plClockAdd(m, a) {
  var minutes = plBcdAdd(plLoad(m, PL_MINUTES), a);
  plStore(m, PL_MINUTES, minutes);
  if (minutes >= 0x60) {
    plStore(m, PL_MINUTES, plBcdSub(minutes, 0x60));
    var hours = plBcdAdd(plLoad(m, PL_HOURS), 1);
    plStore(m, PL_HOURS, hours >= 0x13 ? 0x01 : hours);
    plStore(m, PL_HOUR_BELL, plByte(plLoad(m, PL_HOUR_BELL) + 1));
  }
  if (plLoad(m, PL_HOURS) === 0x06) { plStore(m, PL_DEATH, 0xFF); }
} // plClockAdd

/** BCD addition the way the 6502 does it in `SED` (`$83B0`) */
function plBcdAdd(a, b) {
  var lo = (a & 0x0F) + (b & 0x0F), hi = (a >> 4) + (b >> 4);
  if (lo > 9) { lo -= 10; hi++; }
  if (hi > 9) { hi -= 10; }
  return ((hi << 4) | lo) & 0xFF;
} // plBcdAdd

/** BCD subtraction (`$83CB SBC #$60`) */
function plBcdSub(a, b) {
  var lo = (a & 0x0F) - (b & 0x0F), hi = (a >> 4) - (b >> 4);
  if (lo < 0) { lo += 10; hi--; }
  if (hi < 0) { hi += 10; }
  return ((hi << 4) | lo) & 0xFF;
} // plBcdSub

/* ------------------------------------------------------------------- a frame */

/**
 * `$8609` — the agent's step: falling if he is falling, walking otherwise,
 * and neither if he is dying.
 * @param {Object} m - The machine.
 * @param {number} joy - The byte the game would read from `$DC00`.
 * @returns {Object} What happened that the caller has to act on.
 */
function plAgentStep(m, joy) {
  var out = {died: 0, transition: 0};
  // `$8609 LDA $43 / BNE` — je-li po čem, jde se rovnou na obřad (§31)
  // ★ **Ptá se na `$43`, jak vypadalo před obsluhou přerušení.** Na stroji
  // běží průchod smyčkou **před** obsluhou (ta je na rastru `$FF`), v modelu
  // za ní, takže kolize z `$833D` je v paměti dřív, než na ni průchod může
  // dojít. Bez téhle pojistky by model po zabití z obsluhy zahodil **celý
  // poslední krok agenta** — jeho zvuk, jeho hrany i posun stavu — a obřad
  // by začal o průchod dřív než na stroji. Doměřeno `matchsound --effects`:
  // záznamu chyběl `$8E77` (`$D418 = $05`) a hned za obřadem přebývalo
  // `$D412 = $80`, protože se stav agenta nestihl posunout.
  var died = m.pl.deathSeen === undefined ? plLoad(m, PL_DEATH) : m.pl.deathSeen;
  if (died) { out.died = plStartDying(m); return out; }
  if (plLoad(m, PL_FALL)) { return plFallStep(m); }

  plSound(m);
  if (plLoad(m, PL_TICK) < plLoad(m, PL_DIVIDER)) { return out; }
  plStore(m, PL_TICK, 0);
  plStore(m, PL_TOP, plTopEdge(m));
  plStore(m, PL_BOTTOM, plByte(plBottomEdge(m) - 2));
  var edge = plLeftEdge(m);
  plStore(m, PL_LEFT, plByte((edge.c ? 0x80 : 0) | (edge.a >> 1)));
  edge = plRightEdge(m);
  plStore(m, PL_RIGHT, plByte((edge.c ? 0x80 : 0) | (edge.a >> 1)));

  plReadStick(m, joy);
  plMove(m);
  plAnimate(m, joy);
  plResolve(m);
  // ★ `$8B6C` je šestý krok a **nevrací se**: když agent ze strany odejde,
  // skočí se rovnou na přechod a zbytek kroku (kabina, zápis do VIC,
  // ukazatele) se ten průchod už neudělá
  out.transition = plExitCheck(m);
  if (out.transition) {
    m.pl.move = plLoad(m, PL_PLACE)
      ? trEnterShaft(m, out.transition)           // z místnosti do šachty
      : trEnterRoom(m, out.transition);           // a ze šachty do místnosti
    m.pl.move.entropy = function () { return plEntropy(m); };
    return out;
  }
  plCabin(m);                                     // `$8724 JSR $8E5F`
  // ★ `$8727 JSR $94FA` — druhé ze dvou míst, kde se latch `$D01E` čte, a
  // tohle je **za bránou `$3E`/`$40`**, tedy každý třetí průchod (§30).
  // `$872A LDA $43 / BNE` pak posílá rovnou na umírání `$95DA`.
  if (!m.noCollision) {
    var hit = coFrame(m);
    // `$872A LDA $43 / BNE / JMP $95DA` — smrt se obslouží hned tady
    if (hit) { out.died = plStartDying(m); return out; }
  }
  plWriteSprites(m);
  plWritePointers(m);
  return out;
} // plAgentStep

/**
 * `$95DA` se rozbíhá — a je to **jediné místo**, kde se obřad zakládá.
 *
 * ★ `m.noDeath` je záplata měřidel, ne pravidlo hry: `matchplayer`
 * a `matchrobots` se na smrti zastavují a obřad by jim rozsypal svět, který
 * srovnávají.
 *
 * @param {Object} m - The machine.
 * @returns {number} `$43`, jak ho obřad našel.
 */
function plStartDying(m) {
  var how = plLoad(m, PL_DEATH);
  if (m.noDeath) { return how; }
  // ★ **`$95E8 SEI` je v hlavní smyčce, a ta běží před obsluhou** (§32):
  // obsluha toho snímku se tedy už nespustí. Model ji počítá první, takže
  // její zápisy do SID ve frontě leží — a protože mají vyšší linku, seřadí
  // se **za** ztišení `$95EC` a hlasy se hned zase rozezvučí. Zahodí se
  // proto, jinak přes celý obřad drží zaseknutý tón; doznívání (`$8318`,
  // linka o jednu níž) patří do téže obsluhy.
  sndDropFrom(m, SND_IRQ_LINE - 1);
  m.pl.tickSound = false;
  m.pl.dying = death.start(m);
  return how;
} // plStartDying

/**
 * `$8E77` — the footstep, on voice 3 of the SID. There is no sound before
 * M6, so this keeps only the one byte a comparison can see.
 * @param {Object} m - The machine.
 */
function plSound(m) {
  // ★ `$4E` před obsluhou přerušení — viz `sndStep` a `plAgentStep`
  sndStep(m, m.pl.soundAny);                               // `$8E77`, M6 — `app/sound.js`
} // plSound

/**
 * `$9296` — the first half of searching a piece of furniture: **which
 * character is under the agent's hand?**
 *
 * ★ It matters to the lift, not only to the search. Pushing the stick up
 * while standing does not skip `$AC81` — `$7272` jumps **past the agent's
 * step straight to it** — so the way onto a lift goes through here, and it
 * is this `CMP #$53` that decides. Blank means there is nothing to search
 * and the lift gets the push; anything else and `$97F1` takes over, and that
 * is the part of M3 that is not transcribed yet.
 *
 * The point asked about is three pixels right of the agent's left edge and
 * four above his bottom one, put through the same `$8CC3` as every other
 * question about the background.
 *
 * @param {Object} m - The machine.
 * @returns {number} 1 when `$97F1` would run, 0 when the cell is blank.
 */
function plSearchProbe(m) {
  var bottom = plByte(plBottomEdge(m) - 4);            // `$9299`
  var edge = plLeftEdge(m);                            // `$929D`
  var a = plByte((edge.c ? 0x80 : 0) | (edge.a >> 1)); // `$92A0` ROR A — pixel x
  a = plByte(a + 0x03);                                // `$92A1`
  var wide = a << 1;                                   // `$92A4` ASL A
  var cell = plCell(m, wide & 0xFF, bottom, wide > 0xFF ? 1 : 0);
  if (cell.a === 0x53) { return 0; }                   // `$92AB` — prázdno
  // ★ `$92AF` — **adresa té buňky do `$10`/`$11`**, a podle ní `$97F1`
  // pozná, o který kus nábytku jde (§27). Sloupec je to, co `$8CC3` nechalo
  // v `Y`; `$7C`/`$7D` je začátek řádku, který si spočítalo cestou.
  var at = cell.y + plLoad(m, 0x7C);
  plStore(m, 0x10, plByte(at));
  plStore(m, 0x11, plByte(plLoad(m, 0x7D) + (at > 0xFF ? 1 : 0)));
  return 1;
} // plSearchProbe

/**
 * `$8B6C` — the way out, either side. ★ Facing right it is the right edge
 * past `$B2` (`$8B70`), facing left the left edge under `$08` (`$8BD0`) —
 * and only the one edge is asked for, because asking writes `$79`. Out of
 * a room the agent lands in the shaft at `x = $51` with all three ninth
 * bits on (`$8BEB`: `X = $0E`, `Y = $51`); out of the shaft he lands in
 * whatever the map (`$FF96`) has next. The transition itself is the next
 * part of M3; here it is reported, not taken.
 * @param {Object} m - The machine.
 * @returns {number} 1 out to the right, -1 out to the left, 0 not yet.
 */
function plExitCheck(m) {
  var edge;
  if (plLoad(m, PL_FACING) & 0x80) {                   // `$8BD0` doleva
    edge = plLeftEdge(m);
    return plByte((edge.c ? 0x80 : 0) | (edge.a >> 1)) < 0x08 ? -1 : 0;
  }
  edge = plRightEdge(m);                               // `$8B70` doprava
  return plByte((edge.c ? 0x80 : 0) | (edge.a >> 1)) >= 0xB2 ? 1 : 0;
} // plExitCheck

/**
 * One frame of the game as the two loops run it (`$7249` in a room, `$3A15`
 * in the shaft), interrupt and all: the interrupt's counters and its clock
 * first, then the loop's own work.
 *
 * ★ The button is read **with an edge** (`$DE`), so one press is one
 * somersault; and ★ up while standing searches instead of stepping — the
 * original jumps straight past `JSR $8609` to do it (`$7272`).
 *
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give: port 2, **active low**
 *   (bit 0 up, 1 down, 2 left, 3 right, 4 button; `$7F` is at rest).
 * @param {number} [passes] - How many passes of the main loop the frame
 *   had; 1 when left out. Only a trace of the original ever passes 0 —
 *   see `plLoop`.
 * @returns {Object} `died`, `transition` and `searched`.
 */
function plFrame(m, joy, passes) {
  var out = plFrameInner(m, joy, passes);
  // ★ **Doznívání zvuku se odtikává až za průchodem** (`$8318`), a je to
  // jediné místo, kde na pořadí obsluhy a smyčky záleží ve **stavu**, ne
  // jen v zápisech: obsluha je na rastru `$FF`, tedy na konci snímku, ale
  // model ji dělá první (§32). Tón, který průchod udeřil (`$A4 = 8`), má
  // tedy na stroji ve výpisu o jedna míň — a kdyby se tikalo před
  // průchodem, tikalo by se z hodnoty, kterou průchod teprve napíše.
  // ★ Linka je o **jednu pod** obsluhou, aby zápisy zůstaly tam, kde je má
  // stroj: `$8318` je v obsluze **před** roboty (`$832A`) i před churnem.
  if (m.pl && m.pl.tickSound) {
    m.pl.tickSound = false;
    sndAt(m, SND_IRQ_LINE - 1);
    sndTick(m);
    sndAt(m, SND_LOOP_LINE);
  }
  return out;
} // plFrame

/** the body of `plFrame`; the countdown of the sound is ticked around it */
function plFrameInner(m, joy, passes) {
  if (!m.pl) { m.pl = {deathFall: false, liftWait: 0, riding: 0, move: null, roomRide: null, search: null}; }
  // ★ **V bezpečnostním terminálu obsluha přerušení neběží** (§29): `$9D14`
  // udělá `SEI` a `CLI` přijde až na `$9ED8`. Stojí tedy `$E0`, stojí tik,
  // stojí hodiny a **stojí roboti i koule** — a to je podstatné, protože
  // koule je **sprajt 0** a robot jich má čtyři: kdyby běželi dál, přepsali
  // by terminálu sprajtové registry i ukazatele a v jeho rozích by blikala
  // náhodná data (nahlásil operátor 2026-09-20).
  // ★★ **V řídicí místnosti od `$AB23` běží jiná obsluha přerušení** (§35):
  // `$BF62` přehodí vektor na `$838C`, a ta jen potvrdí rastr a zavolá
  // `$00FC`, tedy `INC $E0`. Hodiny proto stojí, zvuk nedoznívá a posuvné
  // registry robotů se nehýbou — a u vět 4 a 5 se vektor už nevrací.
  if (m.pl.search && m.pl.search.speaking) {
    var said = {died: 0, transition: 0, searched: 0, computer: 0, lift: 0,
                arrived: 0, moving: 0, riding: 0, searching: 1, gaveUp: 0,
                terminal: 0, partial: 0};
    plStore(m, PL_FRAME, plByte(plLoad(m, PL_FRAME) + 1));   // `$00FC INC $E0`
    var spoke = furniture.frame(m, m.pl.search, joy);
    if (m.pl.search.speech !== undefined) {
      said.speech = m.pl.search.speech;
      m.pl.search.speech = undefined;
    }
    if (m.pl.search.gameOver) { said.gameOver = 1; }
    if (spoke.done) { m.pl.search = null; said.searching = 2; }
    return said;
  }
  if (m.pl.search && m.pl.search.phase === 'terminal') {
    var out2 = {died: 0, transition: 0, searched: 0, computer: 0, lift: 0,
                arrived: 0, moving: 0, riding: 0, searching: 1, gaveUp: 0,
                terminal: 1, partial: 0};
    var ran = furniture.frame(m, m.pl.search, joy);
    if (ran.done) {
      m.pl.search = null;
      out2.searching = 2;
      out2.terminal = 0;
      // ★ `$9D09` se sice nevrací do `$97F1`, ale **`RTS` vede na `$92C0`
      // a odtud na `$7272 JMP $728B`** — takže zbytek průchodu smyčkou
      // (výtah v místnosti a kontrola podlahy) se ještě udělá
      out2.roomLift = fnStep(m, joy);                    // `$728B`
      if (out2.roomLift.ride) { m.pl.roomRide = out2.roomLift.ride; out2.riding = 1; }
      else { plFloorCheck(m); }                          // `$728E`
    }
    return out2;
  }
  // ★ **Umírání má vlastní snímky a obsluha přerušení v nich neběží**
  // (§31): `$95E8` udělá `SEI` a `CLI` přijde až na `$96F5`, takže v obřadu
  // nestoupne `$E0`, nejdou hodiny, nejedou roboti a nekreslí se kolize.
  // Model ho proto krájí po kolech a vrací se **dřív, než na ně dojde** —
  // stejně, jako to dělá bezpečnostní terminál (§29).
  if (m.pl.dying) {
    var dyingOut = {died: m.pl.dying.how, transition: 0, searched: 0, computer: 0,
                    lift: 0, arrived: 0, moving: 0, riding: 0, searching: 0,
                    gaveUp: 0, terminal: 0, dying: 1};
    var went = death.frame(m, m.pl.dying, function () { return plEntropy(m); }, passes);
    // ★ **Věta se hlásí hned, ne až s koncem obřadu**: smrtelný pád ji řekne
    // a teprve pak (až přehrávač domluví) staví — viz `dhFrame`.
    if (went.speech !== undefined) { dyingOut.speech = went.speech; }
    if (went.done) {
      m.pl.dying = null;
      dyingOut.dying = 2;
      dyingOut.gameOver = went.gameOver || 0;
      // ★ **Nula je věta, ne „žádná věta".** Obřad řekne větu `7` jen po
      // smrtelném pádu (`$9605`); rozpouštění mlčí. `went.speech || 0` by
      // z toho mlčení udělalo `speech: 0`, a worker se ptá `!== undefined`,
      // takže by každá obyčejná smrt řekla **větu 0 — konec hry**
      // (`$B86E`). Do M6 to nebylo slyšet, protože řeč nikdo nepřehrával.
    }
    return dyingOut;
  }
  // ★ **Zameten rastru**: obraz se kreslí z toho, co do registrů zapsal
  // průchod minulý, a hotový je dřív, než se ho `$94FA` stihne zeptat. Do
  // latche `$D01E` se proto přičte **tady, před obojím čtením** — a teprve
  // pak si ho `$833D` (v místnosti, každý snímek) nebo `$8727` (každý třetí
  // průchod) vyzvedne. Kdyby se zametalo až ve smyčce, přišly by kolize
  // o snímek pozdě. Změřeno `traceplayer.py --collision`, §30.
  if (!m.noCollision) { coSweep(m); }
  // ★ Co `$8609` uvidí: `$43` **před** obsluhou přerušení (viz `plAgentStep`)
  m.pl.deathSeen = plLoad(m, PL_DEATH);
  // ★ A totéž pro `$4E`, které čte `$8E77` (`app/sound.js`): obsluha ho
  // nuluje a hlasy robotů ho sázejí, ale průchod smyčkou běží před ní.
  m.pl.soundAny = plLoad(m, 0x4E);
  // ★ `$8318` — v obsluze tiká **počitadlo zvuku** `$A4`, a když dotiká,
  // hlasy 2 a 3 jdou do testu, tedy do ticha naráz (M6, `app/sound.js`).
  // Tiká se až **za** průchodem, viz `plFrame`.
  m.pl.tickSound = true;
  // obsluha přerušení, spodní půlka obrazovky (`$8361`)
  plStore(m, PL_FRAME, plByte(plLoad(m, PL_FRAME) + 1));
  plStore(m, PL_TICK, plByte(plLoad(m, PL_TICK) + 1));
  plClock(m);
  // ★ `$8368 JSR $84EA` — **dva posuvné registry, ze kterých roboti berou
  // výšku** (`app/sound.js`). Bez nich má hlas 1 frekvenci nula a robot je
  // němý až na jedno pípnutí při změně stavu (§10.14).
  sndChurn(m);
  // ★ Roboti a koule běží **v místnosti** z obsluhy přerušení (`$832A`);
  // v šachtě `$82F8` ten úsek přeskočí (§5). Hranice snímku, jak ji vidí
  // harness, padne **mezi `INC $E0` a je** — změřeno na blikání barev
  // robotů (`$9207` se ptá `$E0`, a v záznamu už je zvednuté).
  // ★ `m.noRobots` je **záplata záznamu**, ne pravidlo hry: `traceplayer`
  // bez `--robots` přepíše `$8ECA` na `RTS` (M3 je agent bez robotů), a aby
  // se proti takovému záznamu dalo měřit, musí to přepis udělat taky.
  // ★ `$833D JSR $94FA` — **kolize sprajtů jsou první** v téhle větvi, tedy
  // ještě před krokem robotů (§30, `app/collision.js`). Pořadí je vidět:
  // latch `$D01E` se tu vyprázdní a roboti se pak teprve posunou.
  // ★ `m.noCollision` je zase **záplata záznamu**, ne pravidlo hry:
  // `traceplayer` bez `--robots` přepíše `$94FA` na `RTS`.
  if (plLoad(m, PL_PLACE) && !m.pl.move && !m.noRobots) {
    // ★ **Obsluha si `$79`-`$7D` schová a vrátí** (`$832E`-`$8339` a
    // `$8346`-`$8353`). Není to úklid pro parádu: `$7A`-`$7D` je odkládací
    // pásmo, ve kterém `$8CC3` (`plCell`) nese adresu buňky, na kterou se
    // ptá pohyb agenta — a kolize i roboti se ptají pozadí taky. Bez toho
    // by agent po každém snímku sahal do jiné buňky, než do které sahal.
    var kept = [plLoad(m, 0x79), plLoad(m, 0x7A), plLoad(m, 0x7B),
                plLoad(m, 0x7C), plLoad(m, 0x7D)];
    // ★ M6: **hlasy robotů píše obsluha**, tedy konec snímku (`app/sound.js`,
    // `SND_IRQ_LINE`) — přepis je dělá dřív než krok agenta, stroj později.
    sndAt(m, SND_IRQ_LINE);
    if (!m.noCollision) { coFrame(m); }
    if (!m.noOrb) { rbtFrame(m, function () { return plEntropy(m); }); }
    if (!m.noRobotsOnly) { orbFrame(m); }
    sndAt(m, SND_LOOP_LINE);
    for (var k = 0; k < 5; k++) { plStore(m, 0x79 + k, kept[k]); }
  }

  var out = {died: 0, transition: 0, searched: 0, computer: 0, lift: 0,
             arrived: 0, moving: 0, riding: 0, searching: 0, gaveUp: 0,
             terminal: 0};
  // ★ **V kapesním počítači obsluha přerušení běží dál** (§34) — na rozdíl
  // od terminálu (§29) i od obřadu umírání (§31), které drží `SEI`. Hodiny
  // proto jdou, `$E0` tiká a vypršelý čas hru ukončí i odtud (`$83EA`);
  // co se z průchodu nedělá, je krok agenta — ten je v šachtě, a šachtu
  // počítač na dobu své smyčky nahradil.
  if (m.pl.computer) {
    out.computer = 1;
    var went = pocketComputer.frame(m, m.pl.computer, joy);
    if (went.gameOver) { out.gameOver = 1; }
    if (went.did) { out.did = went.did; }
    if (went.overrun) { out.overrun = 1; }
    if (went.done) { m.pl.computer = null; out.computer = 2; }
    return out;
  }
  if (m.pl.deathFall) { out.died = plDeathFall(m); return out; }
  // ★ Přechod mezi místností a šachtou zabere **dvaašedesát snímků** a hlavní
  // smyčka v nich neběží (§21) — proto se tady vrací dřív, než by se na ni
  // došlo, a proto harness v těch snímcích napočítá nula průchodů.
  if (m.pl.move) {
    out.moving = 1;
    if (trFrame(m, m.pl.move)) { m.pl.move = null; out.moving = 2; }
    return out;
  }
  // ★ A totéž platí o **výtahu v místnosti** (§25): jednou rozjetý zdrží
  // hlavní smyčku uvnitř `$AC81` na dva snímky za každý znakový řádek, takže
  // se v nich obsluha přerušení udělá (a roboti s ní), ale nic jiného.
  // Teprve až jízda skončí, dodělá se zbytek toho průchodu — `$728E`.
  // ★ A prohledávání nábytku (§27) drží smyčku stejně jako jízda výtahem:
  // `$97F1` si čeká na vlastní snímky a vrátí se, teprve až agent pustí páku.
  if (m.pl.search) {
    out.searching = 1;
    // ★ **V terminálu agent na obrazovce není**: `$9D09` rozsvítí všech osm
    // sprajtů a dá jim svoje bloky (§29), takže sprajty 1-3 už nepatří
    // agentovi. Model to musí vědět, jinak je bude každý snímek přepisovat
    // agentem a ty se budou s terminálem **střídat** (nahlásil operátor).
    out.terminal = m.pl.search.phase === 'terminal' ? 1 : 0;
    m.fuPartial = 0;
    var found = furniture.frame(m, m.pl.search, joy);
    out.partial = m.fuPartial || 0;
    out.died = found.died;
    // ★ **Řídicí místnost mluví a končí hru** (§35): větu 4 řekne `$AB23`
    // a `$AB64 JMP $B77C` je druhá ze dvou cest do tabule se skóre (§33)
    if (m.pl.search.speech !== undefined) {
      out.speech = m.pl.search.speech;
      m.pl.search.speech = undefined;
    }
    if (m.pl.search.gameOver) { out.gameOver = 1; }

    if (found.done) {
      out.searching = 2;
      out.gaveUp = found.gaveUp;
      m.pl.search = null;
      // ★ a stejně tak prohledávání: smrt v něm jde na obřad hned
      if (found.died) { plStartDying(m); out.dying = 1; return out; }
      // `$7272 JMP $728B` — po návratu z `$97F1` jde průchod dál na výtah
      // v místnosti a na kontrolu podlahy
      if (!found.died) {
        out.roomLift = fnStep(m, joy);
        if (out.roomLift.ride) { m.pl.roomRide = out.roomLift.ride; out.riding = 1; }
        else { plFloorCheck(m); }
      }
    }
    return out;
  }
  // ★★ **Rozjetý výtah v šachtě hlavní smyčku vůbec nepustí** (`$3A85`,
  // `$3AA4`): dokud jede, originál se na `$3A15` **nevrátí**, takže se
  // nedělá ani kabina na mapě (`$73E4`), ani doznívání tónu (`$3A1B`).
  // Přepis to měl uvnitř `plLoop`, tedy **za** tím dozníváním — a to tón
  // výtahu každý druhý snímek shodilo zpátky na nulu i s oběma hlasy
  // (`$3A22`), takže z jízdy bylo praskání místo hučení (nahlásil operátor
  // 2026-09-21). ★ A zároveň to znamená, že jízda běží i ve snímcích, ve
  // kterých harness napočítá **nula průchodů** — to je právě ta smyčka,
  // kterou nepočítá.
  if (m.pl.riding) { return plRide(m, joy, out); }
  if (m.pl.roomRide) {
    out.riding = 1;
    var rode = roomLift.rideFrame(m, m.pl.roomRide);
    out.died = rode.died;
    if (rode.done) {
      m.pl.roomRide = null;
      out.riding = 2;
      // ★ `$AD32` je **`JMP $95DA`, ne návrat**: smrt při jízdě jde na obřad
      // **hned**, ještě v tomtéž průchodu, a to je podstatné — `$AE1C`
      // v něm maže sloupec plošin z **kreslicí pozice, kterou jízda
      // nechala** (`$10`/`$11`, `$E5`). Kdyby se obřad odložil o snímek,
      // přepíše ji mezitím obsluha přerušení (`$9482` → `$94C5` sahá na
      // `$10`) a smaže se jinde, než se kreslilo — tedy staré plošiny
      // zůstanou v obraze (§31).
      if (rode.died) { plStartDying(m); out.dying = 1; return out; }
      plFloorCheck(m);                             // `$728E` po návratu z `$AC81`
    }
    return out;
  }
  if (passes === 0) { return out; }
  out = plLoop(m, joy, out);
  // ★ Obřad se zakládá uvnitř průchodu (`$8609` nebo `$872A`), takže se
  // o něm model dozví až tady — a od příštího snímku si ho `plFrame` vede
  // sám (§31).
  if (m.pl.dying) { out.dying = 1; }
  return out;
} // plFrameInner

/**
 * What the original mixes its entropy out of: the raster line (`EOR $D012`
 * at `$82E3`, §8). A recording patches it to a fixed byte, so a machine may
 * carry its own source and then that is what is asked.
 * @param {Object} m - The machine.
 * @returns {number} The byte.
 */
function plEntropy(m) {
  return m.entropy ? m.entropy() & 0xFF : plLoad(m, 0xD012);
} // plEntropy

/**
 * `$3A7C` — the ride. Once it starts, the original stays **inside** this loop
 * and never goes back to the top of the shaft loop, so the agent does not
 * move and nothing else happens; one turn of it is one step of the lift and
 * ★ **two frames** (`$855A` and `$8590` both end by waiting for `$E0` to go
 * up by two). That is what `m.pl.liftWait` counts here.
 *
 * ★ **Letting go of the stick does not stop the lift.** The two inner loops
 * (`$3A85` down, `$3AA4` up) ask the stick only whether the *other* direction
 * has been asked for; with the stick at rest they take another step all the
 * same. The ride ends at the ceiling (`$1D`), at the floor (`$1E`) or **when
 * a doorway lines up with the cabin** (`$1F` or `$20` at `$0B`, `$3A91`) —
 * and only there does the original go back to reading the stick. That is why
 * the lift of Impossible Mission always stops level with a door.
 *
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give.
 * @param {Object} out - What to report in.
 * @returns {Object} `lift`: 1 going up, -1 going down, 0 when it would not
 *   move; `arrived` when a doorway has lined up.
 */
function plRide(m, joy, out) {
  var entropy = function () { return plEntropy(m); };
  // ★ směr se čte znovu na každém kroku, ale jen jako **opačná žádost**:
  // `$3A85` přejde na `$3AA4`, když se objeví „nahoru", a naopak (`$3A89`)
  var up = m.pl.riding > 0;
  if (up ? !(joy & PL_JOY_DOWN) : !(joy & PL_JOY_UP)) { up = !up; }
  m.pl.riding = up ? 1 : -1;
  // ★ **Na konec šachty se `$855A` i `$8590` ptají jako na první věc**
  // (`LDA $1D` / `LDA $1E`), tedy **ještě před čekáním na rastr**: u stropu
  // a na dně se vrátí hned a nestojí to ani snímek.
  if (plLoad(m, up ? PL_CEILING : PL_SHAFT_FLOOR)) {
    out.lift = 0; m.pl.riding = 0; m.pl.liftWait = 0; return out;
  }
  // ★ **Krok se dělá až v dalším snímku.** `$8590` čeká na **rastr `$3B`**
  // (`$A3` nahoru), a hlavní smyčka běží hned za obsluhou přerušení, tedy
  // za rastrem `$FF` — ten rastr tedy přijde až ve snímku dalším. Proto se
  // v tom, ve kterém se páka poprvé přečte, ještě nic nepohne, a zvuk kroku
  // padne do výpisu toho následujícího (změřeno, `matchsound --effects`).
  if (!m.pl.liftWait) {
    m.pl.liftWait = 1; out.lift = m.pl.riding; return out;
  }
  m.pl.liftWait = 0;
  var moved = up ? elUp(m, entropy) : elDown(m, entropy);
  if (moved) { elCabin(m); }               // `$3A8E` / `$3AAE`
  out.lift = moved ? m.pl.riding : 0;
  out.arrived = moved && elAtDoor(m) ? 1 : 0;
  // konec šachty (`$3A93`) i dveře (`$3A99`) vrátí hru ke čtení joysticku
  if (!moved || out.arrived) { m.pl.riding = 0; m.pl.liftWait = 0; }
  return out;
} // plRide

/**
 * One pass of the main loop — the part that is **not** tied to the frame.
 *
 * ★ On the real machine a pass does not always fit into a frame: in a room
 * with a lot of furniture the original manages one pass every **two**
 * frames (measured, `tools/traceplayer.py` counts the passes), and the
 * agent walks slower there. That is the speed of the 6510, not the logic,
 * so it is the caller who says how many passes a frame had.
 *
 * @param {Object} m - The machine.
 * @param {number} joy - What `$DC00` would give.
 * @param {Object} out - What to report in.
 * @returns {Object} `died`, `transition`, `searched`, `computer`, `lift`.
 */
function plLoop(m, joy, out) {
  out = out || {died: 0, transition: 0, searched: 0, computer: 0, lift: 0,
                arrived: 0, moving: 0};
  if (!m.pl) { m.pl = {deathFall: false, liftWait: 0, riding: 0, move: null, roomRide: null, search: null}; }
  var state = plLoad(m, PL_STATE), skipStep = false;
  if (plLoad(m, PL_PLACE)) {
    // ★ `$724C` — **v kódové místnosti bliká konzole** (§35, `$A73D`), a je
    // to jediné, co ty dvě místnosti dělají, dokud agent nezabere nahoru.
    // Bere si to čtyři čísla z míchačky na každých šestnáct snímků, takže
    // na tom visí i celý další los — vynechat se to nedá.
    var room = plLoad(m, PL_ROOM);
    if (room === codeRoom.ROOM_A || room === codeRoom.ROOM_B) {
      codeRoom.flicker(m, function () { return plEntropy(m); });
    }
    // místnost, `$7259`: vstup jen když agent nepadá a není v saltu
    if (!plLoad(m, PL_FALL) && state < 0x10) {
      // ★ `$7263` se ptá **jen na nahoru**; dolů se tady nečte vůbec, ten je
      // až věc výtahu v místnosti (`$ACCF`, §23)
      if (!(joy & PL_JOY_UP) && state === 0x0E) {
        // ★ `$726F JSR $9296` a pak `$7272 JMP $728B`: prohledávání a výtah
        // nejsou dvě větve, jsou **za sebou** — a `JSR $8609` se přeskočí
        if (plSearchProbe(m)) {
          // `$926F JSR $97F1` — prohledávání nábytku (§27, `app/furniture.js`)
          var began = fuStart(m);
          if (!began) { skipStep = true; }   // `$982F` — nic tu není
          else if (began.unsupported) {
            // ★ Od M5 už tu **nezbylo nic nepřepsaného** (§34, §35), ale
            // příznak zůstává: kdyby se objevil nový druh nábytku, přepis
            // to přizná a měřidlo se zastaví, místo aby tiše lhal
            out.searched = began.unsupported;
            return out;
          } else {
            m.pl.search = began;
            out.searching = 1;
            return out;                      // dál se ten průchod nedostane
          }
        } else {
          skipStep = true;
        }
      } else if (!(joy & PL_JOY_FIRE)) {
        if (!plLoad(m, PL_LATCH)) {
          plStore(m, PL_LATCH, plByte(plLoad(m, PL_LATCH) + 1));
          plStore(m, PL_JUMP, plByte(plLoad(m, PL_JUMP) + 1));
        }
      } else {
        plStore(m, PL_LATCH, 0);
      }
    }
  } else {
    // šachta, `$3A15`: kabina na mapě pevnosti a doznívající tón výtahu
    elCabin(m);
    elToneDecay(m);
    // `$3A3C`: tlačítko vestoje **otevře kapesní počítač**, ne salto
    if (!(joy & PL_JOY_FIRE)) {
      if (!plLoad(m, PL_LATCH)) {
        plStore(m, PL_LATCH, plByte(plLoad(m, PL_LATCH) + 1));
        if (state === 0x0E) {
          // ★ `$3A4F BEQ $3AC6` — **kapesní počítač** (§34). Otevře se ještě
          // v tomhle snímku: `$3AC6 JSR $7F6B` patří jemu, a všechno za ním
          // až tomu dalšímu, proto `pocketComputer.start` generátor rovnou
          // o jeden `yield` posune.
          m.pl.computer = pocketComputer.start(m, function () { return plEntropy(m); });
          out.computer = 1;
          return out;
        }
        if (state < 0x10) { plStore(m, PL_JUMP, plByte(plLoad(m, PL_JUMP) + 1)); }
      }
    } else {
      plStore(m, PL_LATCH, 0);
    }
    // `$3A7C`: rozjetý výtah se joysticku neptá, jestli má jet dál — jede,
    // dokud nedojede ke dveřím nebo na konec šachty (viz `plRide`)
    if (m.pl.riding) { return plRide(m, joy, out); }
    // `$3A5E`: stojí-li agent v kabině, joystick nahoru a dolů **jezdí
    // výtahem** (`$855A`/`$8590`) a krok agenta se vůbec nevolá
    // ★ obojí naráz se nebere: `$3A7C` a `$3A85` by si takový joystick
    // podávaly dokola a hra by se zasekla — na páce to nejde udělat
    if (elInCabin(m)
        && (joy & (PL_JOY_UP | PL_JOY_DOWN)) !== (PL_JOY_UP | PL_JOY_DOWN)) {
      m.pl.riding = !(joy & PL_JOY_UP) ? 1 : -1;   // stačí **jeden** ze směrů
      return plRide(m, joy, out);
    }
  }
  var step = skipStep ? {died: 0, transition: 0} : plAgentStep(m, joy);
  // ★ Snímek může mít **víc průchodů** (§19), a mezi dvěma z nich už žádná
  // obsluha přerušení není — od druhého průchodu tedy platí to, co je
  // v paměti teď (viz `plAgentStep` a `plSound`).
  m.pl.deathSeen = plLoad(m, PL_DEATH);
  m.pl.soundAny = plLoad(m, 0x4E);
  out.died = step.died;
  out.transition = step.transition;
  // ★ `$8B6C` **nevrací se do smyčky**, skáče rovnou na přechod — takže
  // `$728B JSR $AC81` ani `$728E JSR $AE2D` se ten průchod už neudělají
  if (m.pl.move) { out.moving = 1; return out; }
  // ★ `$728B` a `$728E` jsou kroky smyčky **místnosti**; smyčka šachty
  // (`$3A76`) po kroku agenta skáče rovnou zpátky a neptá se na nic
  if (plLoad(m, PL_PLACE)) {
    out.roomLift = fnStep(m, joy);            // `$728B` — výtah v místnosti
    // ★ Rozjetý výtah **nevrátí řízení**: `$ACEB` i `$AD7A` si čekají na
    // vlastní snímky, takže se tenhle průchod smyčkou nedokončí a `$728E` se
    // udělá teprve tehdy, až jízda skončí (`plFrame`)
    if (out.roomLift.ride) {
      m.pl.roomRide = out.roomLift.ride;
      out.riding = 1;
      return out;
    }
  }
  plFloorCheck(m);                           // `$728E`
  return out;
} // plLoop

/* ------------------------------------------------------- setting a game up */

/**
 * What the step needs to find in memory before it can run once.
 *
 * The generators and the room builder work on `data/fortress.json` and
 * `data/rooms.json`; the agent needs three more things, and none of them is
 * a picture:
 *
 * 1. the **band of tables** `$8D05`-`$8E20` (§17), which `data/global.json`
 *    carries;
 * 2. the **table of reversed bits** at `$C500`, which the original does not
 *    load but *computes* at start-up (`$3939`: eight `ASL`/`ROR` a byte) —
 *    so the remake computes it too;
 * 3. the **sprite blocks** of `data/sprites.json` at their own addresses,
 *    because turning the agent round mirrors them **in place** (§13).
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} global - The parsed `data/global.json`.
 * @param {Object} sprites - The parsed `data/sprites.json`.
 */
function plSeedMemory(mem, global, sprites, furnitureData, terminalData, charsetShaft, m,
                     computerData, puzzleData, specialData) {
  var i, j, tables = [], key, at, bytes, x, a, bit;
  if (global) {
    var defaults = global.agent.defaults;
    if (defaults) {                              // `$9708`, šest bajtů (§13)
      at = parseInt(defaults.addr.replace('$', ''), 16);
      for (i = 0; i < defaults.pointers.length; i++) {
        mem[at + i] = defaults.pointers[i] & 0xFF;
        mem[at + defaults.pointers.length + i] = defaults.colors[i] & 0xFF;
      }
    }
    // ★ **Proud programů robotů `$2112`–`$232B`** (§17, §24). Není to
    // vylosovaná věc — losuje se **ukazatel** do něj (`druh` v záznamu
    // místnosti), sám proud je data programu a generátor do něj nesáhne
    // (změřeno na 256 záznamech). ★ A leží v něm i **skript koule** `$2232`.
    // Bez něj běží všichni roboti program samých nul: stejně rychle a jen
    // doprava, a koule se nehne vůbec — a **žádné `match*` na to nepřijde**,
    // protože každé měřidlo začíná z výpisu paměti originálu, kde ten proud
    // je (stalo se 2026-09-20).
    // ★ **Obřad umírání** (§31): barvy blikání `$9783` a masky rozpouštění
    // `$97E9` jsou zase **data programu**, a chyběly. S nulami je agent po
    // celý obřad **černý** (`$975B` mu sází barvu 0) a rozpouštění maže
    // celé bajty místo jednoho bitu, takže zmizí za osminu času — hráč tedy
    // vidí, jak agent zmizí hned a nová figurka se objeví na konci
    // zamrzlé scény. ★ **Žádné `match*` na to nedosáhne**: `matchdeath`
    // začíná z výpisu paměti originálu, kde obě tabulky jsou (§13; nahlásil
    // operátor 2026-09-21).
    var deathTables = global.death;
    if (deathTables) {
      var names = ['flash', 'masks'];
      for (i = 0; i < names.length; i++) {
        var t = deathTables[names[i]];
        at = parseInt(t.addr.replace('$', ''), 16);
        for (j = 0; j < t.values.length; j++) { mem[at + j] = t.values[j] & 0xFF; }
      }
    }
    var programs = global.robots && global.robots.programs;
    if (programs && programs.values) {
      at = parseInt(programs.addr.split('-')[0].replace('$', ''), 16);
      for (i = 0; i < programs.values.length; i++) {
        mem[at + i] = programs.values[i] & 0xFF;
      }
    }
    tables = tables.concat(global.somersault.tables, global.agent.tables);
    for (i = 0; i < tables.length; i++) {
      at = parseInt(tables[i].addr.replace('$', ''), 16);
      for (j = 0; j < tables[i].values.length; j++) {
        mem[at + j] = tables[i].values[j] & 0xFF;
      }
    }
  }
  // ★ `$3939`: `A` se osmkrát protočí přes `ASL $E4` a `ROR A`, takže z bajtu
  // vyjde **opačné pořadí bitů** — bit 7 skončí v nule a naopak. Pozor na
  // směr: smyčka, která bere bity zdola, dá **jednotkovou** tabulku a s ní se
  // agent nezrcadlí, jen si prohodí krajní bajty řádku, a rozsype se to (§13).
  for (x = 0; x < 256; x++) {
    a = 0;
    for (bit = 0; bit < 8; bit++) { a = (a >> 1) | (((x >> (7 - bit)) & 1) << 7); }
    mem[PL_FLIP + x] = a;
  }
  // ★ Tabulky a okna prohledávání (§27) — data programu, jako proud programů
  // robotů; bez nich se okno neotevře a ukazatel postupu je prázdný
  if (furnitureData && typeof furniture !== 'undefined') {
    furniture.seedMemory(mem, furnitureData);
  }
  // ★ A obrazovka a tabulky **bezpečnostního terminálu** (§29) — taky data
  // programu, bez kterých se terminál neotevře
  if (terminalData && typeof terminal !== 'undefined') {
    terminal.seedMemory(mem, terminalData);
  }
  // ★ A tabulky, texty a **šestnáct tvarů dílku** kapesního počítače (§34,
  // §15) — zase data programu, bez kterých se počítač neotevře a dílek se
  // nesloží
  if (typeof pocketComputer !== 'undefined') {
    pocketComputer.seedMemory(mem, computerData || null, puzzleData || null);
  }
  // ★ A **dvě zvláštní místnosti** (§35): osm tónů kódové místnosti
  // a obrázek řídicí, který vstup hry odstěhoval zpod programu (`$71C0`)
  if (typeof codeRoom !== 'undefined') { codeRoom.seedMemory(mem, specialData || null); }
  if (typeof controlRoom !== 'undefined') { controlRoom.seedMemory(mem, specialData || null); }
  // ★ **`$D024` = `$FA`** — vypadá to jako barva pozadí 3, ale v téhle hře
  // je to **příznak, který parkuje zavaděč** (§4): `$84EA` se ho ptá, a jen
  // když je `& $0F` rovno `$0A`, churne i `$E3`, ze kterého bere výšku
  // střílející robot (`$9244`). Bez toho má hlas 1 frekvenci nula a je němý.
  // Změřeno `$FA` ve všech záznamech (`build/trace/*_vic.bin`).
  if (m) { m.vic[0x24] = 0xFA; }

  // ★ **Znaková sada šachty na `$4800`** — a není to jen sada: mezi
  // prázdnými glyfy v ní leží **data programu** (§14), a jedno z nich je
  // `$4EF0`, kde start hry bere, jak vysoko v kabině agent stojí
  // (`plStartShaft`). Na stroji je to z diskety, tady z
  // `data/charset_shaft.json` — bez něj by agent začal na řádku nula.
  if (charsetShaft && charsetShaft.bytes) {
    at = charsetShaft.addr;
    for (i = 0; i < charsetShaft.bytes.length; i++) {
      mem[at + i] = charsetShaft.bytes[i] & 0xFF;
    }
  }
  if (sprites) {
    var blocks = sprites.blocks, keys = Object.keys(blocks);
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      at = parseInt(key.replace('$', ''), 16);
      bytes = blocks[key].bytes;
      for (j = 0; j < bytes.length; j++) { mem[at + j] = bytes[j]; }
    }
  }
} // plSeedMemory

/**
 * `$970E` — the three sprite pointers and the three sprite colours of the
 * agent, out of the six bytes at `$9708` (§13). The original does it outside
 * the room builder, and the start of a game does it too (`$397F`).
 * @param {Object} m - The machine.
 */
function plAgentColours(m) {
  for (var i = 0; i < 3; i++) {
    plStore(m, PL_POINTERS + i, plLoad(m, PL_DEFAULTS + i));
    plStore(m, PL_SPRITE_COLORS + i, plLoad(m, PL_DEFAULTS + 3 + i));
  }
} // plAgentColours

/**
 * ★ **A game starts in the shaft, not in a room** (`$3960`-`$3A12`): the
 * agent stands in the cabin under the ceiling of the fortress and the first
 * thing the player does is ride somewhere. Getting into a room takes walking
 * through a door (§21), and that is what the game is.
 *
 * What the original does between `$3960` and the shaft loop, in its order:
 *
 * | where | what |
 * |---|---|
 * | `$3960` | the shaft's character set (`$D018` = `$02`) and ★ the black border `$3967` keeps the whole game |
 * | `$396C` | the agent's three sprites: one column, `$AC`, and three heights out of **`$4EF0`** |
 * | `$397F` | `$970E` — his pointers and colours |
 * | `$3982` | standing (`$3F` = `$0E`), ★ **facing left** (`$50` = `$80`) and `$D016` = `$18` |
 * | `$398F` | the map shuffle and `$7236` — both already done when the fortress was shuffled (`init`) |
 * | `$3995` | `$72A2`, the shaft itself, seventeen lift steps and all (§22) |
 * | `$3998` | ★ `$7857` **unconditionally**: at the start the cabin is under the fortress's ceiling, so it is drawn and `$1D` goes to 1 |
 * | `$399B` | the cabin's colours, `$21` = `$02` and `$22` = `$0A` |
 * | `$39A3` | `$AFE5`, the cabin and the marker of the pocket computer |
 * | `$39A6` | ★ the clock starts at **twelve** (`$D4` = `$12`) |
 * | `$39EC` | `$D015` = `$CF` — the agent and the shaft's sprites, not the robots' |
 * | `$39F1` | `$731C`, the panel below the shaft — ★ **before the two spoken words**, so what is kept here is `$72E5`, which paints over what it draws |
 * | `$3A05`-`$3A12` | ★ `$7218` + `$B63B`: the window of the map and the map itself, and those come **after the speech** — `plStartShaftMap`, a step of its own |
 *
 * ★ **Two things of it are not transcribed** and this says so rather than
 * guessing: `$7294` (two bytes of `$3439`) and the body of `$731C` (the
 * panel's colours and a hundred draws out of the shuffle — `$72E5` paints
 * over what it draws, so what is kept here is only its three colour
 * registers). ★ **`$B63B` was the third of them, and wrongly so**: the
 * picture of the fortress is **losovaný**, so no character set on the disk
 * can carry it, and without the swap (`$B644`, `app/pocketComputer.js`) the
 * map in the panel is a wall of solid `$FC` blocks.
 * Nothing measures this routine: like `plSeedMemory`, it is the part of the
 * transcription every `match*` misses, because every recording starts from a
 * memory dump in which the game has long since started. `tools/runworker.mjs`
 * watches it and `tools/renderroom.mjs --shaft` draws it.
 *
 * @param {Object} m - The machine.
 */
/**
 * `$38D2`-`$3906` — what the game clears before it shuffles anything: the
 * zero page from `$10` to `$EA`, the SID, and then the handful of bytes it
 * wants non-zero.
 *
 * ★ **It belongs before the shuffle, not after it.** The map shuffle ends by
 * writing `$27`/`$28`, where the cabin starts (`$B2B3`, `app/fortressMap.js`),
 * and the seventeen lift steps that draw the shaft start from there. Clear
 * the zero page after the shuffle and the cabin starts at the top left of
 * the map instead: `$1E` comes out **3** (the shaft says it is at the
 * bottom), the doors stay at `$FF` and the lift will not move. That is one
 * wrong line, and nothing but the picture says so.
 *
 * @param {Uint8Array} mem - The machine's memory, before the fortress is shuffled.
 */
function plResetZeroPage(mem, m) {
  var x;
  for (x = 0x10; x <= 0xEA; x++) { mem[x] = 0; }
  // `$38F0` — a **celý SID na nulu**, `$D400`-`$D41C`. Hlasitost po něm
  // zůstane nulová, dokud ji někdo nenastaví: v místnosti to dělá krok
  // agenta (`$8E77`, `$D418` = 5), takže ticho to není.
  if (m) { for (x = 0; x <= 0x1C; x++) { plStore(m, 0xD400 + x, 0); } }
  mem[0x20] = 0xFF; mem[0x1F] = 0xFF;                    // `$38F6`, `$38F8`
  mem[0xE1] = 1; mem[0xE3] = 1;                          // `$38FA`
  mem[0x75] = 2; mem[0x76] = 2;
  mem[0x40] = 3;                                         // `$3906`
} // plResetZeroPage

/**
 * `$39BF`-`$39C1` — ★ **seznam nalezených dílků se ukončí `$FF`**, a je to
 * jediné, co ho zakládá: `$9964` ho prochází **dokud nenarazí na `$FF`**
 * a žádnou mez nemá (`$9966`-`$996C`). Kdo ho nezaloží, nechá první nález
 * běžet nultou stránkou dat dál, dokud nějaké `$FF` nepotká — a to bývá až
 * **v záznamech nábytku na `$4F55`**. Tam pak `$99AB` zapíše číslo dílku
 * přes `start_lo` některého kusu a `$996E` za něj `$FF`; při zavření okna
 * si `$9B28` z takového záznamu spočítá šířku `end_lo - start_lo` jako
 * **dvě stě dvacet osm** a vymaže čtyři řádky přes celou místnost — podlahu
 * i zeď (nahlásil operátor 2026-09-20: „při prohledávání několika kusů to
 * smazalo podlahu a udělalo díru v levé horní části místnosti").
 *
 * ★ **Žádné `match*` na to nedosáhne**: každé měřidlo začíná z výpisu
 * paměti originálu, kde `$4EF5` dávno `$FF` je — stejná slepá skvrna jako
 * u `player.seedMemory` (§13). Hlídá to `tools/runworker.mjs`.
 *
 * ★ A `Y` je v obou zápisech totéž `$FF` (kopírovací smyčka `$39B1` končí
 * na `CPY #$FF`), takže s ním jde i `$6D` — příznak koule, který si
 * stavitel místnosti stejně přepíše (`app/roomBuild.js`).
 *
 * @param {Object} m - The machine.
 */
function plNewGameLists(m) {
  plStore(m, PL_ORB, 0xFF);                              // `$39BF STY $6D`
  plStore(m, PL_FOUND, 0xFF);                            // `$39C1 STY $4EF5`
} // plNewGameLists

function plStartShaft(m, defer) {
  var x, y;
  // ★ **Za úvodní řečí neběží obsluha přerušení hry, ale `$838C`** (`$391E`
  // ji posadí do vektoru), a ta jen potvrdí rastr a zvedne `$E0`. Nedělá
  // tedy **rastrové clony**, takže je celá obrazovka jednou sadou a jednou
  // barvou pozadí — proto za řeči není vidět panel ani jeho jiné barvy
  // (§22, §24). Vrátí ji `$BF3A` na `$3A0E`, tedy až za řečí.
  plSetWord(m, PL_IRQ_VECTOR, PL_IRQ_PLAIN);             // `$391E`
  plStore(m, 0xD018, (plLoad(m, 0xD018) & 0xF0) | 0x02); // `$3960`
  plStore(m, 0xD020, 0x00);                              // `$3967`, a černý zůstane
  // `$396C` — `X` jde po dvou, takže to sází sprajty 1, 2 a 3 naráz
  // do registrů i do jejich stínu v nulté stránce
  for (x = 4; x >= 0; x -= 2) {
    plStore(m, 0xD002 + x, 0xAC);
    plStore(m, PL_SPRITES + x, 0xAC);
    y = plLoad(m, PL_START_Y + x);
    plStore(m, 0xD003 + x, y);
    plStore(m, PL_SPRITES + 1 + x, y);
  }
  plStore(m, PL_MSIGX, 0);
  plAgentColours(m);                                     // `$397F`
  plStore(m, PL_STATE, 0x0E);                            // `$3982`, stojí
  plStore(m, PL_FACING, 0x80);                           // `$3986`, kouká vlevo
  plStore(m, 0xD016, 0x18);                              // `$398A`
  plStore(m, PL_PLACE, 0);                               // šachta, `$1A` = 0

  shaftBuild.column(m, m.entropy);                       // `$3995` → `$72A2`
  shaftBuild.ceiling(m);                                 // `$3998` → `$7857`
  plStore(m, PL_CAB_COLOUR, 0x02);                       // `$399B`
  plStore(m, PL_CAB_MULTI, 0x0A);
  shaftBuild.sprites(m);                                 // `$39A3` → `$AFE5`
  plNewGameLists(m);                                     // `$39BF`, `$39C1`

  // ★ z `$731C` zůstane po `$72E5` jen tohle: pozadí a dvě sdílené barvy
  plStore(m, 0xD021, 0x0C);
  plStore(m, 0xD022, plLoad(m, PL_CAB_COLOUR));
  plStore(m, 0xD023, plLoad(m, PL_CAB_MULTI));

  plStore(m, PL_SPENA, 0xCF);                            // `$39EC`
  // ★ `$39F1 JSR $731C` **není spodní panel** — to je `$72E5` na `$3A08`,
  // tedy až za řečí. `$731C` dokreslí **šachtu pod oknem** (řádky 15-24)
  // a rozsvítí obraz, takže po celou úvodní řeč je na obrazovce jen
  // šachta, shora dolů (§22, změřeno zastávkou na `$39F4`).
  shaftBuild.bottom(m, m.entropy);                       // `$39F1` → `$731C`

  // ★ Latch kolizí se **čtením nuluje**, takže cokoli v něm zbylo by první
  // `$94FA` přečetlo jako kolizi, která se nestala (§30). V šachtě se sice
  // nesráží nic, ale hra z ní vyjde do místnosti a tam už ano.
  if (!m.noCollision) { coReset(m); }
  plStore(m, PL_STEP, 0);
  plStore(m, PL_TICK, 0);
  plStore(m, PL_DIVIDER, 3);                             // `$3906`
  plStore(m, PL_FALL, 0);
  plStore(m, PL_LANDED, 0);
  plStore(m, PL_DEATH, 0);
  plStore(m, PL_JUMP, 0);
  plStore(m, PL_LATCH, 0);
  plStore(m, PL_CLOCK_FRAMES, 0);
  plStore(m, PL_SECONDS, 0);
  plStore(m, PL_MINUTES, 0);
  plStore(m, PL_HOURS, 0x12);                            // `$39A6`, dvanáct
  plStore(m, PL_CLOCK_STOP, 0);
  m.pl = {deathFall: false, liftWait: 0, riding: 0, move: null, roomRide: null, search: null};
  plWritePointers(m);
  if (!defer) { plStartShaftMap(m); }
} // plStartShaft

/**
 * `$3A05`-`$3A12` — co hra udělá **až za úvodní řečí**: nakreslí **spodní
 * panel** (`$72E5`), vymaže v něm okno mapy (`$7218`) a pustí celé `$B63B`.
 * ★ Do té doby panel na obrazovce **není vůbec** — je tam šachta, kterou
 * pod oknem dokreslil `$731C` (§22).
 *
 * ★ Je to vlastní krok, protože mezi `$39F1` a `$3A05` stojí **dvě věty**
 * (`$39F4`, `$39FF`) a `$BF51` u obou čeká, až přehrávač domluví — na
 * originálu tedy mapa za řeči vidět **není** a objeví se teprve za ní
 * (nahlásil operátor 2026-09-21). Ve workeru to proto pustí až zpráva
 * `spoken` od čipu, ne rozběh.
 *
 * ★ A **dvakrát se to volat nesmí**: `$B644` odkládá okno sady do `$C690`,
 * takže by si podruhé odložilo samo sebe a kapesní počítač by se otevřel
 * s mapou místo s přihrádkami.
 *
 * @param {Object} m - The machine.
 */
function plStartShaftMap(m) {
  shaftBuild.panel(m);                                   // `$3A08` → `$72E5`
  shaftBuild.clearMap(m);                                // `$3A0B` → `$7218`
  plSetWord(m, PL_IRQ_VECTOR, PL_IRQ_GAME);              // `$3A0E` → `$BF3A`
  // ★ `$3A12` je celé `$B63B`, ne jen jeho kresba: **nejdřív se vymění okno
  // sady počítače** za obrázek mapy z `$FC00` (`$B644`, §14) a teprve pak se
  // mapa nakreslí. Obrázek se losuje s pevností, takže ho žádná sada nese
  // nemůže — bez téhle výměny jsou všechny znaky mapy prázdné a v panelu
  // svítí samé plné čtverce `$FC` (nahlásil operátor 2026-09-21).
  if (typeof pocketComputer !== 'undefined') { pocketComputer.mapWindow(m); }
  shaftBuild.map(m);                                     // `$3A12` → `$B68F`
  // ★ a za kresbou **značka kabiny** (`$B6FE`): blok sprajtu 6 se staví na
  // místě a `$43FE` dostane `$36`, jinak na mapě visí blok, který v `$43FE`
  // zrovna zbyl
  if (typeof pocketComputer !== 'undefined') { pocketComputer.mapMarker(m); }
} // plStartShaftMap

/**
 * A room with an agent in it, ready for its first frame.
 *
 * The builder is the original's (`$A39C`), so where the agent stands comes
 * out of the room's own record. What is **not** transcribed yet is the way
 * in: the original walks him in and wipes the room from `$C100` over to
 * `$4000` while he walks (which is why a trace has to start a good while
 * after the door — `tools/traceplayer.py`). Here the screen is copied in
 * one go and the agent starts standing. That is the one place this file
 * does not do what the original does, and it is the rest of M3.
 *
 * @param {Object} m - The machine.
 * @param {number} room - 0 to 31.
 * @param {number} side - 0 in from the left, 1 from the right.
 */
function plStartRoom(m, room, side) {
  buildRoom(m, room, side);
  for (var i = 0; i < 1000; i++) {
    m.mem[PL_SCREEN + i] = m.mem[0xC100 + i];
  }
  // `$970E`: ukazatele a **barvy** sprajtů agenta, a `$A35E`: které sprajty
  // místnost rozsvítí. Obojí dělá originál mimo stavitele, takže by to jinak
  // nedělal nikdo — a agent by byl černý a skoro celý zhasnutý.
  plAgentColours(m);
  plStore(m, PL_SPENA, plLoad(m, PL_ROOM_ENABLE));
  // ★ A pozadí: v místnosti ho nepíše ani stavitel, ani obsluha přerušení —
  // zůstane po **rastrovém kódu clony** (`$A388`), a ta tam nechá `$8D`,
  // první bajt záznamu místnosti (§21). Bez tohohle je místnost černá.
  plStore(m, 0xD021, plLoad(m, PL_SPLIT_COLOUR));
  // ★ A `$47` na `$FF` (`$8BA9`): stavitel ho shodil na nulu (`$A39E`)
  // a `$8ECA` roboty nepustí, dokud tam není `$FF` — v originálu to udělá
  // až konec přechodu do místnosti, a tohle je zkratka místo něj. Bez toho
  // roboti i koule stojí prvních **1 020 snímků** (`$47` se zvedá o jedna
  // každý čtvrtý), a ★ **žádné `match*` na to nedosáhne**: každé měřidlo
  // začíná z výpisu paměti originálu, kde je `$47` dávno `$FF` (§13).
  plStore(m, 0x47, 0xFF);
  // ★ A latch kolizí `$D01E` na nulu: je to registr, který se **čtením
  // nuluje**, takže cokoli, co v něm zbylo z předchozí místnosti nebo
  // z výpisu paměti, by první `$94FA` přečetlo jako kolizi, která se
  // nestala (`app/collision.js`, §30).
  if (!m.noCollision) { coReset(m); }
  plStore(m, PL_PLACE, 1);
  // ★ A seznam nálezů taky (`$39C1`): do místnosti se v **hře** jde ze
  // šachty, kde ho založí `plStartShaft`, ale prohlížečka místností (`dev`)
  // a `tools/renderroom.mjs --play` začínají rovnou tady — a bez něj by se
  // první nalezený dílek zapsal do záznamů nábytku (viz `plNewGameLists`).
  plNewGameLists(m);
  plStore(m, PL_STATE, 0x0E);                    // stojí
  plStore(m, PL_FACING, side ? 0x80 : 0x01);
  plStore(m, PL_STEP, 0);
  plStore(m, PL_TICK, 0);
  plStore(m, PL_DIVIDER, 3);                     // `$3906`, krok každý třetí
  plStore(m, PL_FALL, 0);
  plStore(m, PL_LANDED, 0);
  plStore(m, PL_DEATH, 0);
  plStore(m, PL_JUMP, 0);
  plStore(m, PL_LATCH, 0);
  plStore(m, PL_CLOCK_FRAMES, 0);
  plStore(m, PL_SECONDS, 0);
  plStore(m, PL_MINUTES, 0);
  plStore(m, PL_HOURS, 0x12);                    // `$39A6`, dvanáct hodin
  plStore(m, PL_CLOCK_STOP, 0);
  m.pl = {deathFall: false, liftWait: 0, riding: 0, move: null, roomRide: null, search: null};
  plWritePointers(m);
  plWriteSprites(m);
} // plStartRoom

/**
 * What the picture needs after a frame: where the agent's three sprites are
 * and which blocks they show.
 * @param {Object} m - The machine.
 * @returns {Object} The agent, as the VIC would have him.
 */
function plAgentView(m) {
  var msb = plLoad(m, PL_MSIGX), i,
      out = {x: [], y: [], pointer: [], blocks: [], color: []};
  for (i = 0; i < 3; i++) {
    out.x.push(plLoad(m, PL_SPRITES + i*2) | (((msb >> (i + 1)) & 1) << 8));
    out.y.push(plLoad(m, PL_SPRITES + 1 + i*2));
    out.pointer.push(plLoad(m, PL_POINTERS + i));
    out.blocks.push(plBlock(m, plLoad(m, PL_POINTERS + i)));
  }
  // ★ Jak má agent vypadat, **říká stroj, ne postavená místnost**: barvy na
  // `$D028` sází `$970E` až po stavbě a sprajty 1-3 jsou v obou smyčkách
  // hires (`$D01C` je `$F1` v místnosti a `$01` v šachtě, §13).
  for (i = 0; i < 3; i++) { out.color.push(plLoad(m, PL_SPRITE_COLORS + i) & 0x0F); }
  return {sprites: out, state: plLoad(m, PL_STATE), facing: plLoad(m, PL_FACING),
          place: plLoad(m, PL_PLACE), falling: plLoad(m, PL_FALL),
          death: plLoad(m, PL_DEATH), enabled: plLoad(m, 0xD015),
          multicolor: plLoad(m, 0xD01C), expandX: plLoad(m, 0xD01D),
          expandY: plLoad(m, 0xD017),
          shared: [plLoad(m, 0xD025) & 0x0F, plLoad(m, 0xD026) & 0x0F],
          clock: {hours: plLoad(m, PL_HOURS), minutes: plLoad(m, PL_MINUTES),
                  seconds: plLoad(m, PL_SECONDS)}};
} // plAgentView

/**
 * The 64 bytes a sprite pointer points at. ★ Pointers count from the start
 * of VIC bank 1, `$4000` (§13), and the agent's blocks are mirrored in
 * memory as he turns, so they are read **from the machine**, never from the
 * file.
 * @param {Object} m - The machine.
 * @param {number} pointer - 0 to 255.
 * @returns {number[]} The block.
 */
function plBlock(m, pointer) {
  var at = 0x4000 + pointer*64, out = [], i;
  for (i = 0; i < 64; i++) { out.push(plLoad(m, at + i)); }
  return out;
} // plBlock

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var player = {
  frame: plFrame, loop: plLoop, agentStep: plAgentStep, clock: plClock,
  clockAdd: plClockAdd,
  ride: plRide, entropy: plEntropy, writePointers: plWritePointers,
  seedMemory: plSeedMemory, resetZeroPage: plResetZeroPage,
  startRoom: plStartRoom, startShaft: plStartShaft, startShaftMap: plStartShaftMap, startDying: plStartDying, view: plAgentView, block: plBlock,
  topEdge: plTopEdge, bottomEdge: plBottomEdge,
  leftEdge: plLeftEdge, rightEdge: plRightEdge, cell: plCell,
  searchProbe: plSearchProbe, floorCheck: plFloorCheck,
  SCREEN: PL_SCREEN, STATE: PL_STATE, SPRITES: PL_SPRITES
};
if (typeof self !== 'undefined') {
  self.player = player;
  // `app/transition.js` dosazuje agenta do nové místnosti týmž `$8727`
  self.plWritePointers = plWritePointers;
  // `app/furniture.js` počítá hrany agenta touž rutinou jako jeho krok
  self.plBottomEdge = plBottomEdge;
  self.plTopEdge = plTopEdge;
  self.plLeftEdge = plLeftEdge;
  self.plRightEdge = plRightEdge;
  self.plCell = plCell;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = player; }
