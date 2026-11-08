// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * A room of the fortress, built the way the original builds it — but from
 * data instead of from a dump of the machine.
 *
 * `app/roomBuild.js` is the original's room builder (`$A39C`) transcribed,
 * and it works on the machine's memory. `tools/matchrooms.mjs` proves it by
 * giving it the memory VICE had. The game cannot carry that memory around,
 * so this loader puts the few things the builder reads back where the
 * original had them — and nothing else:
 *
 *   - the 32 pointers at `$0E70` and the 32 room records they point at,
 *     turned back into bytes exactly as `tools/dumprooms.py` took them apart
 *     (that round trip is measured: 3 927 checks, 0 differences);
 *   - the furniture shapes: the table at `$232C` and the colour and
 *     character blocks behind it;
 *   - the three characters of a shaft tile (`$0DB4`) and the four masks for
 *     the ninth bit of a robot's x (`$0E6C`);
 *   - what a control room puts on top of the room (`$A5C9`): the 144 bytes
 *     of character set from `$3063` and the three short sprite tables.
 *
 * Everything else on the screen the builder writes itself. That the two ways
 * round give the same room is `tools/matchrooms.mjs --data`: the room built
 * from `data/rooms.json` against the room the original built, screen codes
 * and colour memory, 32 rooms from each side.
 *
 * ## Deliberately free of DOM
 *
 * Like `app/screenLoader.js`, this takes the parsed JSON, not a URL: the
 * worker gets it in a message, a tool under Node reads it from disk (R-001).
 */

/** the screen of a room and its colour memory (`disasm_notes.md` §12) */
var RL_SCREEN = 0xC100, RL_COLOR = 0xD800, RL_CELLS = 1000;

/**
 * A room record back into the bytes the builder reads, in the order it reads
 * them — the mirror of `encode_room` in `tools/dumprooms.py`.
 *
 * @param {Object} room - One entry of `rooms` in `data/rooms.json`.
 * @returns {number[]} The record, terminator of the furniture list included.
 */
function rlEncodeRoom(room) {
  var out = [room.split, room.bg1, room.bg2, room.floorColor], i, f;
  for (i = 0; i < room.floors.length; i++) {
    f = room.floors[i];
    out.push(f.addr & 0xFF, (f.addr >> 8) & 0xFF, f.len);
  }
  out.push(0xFF);
  for (i = 0; i < room.walls.length; i++) {
    f = room.walls[i];
    out.push(f.addr & 0xFF, (f.addr >> 8) & 0xFF, f.char);
  }
  out.push(0xFF);
  var e = room.entry;
  out.push(e.xLeft, e.xRight, e.yLeft, e.yRight, e.msigLeft, e.msigRight);
  for (i = 0; i < room.robots.length; i++) {
    f = room.robots[i];
    out.push(f.type, f.row, f.col);
  }
  out.push(0xFF);
  if (room.ball === null) { out.push(0xFF); }
  else { out.push(room.ball.type, room.ball.x, room.ball.y); }
  var s = room.sprite;
  out.push(s.mc0, s.mc1, s.color47, s.z4c, s.enable);
  for (i = 0; i < room.lifts.length; i++) {
    f = room.lifts[i];
    out.push(f.row, f.col, f.stops);
    out = out.concat(f.tail);
    out.push(f.term);
  }
  out.push(0xFF);
  for (i = 0; i < room.furniture.length; i++) {
    f = room.furniture[i];
    out.push(f.row, f.col, f.kind, f.slot);
  }
  out.push(0xFF);                        // the byte the next record starts after
  return out;
} // rlEncodeRoom

/**
 * The machine's memory with what the room builder reads put back into it.
 *
 * @param {Object} data - The parsed `data/rooms.json`.
 * @param {Uint8Array} [into] - Memory to seed; a fresh 64 KB if left out.
 * @returns {Uint8Array} That memory.
 */
function rlMemory(data, into) {
  var mem = into || new Uint8Array(0x10000), i, j, k;

  for (i = 0; i < data.rooms.length; i++) {
    var room = data.rooms[i], bytes = rlEncodeRoom(room);
    mem[data.pointers + i*2] = room.addr & 0xFF;
    mem[data.pointers + i*2 + 1] = (room.addr >> 8) & 0xFF;
    for (j = 0; j < bytes.length; j++) { mem[room.addr + j] = bytes[j]; }
  }
  for (i = 0; i < data.shapes.length; i++) {
    var shape = data.shapes[i];
    mem[shape.at] = shape.colorAddr & 0xFF;
    mem[shape.at + 1] = (shape.colorAddr >> 8) & 0xFF;
    mem[shape.at + 2] = shape.cells - 1;
    mem[shape.at + 3] = shape.width - 1;
    mem[shape.at + 4] = shape.flag;
    for (j = 0; j < shape.colors.length; j++) { mem[shape.colorAddr + j] = shape.colors[j]; }
    for (j = 0; j < shape.chars.length; j++) { mem[shape.charAddr + j] = shape.chars[j]; }
  }
  for (i = 0; i < data.tiles.lift.length; i++) { mem[data.tiles.liftAt + i] = data.tiles.lift[i]; }
  for (i = 0; i < data.masks.bytes.length; i++) { mem[data.masks.at + i] = data.masks.bytes[i]; }
  // ★ **Konzole kódových místností** (`$A5C9`, §35) — čtyři pásy dat, které
  // `rbCodeRoomConsole` čte **tam, kde je má originál** (`from`, ne `at`):
  // záplata sady na `$3063` a tři tabulky sprajtů na `$A67B`. Soubor je vezl
  // od začátku, ale do paměti je nikdo nesypal, takže konzole neměla glyfy
  // a čtyři sprajty dostaly ukazatel `$00` — a **ruka kódové místnosti se
  // pak kreslila obrazovkou** (nahlásil operátor 2026-09-21). Do M5 to vidět
  // nebylo: sprajt bez bloku model schovával, takže ruka jen chyběla.
  if (data.codeRoom && data.codeRoom.parts) {
    for (i = 0; i < data.codeRoom.parts.length; i++) {
      var part = data.codeRoom.parts[i];
      for (j = 0; j < part.bytes.length; j++) {
        mem[(part.from + j) & 0xFFFF] = part.bytes[j] & 0xFF;
      }
    }
  }
  return mem;
} // rlMemory

/**
 * Builds one room, the original's way.
 *
 * @param {Object} data - The parsed `data/rooms.json`.
 * @param {number} room - 0 to 31.
 * @param {number} side - Which way the agent comes in: 0 left, 1 right.
 * @param {Uint8Array} [memory] - Memory to build in. The worker passes the
 *   memory it shuffled the fortress in — it is **already seeded** and the
 *   generators have written their part of the records into it, so it must not
 *   be seeded again. Without it the loader seeds a fresh machine from the data
 *   alone, which is the fortress as the original's disk has it, unshuffled.
 * @returns {Object} The screen, the colours, the VIC registers and what the
 *   builder counted — everything the picture of a room needs.
 */
function rlBuildRoom(data, room, side, memory) {
  var m = {mem: memory || rlMemory(data), color: new Uint8Array(0x400),
           vic: new Uint8Array(0x2F)};
  var counted = buildRoom(m, room, side);
  var screen = new Uint8Array(RL_CELLS), color = new Uint8Array(RL_CELLS), i;
  for (i = 0; i < RL_CELLS; i++) {
    screen[i] = m.mem[RL_SCREEN + i];
    color[i] = m.color[i] & 0x0F;
  }
  var record = data.rooms[room];
  var pointers = [];
  for (i = 0; i < 8; i++) { pointers.push(m.mem[0x43F8 + i]); }
  return {
    message: 'room', room: room, side: side,
    screen: screen, color: color, vic: m.vic, spritePointers: pointers,
    furniture: counted.furniture, robots: counted.robots,
    codeRoom: data.codeRoom.rooms.indexOf(room) >= 0,
    // ★ **Pozadí místnosti stavitel nepíše**, a `$D021` proto po něm zůstává
    // nulové — správně, tak to má i originál (`matchrooms` to srovnává).
    // Barva je `$8D`, první bajt záznamu, a do registru ji dostane až
    // **rastrový kód clony** (`$A388`, §21). Obsluha přerušení se v místnosti
    // na barvy pozadí vůbec nepodívá (`$8374`), takže tam pak zůstane.
    // ★ A **rámeček je něco jiného než pozadí**: `$D020` a `$D021` jsou dva
    // registry a Impossible Mission drží rámeček **černý po celou hru**
    // (`$3967` ho nastaví při startu a sáhne na něj až konec hry, `$8404`).
    colors: {border: m.vic[0x20] & 0x0F,
             background0: m.mem[0x8D] & 0x0F,
             background1: m.vic[0x22] & 0x0F,
             background2: m.vic[0x23] & 0x0F,
             spriteMulti0: m.vic[0x25] & 0x0F,
             spriteMulti1: m.vic[0x26] & 0x0F,
             sprites: [m.vic[0x27] & 0x0F, m.vic[0x28] & 0x0F, m.vic[0x29] & 0x0F,
                       m.vic[0x2A] & 0x0F, m.vic[0x2B] & 0x0F, m.vic[0x2C] & 0x0F,
                       m.vic[0x2D] & 0x0F, m.vic[0x2E] & 0x0F]},
    // ★ which sprites are on is **not** in `$D015` when the builder is done:
    // the record's last byte lands in `$8E` and `$A35E` (`LDA $8E` +
    // `STA $D015`) puts it into the register on the way into the room
    sprites: {enabled: m.mem[0x8E], multicolor: m.vic[0x1C],
              expandX: m.vic[0x1D], expandY: m.vic[0x17], msbX: m.vic[0x10],
              x: [m.vic[0x00], m.vic[0x02], m.vic[0x04], m.vic[0x06],
                  m.vic[0x08], m.vic[0x0A], m.vic[0x0C], m.vic[0x0E]],
              y: [m.vic[0x01], m.vic[0x03], m.vic[0x05], m.vic[0x07],
                  m.vic[0x09], m.vic[0x0B], m.vic[0x0D], m.vic[0x0F]]},
    split: record.split
  };
} // rlBuildRoom

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var roomsLoader = {
  memory: rlMemory, buildRoom: rlBuildRoom, encodeRoom: rlEncodeRoom,
  SCREEN: RL_SCREEN, COLOR: RL_COLOR, CELLS: RL_CELLS
};
if (typeof self !== 'undefined') { self.roomsLoader = roomsLoader; }
if (typeof module !== 'undefined' && module.exports) { module.exports = roomsLoader; }
