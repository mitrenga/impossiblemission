// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * A room of the fortress is not stored as a picture. The original keeps a
 * short record per room — colours, floors, shafts, where the agent comes in,
 * which robots patrol it, what furniture stands where — and **draws** it into
 * the screen at `$C100` every time the agent walks in. The routine that does
 * it is `$A39C`, called from `$8B9E` right after `$8B96` takes the room
 * number out of the fortress map (`sources/docs/disasm_notes.md` §12).
 *
 * This is that routine, transcribed. Like the two generators it works on the
 * machine's memory, because that is what makes it provable: run it on the
 * memory the original had when it entered `$A39C` and every byte it writes
 * has to come out the same (`tools/matchrooms.mjs`).
 *
 * Screen memory, colour memory and the VIC registers are three different
 * things at three different addresses, so they are passed as one machine
 * object and every store goes through `rbStore`. Zero page stays in `mem`,
 * down to the scratch bytes, so the comparison covers it too.
 */

/** the room's screen and its colour memory (routine `$AC1B`) */
var RB_SCREEN = 0xC100;
var RB_COLOR = 0xD800;

/** pointers to the 32 room records, two bytes each (`$A3D0`) */
var RB_ROOM_PTRS = 0x0E70;

/** the furniture shapes: 5 bytes per kind, then the colour and char blocks */
var RB_SHAPES = 0x232C;

/** the three characters of a shaft tile, and the pair a wall is made of */
var RB_LIFT_TILE = 0x0DB4;

/** masks for the ninth bit of a sprite's x, one per robot sprite (`$0E6C`) */
var RB_MSIGX_MASKS = 0x0E6C;

/** the two rooms that are control rooms and get their own furniture (`$A5BE`) */
/** ★ **kódové** místnosti, ne řídicí (§35) — `$11` a `$1B` */
var RB_CODE_ROOMS = [0x11, 0x1B];

/** characters the floors, walls and blank cells are made of */
var RB_FLOOR_LEFT = 0x45, RB_FLOOR_RIGHT = 0x46;
var RB_WALL_LEFT = 0x47, RB_WALL_RIGHT = 0x48;
var RB_BLANK = 0x53;

/** the furniture record the search code reads, six bytes per piece (`$4F55`) */
var RB_FURNITURE_RECORDS = 0x4F55;

/**
 * One store, routed the way the machine routes it: colour memory and the VIC
 * registers are not RAM, everything else is.
 *
 * @param {{mem: Uint8Array, color: Uint8Array, vic: Uint8Array}} m - The machine.
 * @param {number} addr - Where to store.
 * @param {number} value - What to store.
 */
function rbStore(m, addr, value) {
  addr &= 0xFFFF; value &= 0xFF;
  if (addr >= 0xD000 && addr <= 0xDFFF) {
    // ★ hra má I/O nahoře, takže sem se nepíše do RAM. Stane se to: stavitel
    // vede ukazatele obrazovky i nad $C100 a barvy nad $D800, a když místnost
    // kreslí šachtu od horního okraje, kus jich spadne pod ně (měřeno).
    if (addr < 0xD400) { var reg = addr & 0x3F; if (reg <= 0x2E) { m.vic[reg] = value; } return; }
    // ★ M6: zápisy do SID se **sbírají** (`app/sound.js`), ne zahazují — díky
    // tomu je slyšet i to, co napsala rutina přepsaná dávno před M6.
    if (addr <= 0xD418) { sndPoke(m, addr - 0xD400, value); return; }
    if (addr >= 0xD800 && addr <= 0xDBFF) { m.color[addr - 0xD800] = value; return; }
    return;                                  // CIA: do srovnání nevstupuje
  }
  m.mem[addr] = value;
} // rbStore

/**
 * One load, routed the same way.
 * @param {{mem: Uint8Array, color: Uint8Array, vic: Uint8Array}} m - The machine.
 * @param {number} addr - Where to read.
 * @returns {number} The byte.
 */
function rbLoad(m, addr) {
  addr &= 0xFFFF;
  if (addr >= 0xD000 && addr <= 0xDFFF) {
    if (addr < 0xD400) { var reg = addr & 0x3F; return reg <= 0x2E ? m.vic[reg] : 0xFF; }
    if (addr >= 0xD800 && addr <= 0xDBFF) { return m.color[addr - 0xD800] | 0xF0; }
    return 0xFF;
  }
  return m.mem[addr];
} // rbLoad

/** the zero page pointers the original carries the drawing position in */
function rbGet16(mem, zp) { return mem[zp] | mem[zp + 1] << 8; }
function rbSet16(mem, zp, v) { mem[zp] = v & 0xFF; mem[zp + 1] = (v >> 8) & 0xFF; }

/**
 * `$AF2F`: one row down, screen and colour pointer together.
 * @param {Uint8Array} mem - The machine's memory.
 */
function rbNextRow(mem) {
  var a = mem[0x10] + 0x28;
  mem[0x10] = mem[0x14] = a & 0xFF;
  if (a > 0xFF) { mem[0x11] = (mem[0x11] + 1) & 0xFF; mem[0x15] = (mem[0x15] + 1) & 0xFF; }
} // rbNextRow

/**
 * `$AEEB`: six rows up — the spacing of the stops on a shaft.
 * @param {Uint8Array} mem - The machine's memory.
 */
function rbUpSixRows(mem) {
  var a = mem[0x10] - 0xF0;
  mem[0x10] = mem[0x14] = a & 0xFF;
  if (a < 0) { mem[0x11] = (mem[0x11] - 1) & 0xFF; mem[0x15] = (mem[0x15] - 1) & 0xFF; }
} // rbUpSixRows

/**
 * `$AC1B`: a (row, column) pair from the record turned into a screen and a
 * colour address — `$C100 + row*40 + column` and the same offset at `$D800`.
 * The original multiplies by 40 as `*8 + *32` and keeps the overflow in `$E5`,
 * which the robot code reads afterwards, so it is kept.
 *
 * @param {{mem: Uint8Array}} m - The machine.
 * @param {{at: number}} cur - The read position in the record ($81/$82 + Y).
 */
function rbCellAddress(m, cur) {
  var mem = m.mem;
  mem[0xE5] = 0;
  var a = mem[cur.at]; cur.at++;
  a = (a << 3) & 0xFF;                       // ASL x3, row*8
  mem[0xE4] = a;
  var hi = 0;
  a <<= 1; hi = (hi << 1) | (a > 0xFF ? 1 : 0); a &= 0xFF;    // ASL / ROL $E5
  a <<= 1; hi = (hi << 1) | (a > 0xFF ? 1 : 0); a &= 0xFF;    // ASL / ROL $E5
  mem[0xE5] = hi;
  a += mem[0xE4];
  if (a > 0xFF) { a &= 0xFF; mem[0xE5]++; }
  a += mem[cur.at];
  if (a > 0xFF) { a &= 0xFF; mem[0xE5]++; }
  mem[0x10] = mem[0x14] = a;
  mem[0x11] = (mem[0xE5] + 0xC1) & 0xFF;
  mem[0x15] = (mem[0xE5] + 0xD8) & 0xFF;
} // rbCellAddress

/**
 * `$AC4E`: the three characters of one shaft tile, in the colour `$84`.
 * @param {{mem: Uint8Array}} m - The machine.
 */
function rbLiftTile(m) {
  for (var y = 2; y >= 0; y--) {
    rbStore(m, rbGet16(m.mem, 0x10) + y, m.mem[RB_LIFT_TILE + y]);
    rbStore(m, rbGet16(m.mem, 0x14) + y, m.mem[0x84]);
  }
} // rbLiftTile

/**
 * `$ABDB` — where the agent stands when the room starts: one entry from the
 * left and one from the right, told apart by `$7F`.
 *
 * ★ It is its own routine because **two things call it**: the builder when
 * the room goes up, and `$96AE` when the agent has died and the room stays
 * where it is (§31). The record is read the same way both times.
 *
 * @param {Object} m - The machine.
 * @param {number} at - Where the six bytes of the entry begin.
 * @param {number} side - `$7F`: 0 from the left, otherwise from the right.
 */
function rbAgentEntry(m, at, side) {
  var mem = m.mem, base = at;
  if (side) { base++; }
  var agentX = mem[base];
  rbStore(m, 0xD002, agentX); rbStore(m, 0xD004, agentX); rbStore(m, 0xD006, agentX);
  mem[0x2C] = mem[0x2E] = mem[0x30] = agentX;
  var agentY = mem[base + 2];
  rbStore(m, 0xD005, agentY); mem[0x2F] = agentY;
  var y1 = (agentY + 0x0C) & 0xFF;
  rbStore(m, 0xD003, y1); mem[0x2D] = y1;
  var y3 = (y1 + 0x09) & 0xFF;
  rbStore(m, 0xD007, y3); mem[0x31] = y3;
  var msig = mem[base + 4];
  rbStore(m, 0xD010, msig);
  mem[0x32] = msig & 0x0E;
} // rbAgentEntry

/**
 * `$A68B` — the robots of the room out of its record, three bytes each:
 * kind, row, column. ★ The `kind` is a **pointer into the stream of
 * programs at `$2112`** (§24), which the shuffle wrote; it is not a species.
 * Called by the builder and again by `$96A5` after a death (§31).
 * @param {Object} m - The machine.
 * @param {number} at - Where the robot section begins.
 * @returns {{at: number, count: number}} Where it ended, past the `$FF`, and
 *   how many robots the room has.
 */
function rbRobots(m, at) {
  var mem = m.mem, x, count = 0;
  rbStore(m, 0x43FC, 0xC0); rbStore(m, 0x43FD, 0xC0);
  rbStore(m, 0x43FE, 0xC0); rbStore(m, 0x43FF, 0xC0);
  rbStore(m, 0xD01C, 0xF0);
  rbStore(m, 0xD01D, 0x00);
  rbStore(m, 0xD017, 0x00);
  mem[0x81] = mem[0x18]; mem[0x82] = mem[0x19];
  mem[0x54] = 0xFF;
  mem[0xE6] = 0;
  x = 0;
  for (;;) {
    var kind = mem[at++];
    if (kind === 0xFF) { break; }
    count++;
    mem[(0x55 + x) & 0xFF] = kind;
    mem[(0x56 + x) & 0xFF] = 0x01;
    mem[(0x57 + x) & 0xFF] = 0xFF;
    var row = mem[at++];
    var spriteY = ((row << 3) + 0x1F) & 0xFF;
    mem[0x54] = x;
    var slot = mem[0xE6];
    rbStore(m, 0xD009 + slot, spriteY);
    var col = mem[at];                                  // read without stepping
    var wide = (col + 2) << 3;
    rbStore(m, 0xD008 + slot, wide & 0xFF);
    if (wide > 0xFF) {
      rbStore(m, 0xD010, rbLoad(m, 0xD010) | mem[RB_MSIGX_MASKS + (slot >> 1)]);
    }
    mem[0xE6] = (mem[0xE6] + 2) & 0xFF;
    x = mem[0x54];
    at--;                                               // DEY, back to the row
    var cell = {at: at};
    rbCellAddress(m, cell);
    at = cell.at + 1;                                   // past the column byte
    mem[(0x58 + x) & 0xFF] = mem[0x10];
    mem[(0x59 + x) & 0xFF] = (mem[0xE5] + 0x40) & 0xFF;
    mem[(0x5A + x) & 0xFF] = 0x03;
    x = (x + 6) & 0xFF;
  }
  return {at: at, count: count};
} // rbRobots

/**
 * `$A714` — the black ball, if the room has one. ★ It is **sprite 0**, the
 * one the robots borrow for their bolt (§24), so switching it off is not
 * cosmetic. Called by the builder and again after a death (§31).
 * @param {Object} m - The machine.
 * @param {number} at - Where the ball section begins.
 * @returns {number} Where it ended.
 */
function rbBall(m, at) {
  var mem = m.mem;
  var ball = mem[at++];
  if (ball !== 0xFF) {
    mem[0x6E] = ball;
    rbStore(m, 0xD000, mem[at++]);
    rbStore(m, 0xD001, mem[at++]);
    rbStore(m, 0x43F8, 0x1F);
    rbStore(m, 0xD027, 0x00);
    rbStore(m, 0xD01C, 0xF1);
    mem[0x6D] = 0x00;
  } else {
    mem[0x6D] = 0xFF;
  }
  return at;
} // rbBall

/**
 * `$A39C` from its first instruction to its last: the whole room.
 *
 * @param {{mem: Uint8Array, color: Uint8Array, vic: Uint8Array}} m - The
 *   machine, as it is when the original enters `$A39C`.
 * @param {number} room - The room number the original takes from `$7E`.
 * @param {number} side - Which way the agent comes in, `$7F`: 0 left, 1 right.
 * @param {number} [stage] - ★ `$A39C` has a **frame boundary inside it**:
 *   `$A3C3` waits for `$7F6B` between clearing the room and drawing it, so on
 *   the machine the two halves land in different frames (measured, §21).
 *   Left out, both halves run at once, which is what every `match*` before
 *   the door did; 1 is the first half, 2 the second.
 * @returns {{furniture: number, robots: number}} What was put in the room.
 */
function buildRoom(m, room, side, stage) {
  var mem = m.mem, i, y, x;
  if (!stage || stage === 1) {
    mem[0x7E] = room & 0xFF;
    mem[0x7F] = side & 0xFF;

    mem[0x47] = 0;
    for (y = 0x0E; y >= 0; y -= 2) { rbStore(m, 0xD001 + y, 0); } // sprites off screen
    rbLoad(m, 0xD01E);                                            // BIT $D01E clears collisions
    mem[0x1A] = (mem[0x1A] + 2) & 0xFF;
    for (i = 0; i < 0x100; i++) {                                 // the room, blank
      rbStore(m, 0xC100 + i, RB_BLANK); rbStore(m, 0xC200 + i, RB_BLANK);
      rbStore(m, 0xC300 + i, RB_BLANK); rbStore(m, 0xC400 + i, RB_BLANK);
    }
    if (stage === 1) { return null; }                             // `$A3C3` — čeká se na snímek
  }
  room = mem[0x7E]; side = mem[0x7F];
  rbStore(m, 0xD018, (rbLoad(m, 0xD018) & 0xF0) | 0x04);          // the room's character set

  var cur = {at: rbGet16(mem, RB_ROOM_PTRS + 2 * (room & 0xFF))};
  mem[0x18] = cur.at & 0xFF; mem[0x19] = (cur.at >> 8) & 0xFF;

  mem[0x8D] = mem[cur.at++];                                      // colour of the split
  rbStore(m, 0xD022, mem[cur.at++]);
  rbStore(m, 0xD023, mem[cur.at++]);
  mem[0xE6] = mem[cur.at++];                                      // colour of the floors

  // floors: a run of $45/$46 at a screen address, in the floor colour
  while (mem[cur.at] !== 0xFF) {
    mem[0x10] = mem[0x14] = mem[cur.at++];
    var hi = mem[cur.at++];
    mem[0x11] = hi;
    mem[0x15] = (hi - 0xC1 + 0xD8) & 0xFF;
    y = mem[cur.at++];
    for (;;) {
      rbStore(m, rbGet16(mem, 0x10) + y, RB_FLOOR_RIGHT);
      rbStore(m, rbGet16(mem, 0x14) + y, mem[0xE6]);
      y--;
      if (y < 0) { break; }
      rbStore(m, rbGet16(mem, 0x10) + y, RB_FLOOR_LEFT);
      rbStore(m, rbGet16(mem, 0x14) + y, mem[0xE6]);
      y--;
      if (y < 0) { break; }
    }
  }
  cur.at++;

  // the two walls of the room, 25 rows of $47 on the left and $48 on the right
  mem[0x10] = mem[0x14] = 0x00;
  mem[0x11] = 0xC1; mem[0x15] = 0xD8;
  for (x = 0x18; x >= 0; x--) {
    rbStore(m, rbGet16(mem, 0x10), RB_WALL_LEFT);
    rbStore(m, rbGet16(mem, 0x14), mem[0xE6]);
    rbStore(m, rbGet16(mem, 0x10) + 0x27, RB_WALL_RIGHT);
    rbStore(m, rbGet16(mem, 0x14) + 0x27, mem[0xE6]);
    rbNextRow(mem);
  }

  // the pillars: five blank cells down a column and one character under them
  while (mem[cur.at] !== 0xFF) {
    mem[0x10] = mem[cur.at++];
    mem[0x11] = mem[cur.at++];
    var last = mem[cur.at++];
    y = 0;
    for (x = 4; x >= 0; x--) { rbStore(m, rbGet16(mem, 0x10) + y, RB_BLANK); y += 0x28; }
    rbStore(m, rbGet16(mem, 0x10) + y, last);
  }
  cur.at++;

  // where the agent stands (`$ABDB`); the side is `$7F`
  rbAgentEntry(m, cur.at, side);
  cur.at += 6;

  // the robots, three bytes each: kind, row, column (`$A68B`)
  var built = rbRobots(m, cur.at);
  cur.at = built.at;
  var robots = built.count;

  // the ball, if the room has one (`$A714`)
  cur.at = rbBall(m, cur.at);

  // the colours the room's sprites are drawn in
  rbStore(m, 0xD025, mem[cur.at++]);
  rbStore(m, 0xD026, mem[cur.at++]);
  var sprColor = mem[cur.at++];
  rbStore(m, 0xD02B, sprColor); rbStore(m, 0xD02C, sprColor);
  rbStore(m, 0xD02D, sprColor); rbStore(m, 0xD02E, sprColor);
  mem[0x4B] = sprColor;
  mem[0x4C] = mem[cur.at++];
  mem[0x8E] = mem[cur.at++];

  // from here the record is walked through $81/$82 (`$A4B9`)
  mem[0x81] = cur.at & 0xFF; mem[0x82] = (cur.at >> 8) & 0xFF;
  var base81 = cur.at;                                      // odkud se počítá Y
  mem[0x84] = (mem[0x8D] === 7) ? 0x09 : 0x0F;

  // the shafts: a column of tiles, one every six rows
  while (mem[cur.at] < 0x80) {
    var stops = mem[cur.at + 2];
    rbCellAddress(m, cur);
    for (x = stops; x >= 0; x--) { rbLiftTile(m); rbUpSixRows(mem); }
    cur.at++;                                               // the count byte
    while (mem[cur.at] < 0x80) { cur.at++; }                // the stops the lift serves
    cur.at++;
  }

  // the furniture: row, column, kind, and the slot the generator fills
  var records = 0, furniture = 0;
  mem[0x86] = 0;
  rbSet16(mem, 0x87, cur.at + 1);                           // $A4F7: $81 + Y, a `SEC` navíc
  cur.at++;                                                 // the byte that ended the shafts
  while (mem[cur.at] < 0x80) {
    furniture++;
    rbCellAddress(m, cur);
    cur.at++;
    var kindId = mem[cur.at++];
    mem[0x89] = kindId;
    var shape = RB_SHAPES + 5 * kindId;
    mem[0xE6] = mem[cur.at++];                              // what is hidden in it
    mem[0xE4] = (cur.at - base81) & 0xFF;                   // $A51E: STY $E4
    var colorAt = mem[shape] | mem[shape + 1] << 8;
    var size = mem[shape + 2];
    var width = mem[shape + 3];
    var flag = mem[shape + 4];
    mem[0x17] = mem[0x13] = (colorAt >> 8) & 0xFF;
    mem[0x16] = colorAt & 0xFF;
    var charAt = (colorAt + size + 1) & 0xFFFF;   // ★ `SEC` před `ADC` na $A52C
    mem[0x12] = charAt & 0xFF;
    mem[0x13] = (charAt >> 8) & 0xFF;
    mem[0xE5] = width;
    var left = size;
    y = width;
    for (;;) {
      rbStore(m, rbGet16(mem, 0x10) + y, rbLoad(m, rbGet16(mem, 0x12) + y));
      if (mem[0xE6] === 0xF0) { rbStore(m, rbGet16(mem, 0x10) + y, RB_BLANK); }
      rbStore(m, rbGet16(mem, 0x14) + y, rbLoad(m, rbGet16(mem, 0x16) + y));
      left--;
      if (left < 0) { break; }
      y--;
      if (y >= 0) { continue; }
      rbNextRow(mem);
      var c16 = rbGet16(mem, 0x16) + mem[0xE5] + 1;   // ★ i tady je `SEC` ($A55E, $A569)
      rbSet16(mem, 0x16, c16 & 0xFFFF);
      var c12 = rbGet16(mem, 0x12) + mem[0xE5] + 1;
      rbSet16(mem, 0x12, c12 & 0xFFFF);
      y = mem[0xE5];
    }
    if (kindId === 0x18 || kindId === 0x19) { continue; }   // the control room sockets
    var rec = RB_FURNITURE_RECORDS + records;
    mem[rec + 1] = (mem[0x11] + 0x7F) & 0xFF;
    mem[rec + 3] = (mem[0x11] + 0x7F) & 0xFF;
    mem[rec] = mem[0x10];
    var right = mem[0x10] + mem[0xE5];
    mem[rec + 2] = right & 0xFF;
    if (right > 0xFF) { mem[rec + 3] = (mem[rec + 3] + 1) & 0xFF; }
    mem[rec + 4] = flag;
    mem[rec + 5] = mem[cur.at - 1];                         // the slot byte
    records += 6;
    mem[0x86] = records;
  }
  mem[RB_FURNITURE_RECORDS + records] = 0xFF;

  if (RB_CODE_ROOMS.indexOf(room & 0xFF) >= 0) { rbCodeRoomConsole(m); }
  return {furniture: furniture, robots: robots};
} // buildRoom

/**
 * `$A5C9`: the two **code** rooms get their console drawn on top of the room (§35 — `$AA40` je řídicí, `$A771` kódová) —
 * the strip of sockets the password is typed into and the four sprites that
 * belong to it.
 *
 * @param {{mem: Uint8Array, color: Uint8Array, vic: Uint8Array}} m - The machine.
 */
function rbCodeRoomConsole(m) {
  var mem = m.mem, x, y;
  rbStore(m, 0xC17B, 0x00);
  rbStore(m, 0xC19C, 0x02);
  rbStore(m, 0xC3AB, 0x05);
  rbStore(m, 0xC3CC, 0x07);
  for (x = 0x1F; x >= 0; x--) {
    rbStore(m, 0xC17C + x, 0x01);
    rbStore(m, 0xC384 + x, 0x10);
    rbStore(m, 0xC3AC + x, 0x06);
    rbStore(m, 0xDA84 + x, 0x0C);
    rbStore(m, 0xD87C + x, 0x0E);
    rbStore(m, 0xDAAC + x, 0x0E);
  }
  rbStore(m, 0xC3BB, 0x11);
  rbStore(m, 0xC3BC, 0x11);
  mem[0x10] = 0x7B; mem[0x11] = 0xC1;
  mem[0x14] = 0x7B; mem[0x15] = 0xD8;
  rbStore(m, rbGet16(mem, 0x14) + 0x21, 0x0E);
  rbStore(m, rbGet16(mem, 0x14), 0x0E);
  rbNextRow(mem);
  for (x = 0x0C; x >= 0; x--) {
    rbStore(m, rbGet16(mem, 0x10), 0x03);
    rbStore(m, rbGet16(mem, 0x14), 0x0E);
    rbStore(m, rbGet16(mem, 0x10) + 0x21, 0x04);
    rbStore(m, rbGet16(mem, 0x14) + 0x21, 0x0E);
    rbNextRow(mem);
  }
  rbStore(m, rbGet16(mem, 0x14) + 0x21, 0x0E);
  rbStore(m, rbGet16(mem, 0x14), 0x0E);
  for (x = 0x8F; x >= 0; x--) { rbStore(m, 0x5000 + x, mem[0x3063 + x]); }
  for (x = 3; x >= 0; x--) {
    rbStore(m, 0x43FC + x, mem[0xA67B + x]);
    rbStore(m, 0xD02B + x, mem[0xA687 + x]);
  }
  for (x = 7; x >= 0; x--) { rbStore(m, 0xD008 + x, mem[0xA67F + x]); }
  rbStore(m, 0xD01C, 0x80);
  rbStore(m, 0x43F8, 0x1E);
} // rbCodeRoomConsole

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var roomBuild = {
  buildRoom: buildRoom, load: rbLoad, store: rbStore,
  agentEntry: rbAgentEntry, robots: rbRobots, ball: rbBall,
  SCREEN: RB_SCREEN, COLOR: RB_COLOR, ROOM_PTRS: RB_ROOM_PTRS,
  SHAPES: RB_SHAPES, FURNITURE_RECORDS: RB_FURNITURE_RECORDS,
  CODE_ROOMS: RB_CODE_ROOMS
};
if (typeof self !== 'undefined') {
  self.roomBuild = roomBuild;
  self.buildRoom = buildRoom;
  // ★ čtení a zápis vede přes stroj (RAM / barvy / VIC), takže je má sdílet
  // každý další přepis — `app/player.js` je druhý (M3)
  self.rbLoad = rbLoad;
  self.rbStore = rbStore;
  // ★ `app/terminal.js` kreslí dlaždice výtahu touž rutinou, když je lift
  // reset vrací na začátek (`$A182 JSR $AC4E`, §29)
  self.rbLiftTile = rbLiftTile;
  // ★ `app/death.js` staví roboty, kouli a agenta **týmiž rutinami**, jakými
  // je staví stavitel místnosti — `$95DA` do nich skáče přímo (§31)
  self.rbAgentEntry = rbAgentEntry;
  self.rbRobots = rbRobots;
  self.rbBall = rbBall;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = roomBuild; }
