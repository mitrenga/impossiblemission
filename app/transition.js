// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The door — what happens between the two loops of the game
 * (`sources/docs/disasm_notes.md` §21).
 *
 * ★ A transition is **not an instant**, it is sixty-two frames, and the main
 * loop does not run in any of them. Measured on the original
 * (`tools/tracedoor.py`, seed `$42`), walking out of the shaft into a room:
 *
 * | frames | what runs | how it shows |
 * |---|---|---|
 * | 1 + 24 | `$A248` — the room is **wiped to blanks** from row 12 outward, two rows every two frames | `$1A` still 0 |
 * | 1 | `$A39C` — the new room is built into `$C100` | `$1A` = 2 |
 * | 12 | `$8BA1` — a plain wait (`LDA #$0C`, `JSR $7F6D`) | `$1A` = 2 |
 * | 1 + 24 | `$A2ED` — the room is **uncovered** from both edges towards the middle, `$C100` to `$4000`, two rows every two frames | `$1A` = 1 |
 *
 * ★ And the **last** of those frames is the one that stands the agent up
 * (`$A357`: `$3F` = `$0E`, `$8727`, `$D015` = `$8E`); the loop's first pass
 * comes the frame after. That is why `plStartRoom` could not simply copy the
 * screen in one go and call it a room — it was the one place `player.js` did
 * not do what the original does (`ZADANI.md` §10.5), and this file is what
 * removes it.
 *
 * ★ Which way the wipes run is worth keeping straight, because they are not
 * mirror images: the **cover** starts in the middle of the screen (`$41E0`,
 * row 12) and walks outwards, the **uncover** starts at both edges (row 0
 * and row 24) and walks inwards. Both move two rows at a time and both are
 * gated on `$E0` going up by two (`$A27A`, `$A318`), so the picture changes
 * at 25 rows a second.
 *
 * Only the way **in** to a room is here. The way out into the shaft
 * (`$8BEB`, `$AF3F`) needs the shaft's screen built from scratch, and that is
 * the next piece of M3.
 */

/** where the agent is: 0 shaft, 1 room, 2 room being built (§19) */
var TR_PLACE = 0x1A;

/** the room being entered and which side of it the agent comes in on */
var TR_ROOM = 0x7E, TR_SIDE = 0x7F;

/** the two pointers a wipe carries, and the two raster lines it paints between */
var TR_DST = 0x10, TR_SRC = 0x12, TR_DST2 = 0x14, TR_SRC2 = 0x16;
var TR_TOP = 0x8B, TR_BOTTOM = 0x8C;

/** the cabin in the fortress, and the grid the map shuffle left (§11) */
var TR_CAB_X = 0x27, TR_CAB_Y = 0x28, TR_GRID = 0xFF96;

/** the screen of the game, the room the builder builds into, and a blank */
var TR_SCREEN = 0x4000, TR_BUILT = 0xC100, TR_BLANK = 0x53;

/** the colour of the split, `$8D` — and in a room that is its background */
var TR_SPLIT_COLOUR = 0x8D;

/** the frame counter of the interrupt, and what the room turns its sprites on with */
var TR_FRAME = 0xE0, TR_ROOM_ENABLE = 0x8E;

/** how long the plain wait between building and uncovering is (`$8BA1`) */
var TR_WAIT = 0x0C;

function trByte(v) { return v & 0xFF; }
function trLoad(m, a) { return rbLoad(m, a); }
function trStore(m, a, v) { rbStore(m, a, v); }
function trWord(m, a) { return trLoad(m, a) | (trLoad(m, a + 1) << 8); }

/**
 * `$A2E1` — two rows of the screen wiped to blanks, the one `$10` points at
 * and the one `$12` points at.
 * @param {Object} m - The machine.
 */
function trBlankRows(m) {
  var dst = trWord(m, TR_DST), src = trWord(m, TR_SRC), y;
  for (y = 0x27; y >= 0; y--) {
    trStore(m, dst + y, TR_BLANK);
    trStore(m, src + y, TR_BLANK);
  }
} // trBlankRows

/**
 * `$A38E` — two rows copied out of the built room, the one at `$10` from the
 * one at `$12`, and the one at `$14` from the one at `$16`.
 * @param {Object} m - The machine.
 */
function trCopyRows(m) {
  var dst = trWord(m, TR_DST), src = trWord(m, TR_SRC);
  var dst2 = trWord(m, TR_DST2), src2 = trWord(m, TR_SRC2), y;
  for (y = 0x27; y >= 0; y--) {
    trStore(m, dst + y, trLoad(m, src + y));
    trStore(m, dst2 + y, trLoad(m, src2 + y));
  }
} // trCopyRows

/**
 * `$A248` — the curtain closes. Sets up the two pointers at row 12 and the
 * two raster lines in the middle of the screen, and turns the sprites and
 * the SID off; the steps themselves are `trCoverStep`.
 * @param {Object} m - The machine.
 */
function trCoverStart(m) {
  trStore(m, 0x47, 0);
  trStore(m, 0xD404, 0); trStore(m, 0xD40B, 0); trStore(m, 0xD412, 0);
  trStore(m, TR_DST, 0xE0); trStore(m, TR_SRC, 0xE0);      // obojí `$41E0`
  trStore(m, TR_DST + 1, 0x41); trStore(m, TR_SRC + 1, 0x41);
  trStore(m, TR_TOP, 0x9A); trStore(m, TR_BOTTOM, 0x94);
  trStore(m, 0xE4, trLoad(m, 0xD021));
  trStore(m, 0xE7, trLoad(m, 0xD021));
  trStore(m, 0xD015, 0);
} // trCoverStart

/**
 * `$A284` — one step of the curtain closing: two rows blanked, the pointers
 * walk apart, the black band grows by eight raster lines each way.
 * @param {Object} m - The machine.
 * @returns {boolean} True when the screen is blank and the wipe is over.
 */
function trCoverStep(m) {
  trBlankRows(m);
  var lo = trLoad(m, TR_DST) - 0x28;                       // `$A289`, nahoru
  trStore(m, TR_DST, lo);
  if (lo < 0) { trStore(m, TR_DST + 1, trByte(trLoad(m, TR_DST + 1) - 1)); }
  lo = trLoad(m, TR_SRC) + 0x28;                           // `$A294`, dolů
  trStore(m, TR_SRC, lo);
  if (lo > 0xFF) { trStore(m, TR_SRC + 1, trByte(trLoad(m, TR_SRC + 1) + 1)); }
  trStore(m, TR_TOP, trByte(trLoad(m, TR_TOP) - 8));
  var bottom = trByte(trLoad(m, TR_BOTTOM) + 8);
  trStore(m, TR_BOTTOM, bottom);
  if (bottom < 0xFB) { return false; }
  trStore(m, 0xD021, 0);                                   // `$A2B1`
  return true;
} // trCoverStep

/**
 * `$A2ED` — the curtain opens. The built room sits in `$C100`, the screen is
 * `$4000`, and the two pairs of pointers start at the top and the bottom of
 * the picture and walk towards each other. ★ It is also where the room stops
 * being *built* and starts being *played*: `DEC $1A` takes 2 down to 1.
 * @param {Object} m - The machine.
 */
function trUncoverStart(m) {
  trStore(m, TR_DST, 0x00); trStore(m, TR_DST + 1, 0x40);        // `$4000`
  trStore(m, TR_SRC, 0x00); trStore(m, TR_SRC + 1, 0xC1);        // `$C100`
  trStore(m, TR_DST2, 0xC0); trStore(m, TR_DST2 + 1, 0x43);      // `$43C0`
  trStore(m, TR_SRC2, 0xC0); trStore(m, TR_SRC2 + 1, 0xC4);      // `$C4C0`
  trStore(m, TR_TOP, 0x32); trStore(m, TR_BOTTOM, 0xFC);
  trStore(m, TR_PLACE, trByte(trLoad(m, TR_PLACE) - 1));
} // trUncoverStart

/**
 * `$A322` — one step of the curtain opening. ★ The low byte is **shared**
 * between the screen pointer and the source pointer (`STA $10`, `STA $12`),
 * only the high bytes differ, and the same trick again for the pair coming
 * up from the bottom.
 * @param {Object} m - The machine.
 * @returns {boolean} True when the two halves have met.
 */
function trUncoverStep(m) {
  trCopyRows(m);
  var lo = trLoad(m, TR_DST) + 0x28;                       // `$A327`, dolů
  trStore(m, TR_DST, lo); trStore(m, TR_SRC, lo);
  if (lo > 0xFF) {
    trStore(m, TR_DST + 1, trByte(trLoad(m, TR_DST + 1) + 1));
    trStore(m, TR_SRC + 1, trByte(trLoad(m, TR_SRC + 1) + 1));
  }
  lo = trLoad(m, TR_DST2) - 0x28;                          // `$A336`, nahoru
  trStore(m, TR_DST2, lo); trStore(m, TR_SRC2, lo);
  if (lo < 0) {
    trStore(m, TR_DST2 + 1, trByte(trLoad(m, TR_DST2 + 1) - 1));
    trStore(m, TR_SRC2 + 1, trByte(trLoad(m, TR_SRC2 + 1) - 1));
  }
  trStore(m, TR_BOTTOM, trByte(trLoad(m, TR_BOTTOM) - 8));
  var top = trByte(trLoad(m, TR_TOP) + 8);
  trStore(m, TR_TOP, top);
  // ★ `$A373`/`$A388`: **pozadí místnosti je `$8D`**, první bajt jejího
  // záznamu, a zapisuje ho **rastrový kód clony**, ne stavitel. V místnosti
  // (`$1A` ≠ 0) se obsluha přerušení na barvy pozadí vůbec nepodívá
  // (`$82F8`, `$8374`), takže co tu zůstane, to místnost má.
  trStore(m, 0xD021, trLoad(m, TR_SPLIT_COLOUR));
  return top >= trLoad(m, TR_BOTTOM);
} // trUncoverStep

/**
 * `$8B8E` / `$8B94` — the agent has walked off the side of the shaft, so the
 * room on that side is the one he is going into. Which room it is comes out
 * of the grid the map shuffle left at `$FF96` (§11): the square the cabin is
 * in, and the one after it when he leaves to the right.
 *
 * @param {Object} m - The machine.
 * @param {number} way - 1 out to the right, -1 out to the left.
 * @returns {Object} The state a frame of the transition runs on.
 */
function trEnterRoom(m, way) {
  var a = trLoad(m, TR_CAB_Y) - 0xB8;                      // `$78B0`
  var index = elGridIndex(m, trByte(a), a >= 0 ? 1 : 0);
  if (way > 0) {
    index = trByte(index + 1);                             // `$8B91 INY`
    trStore(m, TR_SIDE, 0);                                // vchází se zleva
  } else {
    trStore(m, TR_CAB_X, trByte(trLoad(m, TR_CAB_X) - 0x10));   // `$8BDF`
    trStore(m, TR_SIDE, 1);                                // vchází se zprava
  }
  trStore(m, TR_ROOM, trLoad(m, (TR_GRID + index) & 0xFFFF));
  // ★ `$A275` si odloží `$E0` a hned skočí na `$A284`, takže **první krok
  // clony padne do téhož snímku**, ve kterém agent ze strany odešel
  trCoverStart(m);
  var move = {phase: 'cover', due: trByte(trLoad(m, TR_FRAME) + 2), step: 1};
  if (trCoverStep(m)) { move.phase = 'clear'; }
  return move;
} // trEnterRoom

/**
 * `$8BEB` / `$8BF1` — the agent has walked off the side of a room, so he is
 * going into the shaft. ★ The original **waits a frame first** (`$8BF3`) and
 * only then puts him down: `$8BEB` says where, `X` into the ninth bits and
 * `Y` into the x of all three sprites — `$0E`/`$51` coming out to the left,
 * `$00`/`$08` coming out to the right (`$8B86`).
 *
 * @param {Object} m - The machine.
 * @param {number} way - 1 out to the right, -1 out to the left.
 * @returns {Object} The state a frame of the transition runs on.
 */
function trEnterShaft(m, way) {
  if (way > 0) {                                         // `$8B7F`, doprava
    trStore(m, TR_CAB_X, trByte(trLoad(m, TR_CAB_X) + 0x10));
    return {phase: 'shaftWait', msb: 0x00, x: 0x08, from: 1};
  }
  return {phase: 'shaftWait', msb: 0x0E, x: 0x51, from: 0};   // `$8BEB`, doleva
} // trEnterShaft

/**
 * `$8BF1` — a frame later, the agent is put down, the sprites go out, and
 * ★ `$8C14` may move the cabin a **whole four squares** up or down: a room
 * numbered `$08`-`$0F` is a tall one and the shaft meets it at the other
 * end, so which way depends on the room's bottom bit against `$7F`.
 * @param {Object} m - The machine.
 * @param {Object} move - What `trEnterShaft` returned.
 */
function trPlaceInShaft(m, move) {
  trStore(m, 0x80, move.from);
  trStore(m, 0x32, move.msb);
  trStore(m, 0x2C, move.x); trStore(m, 0x2E, move.x); trStore(m, 0x30, move.x);
  trStore(m, 0xD015, 0);
  var a = trLoad(m, TR_CAB_Y) - 0xB8;                    // `$78B0`
  var index = elGridIndex(m, trByte(a), a >= 0 ? 1 : 0);
  trStore(m, 0x2B, trByte(index + trLoad(m, TR_SIDE)));
  // ★ `$B74C` **nekončí u `$E6`** — propadá se rovnou do `$B757`, tedy do
  // značky kabiny na mapě (§20). Kdo to přehlédne, má `$E4`/`$E5` jinak.
  var side = trLoad(m, TR_SIDE);
  var e6 = side === move.from ? (side ^ 1) : side;
  trStore(m, 0xE6, trByte(e6 << 1));
  elMarkCabin(m);                                        // `$B757`
  if (move.from !== side) {                              // `$8C0E`
    var room = trLoad(m, (TR_GRID + trLoad(m, 0x2B)) & 0xFFFF);
    if (room < 0x10 && room >= 0x08) {
      if (((room & 1) ^ side) === 0) {
        trStore(m, TR_CAB_Y, trByte(trLoad(m, TR_CAB_Y) + 4));
      } else {
        trStore(m, TR_CAB_Y, trByte(trLoad(m, TR_CAB_Y) - 4));
      }
    }
  }
  trCoverStart(m);                                       // `$8C36`
  move.phase = 'cover';
  move.into = 'shaft';
  move.due = trByte(trLoad(m, TR_FRAME) + 2);
  move.step = 1;
  if (trCoverStep(m)) { move.phase = 'shaftHead'; }
} // trPlaceInShaft

/**
 * One frame of a transition, which is the only thing that happens in it: the
 * main loop of the game does not run while this does.
 *
 * ★ Both wipes are gated the same way — `$A27A` and `$A318` hold a copy of
 * `$E0` from two frames ahead and only move when the interrupt has caught up,
 * so a step lands every **second** frame. The frame the wipe is started on
 * carries its first step.
 *
 * @param {Object} m - The machine.
 * @param {Object} move - What `trEnterRoom` returned.
 * @returns {boolean} True when the transition is over and the loop may run.
 */
function trFrame(m, move) {
  if (move.phase === 'shaftWait') {                      // `$8BF3`, jeden snímek
    trPlaceInShaft(m, move);
    return false;
  }
  if (move.phase === 'shaftHead') {                      // `$AF3F` po `$AF75`
    sbBuildHead(m);
    move.phase = 'shaftBody';
    return false;
  }
  if (move.phase === 'shaftBody') {
    sbBuildShaft(m, move.entropy);                       // zbytek `$AF3F`
    trUncoverStart(m);                                   // `$A2ED`, `$1A` -= 1
    move.phase = 'uncover';
    move.step = 0;
    move.due = trLoad(m, TR_FRAME);
  }
  if (move.phase === 'cover') {
    if (trLoad(m, TR_FRAME) !== move.due) { return false; }
    move.step++;
    move.due = trByte(trLoad(m, TR_FRAME) + 2);
    if (!trCoverStep(m)) { return false; }
    move.phase = move.into === 'shaft' ? 'shaftHead' : 'clear';
    return false;
  }
  if (move.phase === 'clear') {
    // `$A39C` až po `$A3C3`: `$1A` += 2 a místnost se vyprázdní
    buildRoom(m, trLoad(m, TR_ROOM), trLoad(m, TR_SIDE), 1);
    move.phase = 'build';
    return false;
  }
  if (move.phase === 'build') {
    buildRoom(m, 0, 0, 2);                                 // zbytek `$A39C`
    move.phase = 'wait';                                   // `$8BA1`, dvanáct snímků
    move.due = trByte(trLoad(m, TR_FRAME) + TR_WAIT);
    return false;
  }
  if (move.phase === 'wait') {
    if (trLoad(m, TR_FRAME) !== move.due) { return false; }
    trUncoverStart(m);                                     // `$A2ED`, `$1A` -= 1
    move.phase = 'uncover';
    move.step = 0;
  }
  if (trLoad(m, TR_FRAME) !== move.due && move.step) { return false; }
  move.step++;
  move.due = trByte(trLoad(m, TR_FRAME) + 2);
  if (!trUncoverStep(m)) { return false; }
  // ★ `$8BA9 LDX #$FF / STX $47` — **roboti se probouzejí až tady.**
  // Stavitel místnosti shodil `$47` na nulu (`$A39E`) a `$8ECA` roboty
  // nepustí, dokud není `$FF` (zvedá ho po jedné každý čtvrtý snímek, tedy
  // 1 020 snímků). Do šachty (`$8C36`) se `$47` nesází, protože tam roboti
  // neběží — obsluha přerušení ten úsek přeskočí (§5).
  if (move.into !== 'shaft') { trStore(m, 0x47, 0xFF); }
  // `$A357` — a teprve **posledním snímkem** přechodu agent vstane
  trStore(m, 0x3F, 0x0E);
  plWritePointers(m);                                      // `$8727`
  trStore(m, 0xD015, trLoad(m, TR_ROOM_ENABLE));
  return true;
} // trFrame

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var transition = {
  enterRoom: trEnterRoom, enterShaft: trEnterShaft, frame: trFrame,
  coverStart: trCoverStart, coverStep: trCoverStep,
  uncoverStart: trUncoverStart, uncoverStep: trUncoverStep,
  SCREEN: TR_SCREEN, BUILT: TR_BUILT, BLANK: TR_BLANK
};
// ve workeru je `self` globál, takže tyhle řádky nic nemění; pod Node je každý
// klasický skript ve vlastní obálce a bez nich by ho sourozenci neviděli
if (typeof self !== 'undefined') {
  self.transition = transition;
  self.trEnterRoom = trEnterRoom;
  self.trEnterShaft = trEnterShaft;
  self.trFrame = trFrame;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = transition; }
