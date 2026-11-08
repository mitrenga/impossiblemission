// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The pocket computer — `$3AC6`, and the puzzle the whole game is about
 * (`sources/docs/disasm_notes.md` §34).
 *
 * Standing at the terminal in the shaft (`$3F` = `$0E`) and pushing the
 * button does not somersault, it opens the computer (`$3A49`). Six things
 * about it are worth knowing before reading on.
 *
 * 1. ★ **The six slots are not sprites and not a picture — they are the
 *    character set.** `$82AB` turns a slot number into `$5C50 + $90*n`,
 *    a hundred and forty-four bytes of the computer's own font (§14), so
 *    the "window" of §14 is exactly these six slots. Drawing a piece means
 *    rewriting glyphs.
 * 2. ★ **The left column is the memory, the right two are the workbench.**
 *    Slots 0 and 3 show `$4EF5[$C3]` and `$4EF5[$C3+1]`, the found pieces
 *    the search wrote down (§27); slots 1, 2, 4 and 5 are where four of
 *    them are put together. Scrolling the list (`$7A9F`, `$7B32`) **slides
 *    the glyphs a character row at a time** and hands the colour RAM along
 *    with them — an animation, not a redraw.
 * 3. ★ **Carrying a piece is two sprites.** `$3FA9` copies the slot's
 *    hundred and forty-four bytes out of the font into sprite blocks
 *    `$4D80` and `$4DC0` and the cursor drags them; dropping runs the same
 *    routine the other way round and **ORs** them back in (`$9F` decides
 *    which direction). Nothing is ever erased on the way out, which is why
 *    a piece stays visible in the slot it came from.
 * 4. ★ **A drop is refused by colour and by overlap, in that order.**
 *    `$3BA4` compares the carried colour with the slot's colour RAM, and
 *    only then does `$802A` walk both images against a frame-shaped
 *    template it builds in `$C100` — a piece may overlap another one
 *    **only in its border**.
 * 5. ★ **Nine solved puzzles are nine letters.** `$80B6` compares the slot
 *    against the nine cards at `$C9F0` (§9 called them a grid, §15
 *    corrected it), and a hit reveals `$4FB5,X` — one letter of the
 *    shuffled password — into the shaft's panel and takes the puzzle's
 *    four pieces out of the list (`$816E`).
 * 6. ★ **The telephone costs two minutes** (`$7D9D`, `$7DE6`: `SED`,
 *    `LDA #$02`, `JSR $83C2`) and the manual is right about it. What it
 *    says is one of four sentences at `$7CF4`, and one of the two options
 *    **rewrites the game's data**: `$7F80` clears bits 2 and 3 of the
 *    piece's record, which is the scrambling the player would otherwise
 *    have to undo by hand.
 *
 * ★ And the way out is the **map button** (`$3DDA` → `$B63B`): it swaps
 * the six slots into `$C690` for safekeeping, puts the picture of the
 * fortress (`$FC00`, §11) into the font in their place and **returns to
 * the shaft loop**. That is why `$3E5C` is the first thing the computer
 * does on the way in.
 *
 * ★ The unit here is the **frame**: `$83EA` at the top of the loop waits
 * for `$E0` (`$7F6B`) and the interrupt keeps running — unlike the
 * security terminal (§29) and unlike dying (§31), both of which hold
 * `SEI`. One pass of `$3AF5` is one frame, so the whole session is written
 * as a generator that yields exactly where the original waits.
 */

/** the six slots: the computer's character set, `$90` bytes apiece (§14) */
var PC_WINDOW = 0x5C50, PC_SLOT = 0x90, PC_SLOTS = 6;

/** where the map button parks them (`$3E5C`, `$B63B`) */
var PC_PARKED = 0xC690;

/** the scratch a piece is composed in, and the pieces' static shapes (§15) */
var PC_SCRATCH = 0x5000, PC_SHAPES = 0x2763, PC_CARDS = 0xC9F0, PC_RECORDS = 0xBFC0;

/** the list the search writes down, its colours, and the shuffled password */
var PC_FOUND = 0x4EF5, PC_FOUND_COLORS = 0x4F25, PC_PASSWORD = 0x4FB5;

/** the two sprite blocks a carried piece rides in, and their pointers */
var PC_BLOCK_A = 0x4D80, PC_BLOCK_B = 0x4DC0;
var PC_PTR4 = 0x43FC, PC_PTR5 = 0x43FD, PC_PTR6 = 0x43FE;

/** the game's screen and colour memory (§6), and the blank of both fonts */
var PC_SCREEN = 0x4000, PC_BLANK = 0x53;

/** the message line, the panel and the two rows of labels under it */
var PC_MESSAGE = 0x4376, PC_PROMPT = 0x439E, PC_MESSAGE_COLOR = 0xDB76;
var PC_PANEL_FROM = 0x3340, PC_PANEL_TO = 0x4285, PC_PANEL_BYTES = 0xDE;
var PC_LABELS = 0x3431, PC_LABEL_COLORS = 0x35C1, PC_LABEL_BYTES = 0x3E;

/** the tables of the six slots: colour RAM (`$7A55`) and sprite place (`$720C`) */
var PC_SLOT_COLOR_LO = 0x7A55, PC_SLOT_COLOR_HI = 0x7A5B;
var PC_SLOT_X = 0x720C, PC_SLOT_Y = 0x7212;

/** the telephone: its screen, what it parks under it, and its four sentences */
var PC_PHONE_SCREEN = 0x7C3C, PC_PHONE_COLORS = 0x7C44, PC_PHONE_PARKED = 0xC220;
var PC_PHONE_TEXTS = 0x7CF4, PC_PHONE_TUNE = 0x7E36, PC_PHONE_NOTES = 0x7E6D;

/** the eight things the computer can say, twenty-two characters apiece */
var PC_MESSAGES = 0x81FB;
var PC_SAY_PROMPT = 0x81FB,      // "push button"
    PC_SAY_COLORS = 0x8211,      // colors must match
    PC_SAY_OVERLAP = 0x8227,     // images can't overlap
    PC_SAY_NOTHING = 0x823D,     // no image selected
    PC_SAY_END = 0x8253,         // end of memory
    PC_SAY_UNDO = 0x8269,        // can't undo
    PC_SAY_TIME = 0x827F,        // time is suspended
    PC_SAY_AGAIN = 0x8295;       // we just did this one

/** the four sentences of the telephone, by where `$7FFC` ends its copy */
var PC_TEXT_SOLUTION = 0x15, PC_TEXT_MORE = 0x2B,
    PC_TEXT_ORIENT = 0x41, PC_TEXT_MEMORY = 0x57;

/** the map: the picture the shuffle drew (§11) and the legend `$B563` */
var PC_MAP_PICTURE = 0xFC00, PC_MAP_CHARS = 0xFF30, PC_MAP_LEGEND = 0xB563;

/** zero page — the two pointers the original draws with */
var PC_PTR = 0x18, PC_DRAW = 0x10, PC_DRAW_COLOR = 0x14;

/** zero page — what the computer itself is */
var PC_PICKED = 0x8F,        // the slot the cursor has hold of, `$FF` none
    PC_FROM = 0x90,          // where a carried piece was picked up
    PC_UNDO = 0x91,          // the slot `$C100` holds a copy of, `$FF` none
    PC_FULL = 0x92,          // six flags: is the slot taken
    PC_COLORS = 0x98,        // six colours, one per slot
    PC_TINT = 0x9E,          // the colour a composed piece is drawn in
    PC_MODE = 0x9F,          // 0 carrying, 1 cursor, 2 telephone
    PC_LIMIT = 0xA0,         // the cursor's four walls: minY, maxY, minX, maxX
    PC_SOUND = 0xA4,         // the countdown the interrupt silences voices by
    PC_SCROLL = 0xC3,        // where in the list the left column stands
    PC_SOLVED = 0xC8,        // nine flags, one per puzzle
    PC_SUSPEND = 0xD5,       // ★ written twice and read nowhere — see `pcTimeJoke`
    PC_PUZZLES = 0xD8,       // how many puzzles are solved, for the score board
    PC_CLOCK = 0xD1,         // the clock the interrupt keeps (§33)
    PC_FIRE_EDGE = 0xDE,     // one push is one choice
    PC_FRAME = 0xE0,         // the interrupt's counter, what `$7F6B` waits on
    PC_DEATH = 0x43;         // ★ `$FF` here is the clock running out (§33)

/** the joystick, port 2, active low (§7) */
var PC_JOY_FIRE = 0x10;

function pcByte(v) { return v & 0xFF; }
function pcLoad(m, a) { return rbLoad(m, a); }
function pcStore(m, a, v) { rbStore(m, a, v); }
function pcWord(m, a) { return pcLoad(m, a) | (pcLoad(m, a + 1) << 8); }
function pcJoy(m) { return m.pc ? m.pc.joy : 0x7F; }
/** what the session last did, so a measurement can say what it covered */
function pcDid(m, what) { if (m.pc) { m.pc.did = what; } }

/**
 * What the computer needs to find in memory: its tables and its texts, and
 * the sixteen static shapes a piece is composed out of. ★ All of it is
 * **data of the program** — the same trap as the stream of robot programs
 * (§24) and the tables of the search (§27): no `match*` reaches it, because
 * every recording starts from a dump of the original's memory, where it is.
 *
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} data - The parsed `data/computer.json`.
 * @param {Object} [puzzle] - The parsed `data/puzzle.json`, for the shapes.
 */
function pcSeedMemory(mem, data, puzzle) {
  var i, j, at, key;
  if (data && data.tables) {
    for (key in data.tables) {
      if (!Object.prototype.hasOwnProperty.call(data.tables, key)) { continue; }
      at = parseInt(data.tables[key].addr.replace('$', ''), 16);
      for (i = 0; i < data.tables[key].values.length; i++) {
        mem[(at + i) & 0xFFFF] = data.tables[key].values[i] & 0xFF;
      }
    }
  }
  // ★ **Šestnáct tvarů dílku** (`$2763`, §15). Skládá z nich `$9C3A`, a bez
  // nich je každý dílek prázdný — `matchpuzzle` je měří proti paměti stroje,
  // ale do paměti workeru je nikdo nesypal, protože do M5 je nikdo nečetl.
  if (puzzle && puzzle.shapes) {
    for (i = 0; i < puzzle.shapes.length; i++) {
      at = parseInt(puzzle.shapes[i].addr.replace('$', ''), 16);
      for (j = 0; j < puzzle.shapes[i].bytes.length; j++) {
        mem[(at + j) & 0xFFFF] = puzzle.shapes[i].bytes[j] & 0xFF;
      }
    }
  }
} // pcSeedMemory

/* --------------------------------------------------------- small helpers */

/**
 * `$82AB` — a slot number into the address of its glyphs.
 *
 * ★ It is **not** `$5C50 + $90*n`, even though it is that for every slot
 * there is. The original shifts the number seven times over into `X:A`,
 * keeps `A << 4` in `$E4` — **only its low byte** — and adds the two, so
 * the high half of `n*16` is thrown away. For `n` of 0 to 5 that makes no
 * difference; for `$FF`, which `$80B6` hands it when nothing is chosen, it
 * is `$DCC0` and not `$EBC0`. Measured (`compsay42`).
 */
function pcSlotAddr(a) {
  var i, c, x = 0, e5 = 0;
  a = pcByte(a);
  for (i = 0; i < 4; i++) {                        // `$82B1`, čtyřikrát
    c = (a >> 7) & 1; a = pcByte(a << 1);
    e5 = pcByte((e5 << 1) | c);
  }
  var e4 = a;                                      // `$82B7 STA $E4`
  for (i = 0; i < 3; i++) {                        // `$82BB`, třikrát
    c = (a >> 7) & 1; a = pcByte(a << 1);
    e5 = pcByte((e5 << 1) | c);
  }
  x = e5;                                          // `$82C1 LDX $E5`
  var sum = a + e4;                                // `$82C3 CLC / ADC $E4`
  a = pcByte(sum);
  if (sum > 0xFF) { x = pcByte(x + 1); }           // `$82C8 BCC / INX`
  sum = a + 0x50;                                  // `$82CB CLC / ADC #$50`
  return (pcByte(sum) | (pcByte(x + 0x5C + (sum > 0xFF ? 1 : 0)) << 8)) & 0xFFFF;
} // pcSlotAddr

/** `$BF30` — the working pointer `$18`/`$19` by so many bytes */
function pcMovePtr(m, delta) {
  var at = (pcWord(m, PC_PTR) + delta) & 0xFFFF;
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
} // pcMovePtr

/**
 * `$AF24`/`$AEF0` — the drawing position by so many characters.
 * ★ The colour pointer is **not added to, it is copied**: `$AF24` is
 * `STA $10 / STA $14`, so both get the same low half and only the carry
 * lifts `$11` and `$15` apart. The same trap as in the terminal (§29).
 */
function pcAdvance(m, delta) {
  var lo = pcLoad(m, PC_DRAW) + delta;
  pcStore(m, PC_DRAW, lo & 0xFF);
  pcStore(m, PC_DRAW_COLOR, lo & 0xFF);
  var carry = lo > 0xFF ? 1 : (lo < 0 ? -1 : 0);
  if (carry) {
    pcStore(m, PC_DRAW + 1, pcByte(pcLoad(m, PC_DRAW + 1) + carry));
    pcStore(m, PC_DRAW_COLOR + 1, pcByte(pcLoad(m, PC_DRAW_COLOR + 1) + carry));
  }
} // pcAdvance

/**
 * `$82D6` — the mixer, and ★ **its carry matters here**. `$7EA3 ADC #$1F`
 * adds whatever `ROR $EB` shifted out, which is bit 0 of the state as it
 * was before the draw. Everywhere else in the game the result of the mixer
 * is masked and the carry thrown away; the telephone is the one place that
 * spends it.
 */
function pcRandom(m, entropy) {
  m.pcCarry = m.mem[0xEB] & 1;
  return fgRandom(m.mem, entropy());
} // pcRandom

/* --------------------------------------------------------------- the SID */

/**
 * `$3F87` — the click of a button: voice 3 at the given note, and `$A4`
 * counts it down to silence in the interrupt (`app/sound.js`).
 */
function pcTone(m, hi, lo) {
  pcStore(m, 0xD40F, hi); pcStore(m, 0xD40E, lo);
  pcStore(m, 0xD413, 0x00); pcStore(m, 0xD414, 0xF0);
  pcStore(m, PC_SOUND, 0x08);
  pcStore(m, 0xD404, 0x08); pcStore(m, 0xD40B, 0x08); pcStore(m, 0xD412, 0x11);
} // pcTone

/**
 * `$7D4C` — the telephone ringing, and it is set up **every frame** the
 * computer is in the telephone (`$3B05`), not once.
 */
function pcRing(m) {
  pcStore(m, 0xD40C, 0x00); pcStore(m, 0xD413, 0x00);
  pcStore(m, 0xD40D, 0xF0); pcStore(m, 0xD414, 0xF0);
  pcStore(m, 0xD407, 0x6D); pcStore(m, 0xD408, 0x16);
  pcStore(m, 0xD40E, 0x31); pcStore(m, 0xD40F, 0x1C);
  pcStore(m, 0xD416, 0x40); pcStore(m, 0xD415, 0x00);
  pcStore(m, 0xD418, 0x12);
  pcStore(m, 0xD40B, 0x11); pcStore(m, 0xD412, 0x11);
  pcStore(m, PC_SOUND, 0x02);
} // pcRing

/** `$7E44` — one note of the voice at the other end of the line */
function pcPhoneNote(m, y) {
  pcStore(m, 0xD407, pcLoad(m, PC_PHONE_NOTES + y));
  pcStore(m, 0xD408, pcLoad(m, PC_PHONE_NOTES + 0x0C + y));
  pcStore(m, 0xD40E, pcLoad(m, PC_PHONE_NOTES + 0x18 + y));
  pcStore(m, 0xD40F, pcLoad(m, PC_PHONE_NOTES + 0x24 + y));
  pcStore(m, 0xD418, 0x15);
  pcStore(m, 0xD40B, 0x11); pcStore(m, 0xD412, 0x11);
  pcStore(m, PC_SOUND, 0x08);
} // pcPhoneNote

/* ------------------------------------------------------ waiting for a frame */

/**
 * `$7F6D` — wait until `$E0` has gone up by `n`. ★ In the original this is
 * the only clock the computer has; here every `yield` is one frame of the
 * worker, so the two are the same thing. `n` of zero waits for nothing,
 * which is what `ADC $E0` with a zero does.
 */
function* pcWait(n) {
  for (var i = 0; i < pcByte(n); i++) { yield; }
} // pcWait

/* --------------------------------------------------------- the six slots */

/**
 * `$7A34`/`$7A37` — a slot's colour, into `$0098+n` and into the six by
 * three characters of colour RAM the slot covers.
 */
function pcPaintSlot(m, colour, slot, remember) {
  if (remember) { pcStore(m, PC_COLORS + slot, colour); }
  // ★ Adresa jde do `$18`/`$19` a **zůstane tam posunutá** o tři řádky
  // (`$7A4D JSR $BF30` třikrát): originál si pracovní ukazatel po sobě
  // neuklízí a další rutina s ním počítá takový, jaký je
  var at = pcLoad(m, PC_SLOT_COLOR_LO + slot) | (pcLoad(m, PC_SLOT_COLOR_HI + slot) << 8);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  for (var row = 2; row >= 0; row--) {
    for (var y = 5; y >= 0; y--) { pcStore(m, (at + y) & 0xFFFF, colour); }
    at = (at + 0x28) & 0xFFFF;
    pcMovePtr(m, 0x28);
  }
} // pcPaintSlot

/** `$7427` — all six colours and the yellow divider down the middle */
function pcSlotColours(m) {
  for (var y = PC_SLOTS - 1; y >= 0; y--) {
    pcPaintSlot(m, pcLoad(m, PC_COLORS + y), y, false);
  }
  for (var row = 0; row < 6; row++) { pcStore(m, 0xDA8D + row*0x28, 0x07); }
} // pcSlotColours

/** `$3E5C` — the six slots back out of `$C690`, where the map left them */
function pcRestoreWindow(m) {
  for (var x = 0; x < 0x100; x++) {
    pcStore(m, 0x5C50 + x, pcLoad(m, 0xC690 + x));
    pcStore(m, 0x5D50 + x, pcLoad(m, 0xC790 + x));
    pcStore(m, 0x5E50 + x, pcLoad(m, 0xC890 + x));
  }
  for (x = 0x5F; x >= 0; x--) { pcStore(m, 0x5F50 + x, pcLoad(m, 0xC990 + x)); }
} // pcRestoreWindow

/** `$7218` — the twenty-two by eight blank the messages are printed into */
function pcClearMessage(m) {
  pcStore(m, PC_DRAW, 0x86); pcStore(m, PC_DRAW + 1, 0x42);
  for (var row = 7; row >= 0; row--) {
    for (var y = 0x15; y >= 0; y--) {
      pcStore(m, (pcWord(m, PC_DRAW) + y) & 0xFFFF, PC_BLANK);
    }
    pcAdvance(m, 0x28);
  }
  pcStore(m, PC_UNDO, 0xFF);
} // pcClearMessage

/** `$8018` — the two rows of labels under the slots, characters and colours */
function pcLabels(m) {
  for (var y = PC_LABEL_BYTES; y >= 0; y--) {
    pcStore(m, PC_MESSAGE + y, pcLoad(m, PC_LABELS + y));
    pcStore(m, PC_MESSAGE_COLOR + y, pcLoad(m, PC_LABEL_COLORS + y));
  }
} // pcLabels

/* ----------------------------------------------------- composing a piece */

/** `$B12D` — the border every piece is drawn inside, and its trimmed foot */
function pcFrameShape(m, at) {
  var y, band, base;
  for (y = 0x28; y >= 0; y -= 8) { pcStore(m, (at + y) & 0xFFFF, 0xFF); }
  for (band = 0; band < 3; band++) {
    base = (at + band*0x30) & 0xFFFF;
    for (y = 7; y >= 0; y--) {
      pcStore(m, (base + y) & 0xFFFF, pcLoad(m, (base + y) & 0xFFFF) | 0xC0);
    }
    for (y = 0x2F; y >= 0x28; y--) {
      pcStore(m, (base + y) & 0xFFFF, pcLoad(m, (base + y) & 0xFFFF) | 0x03);
    }
  }
  base = (at + 0x60) & 0xFFFF;
  for (y = 0x2F; y >= 0; y -= 8) {
    pcStore(m, (base + y) & 0xFFFF, 0x00);
    pcStore(m, (base + y - 1) & 0xFFFF, 0x00);
    pcStore(m, (base + y - 2) & 0xFFFF, 0x00);
    pcStore(m, (base + y - 3) & 0xFFFF, 0xFF);
  }
} // pcFrameShape

/**
 * `$7934` — one turn of the rotation: six bytes of the picture swapped
 * along a cycle. ★ It is a **permutation by swaps**, not a redraw, and both
 * addresses it works through are self-modified (`$9C7F`, `$790F`) to the
 * same picture, so a turn never leaves the block it turns.
 * @returns {Array} The pair `[x, y]` the next turn carries on with.
 */
function pcTurnStep(m, dest, x, y) {
  pcStore(m, 0xE5, 0x05);
  for (var i = 5; i >= 0; i--) {
    var keep = pcLoad(m, (dest + x) & 0xFFFF);
    pcStore(m, (dest + x) & 0xFFFF, pcLoad(m, (dest + y) & 0xFFFF));
    pcStore(m, (dest + y) & 0xFFFF, keep);
    x = pcByte(x - 8); y = pcByte(y - 8);
    pcStore(m, 0xE5, pcByte(5 - (6 - i)));
  }
  pcStore(m, 0xE5, 0xFF);
  y = pcByte(y + 0x2F); x = pcByte(x + 0x31);
  if (x === 0x30) { x = 0x58; }
  if (y === 0x87) { y = 0x5F; }
  return [x, y];
} // pcTurnStep

/**
 * `$7999` — one turn of the flip, and it goes through `$C500`, the table of
 * reversed bits the agent is mirrored by (§13): both bytes of the pair are
 * turned over as they change places, so a flip is a mirror and a swap at
 * once.
 */
function pcFlipStep(m, dest, x, y) {
  pcStore(m, 0xE4, 0x02);
  for (var i = 2; i >= 0; i--) {
    var keep = pcLoad(m, (dest + x) & 0xFFFF);
    pcStore(m, 0xE6, x);
    pcStore(m, (dest + x) & 0xFFFF,
            pcLoad(m, 0xC500 + pcLoad(m, (dest + y) & 0xFFFF)));
    pcStore(m, (dest + y) & 0xFFFF, pcLoad(m, 0xC500 + keep));
    x = pcByte(x + 8); y = pcByte(y - 8);
    pcStore(m, 0xE4, pcByte(i - 1));
  }
  x = pcByte(x - 0x17); y = pcByte(y + 0x19);
  if (x === 0x08) { x = 0x30; y = 0x58; }
  if (x === 0x38) { x = 0x60; y = 0x88; }
  return [x, y];
} // pcFlipStep

/**
 * `$9C7D` — the scrambling the generator gave a piece (`$B176`: the fourth
 * byte of the record is `random & $0C` plus the piece's place among the
 * four), applied to a picture that is already drawn: bit 3 turns it, bit 2
 * flips it. ★ The telephone clears both bits and calls this, and that is
 * what "orientation corrected" means.
 */
function pcOrient(m, dest, orient) {
  var xy, i;
  pcStore(m, PC_PTR, dest & 0xFF); pcStore(m, PC_PTR + 1, dest >> 8);
  pcStore(m, 0xE4, orient);
  if (orient & 0x08) {                                      // `$9C9C`
    xy = [0x28, 0x8C];
    pcStore(m, 0xE4, 0x09);
    for (i = 9; i >= 0; i--) {
      xy = pcTurnStep(m, dest, xy[0], xy[1]);
      pcStore(m, 0xE4, pcByte(i - 1));
    }
  }
  if (orient & 0x04) {                                      // `$9CB0`
    xy = [0x00, 0x28];
    pcStore(m, 0xE5, 0x14);
    for (i = 0x14; i >= 0; i--) {
      xy = pcFlipStep(m, dest, xy[0], xy[1]);
      pcStore(m, 0xE5, pcByte(i - 1));
    }
  }
} // pcOrient

/**
 * `$9C3A` — ★ **a piece is not drawn, it is computed** (§15): the card the
 * puzzle is cut out of, masked by two of the sixteen shapes, either of
 * which may be inverted. Which one is inverted is the piece's place among
 * the four, which is why the four of a puzzle tile the card exactly.
 *
 * ★ And it does **not** end with the border: `$9C79` falls straight into
 * `$9C7D`, so the scrambled orientation is put back on before anybody sees
 * the picture. `tools/tracepuzzle.py` stops at `$9C79` and `matchpuzzle`
 * therefore never saw this half (M2); it is measured here.
 *
 * @param {Object} m - The machine.
 * @param {number} piece - The piece's number, `$BFC0 + piece*4`.
 */
function pcCompose(m, piece) {
  var rec = (PC_RECORDS + 4*pcByte(piece)) & 0xFFFF;
  var card = (PC_CARDS + PC_SLOT*pcLoad(m, rec)) & 0xFFFF;        // `$9CD3`
  var shapeA = (PC_SHAPES + PC_SLOT*pcLoad(m, rec + 1)) & 0xFFFF; // `$9CE8` → `$C6`
  var shapeB = (PC_SHAPES + PC_SLOT*pcLoad(m, rec + 2)) & 0xFFFF; // → `$C4`
  pcStore(m, 0xC4, shapeB & 0xFF); pcStore(m, 0xC5, shapeB >> 8);
  pcStore(m, 0xC6, shapeA & 0xFF); pcStore(m, 0xC7, shapeA >> 8);
  pcStore(m, 0xE8, card & 0xFF); pcStore(m, 0xE9, card >> 8);
  var orient = pcLoad(m, rec + 3);                                // `$9C3E` → `$E4`
  var invB = (orient & 1) ? 0xFF : 0x00;                          // `$9C44`
  var invA = (orient & 2) ? 0xFF : 0x00;                          // `$9C4D`
  for (var y = PC_SLOT - 1; y >= 0; y--) {
    var a = (invA ^ pcLoad(m, shapeA + y)) & pcLoad(m, card + y); // `$9C56`
    pcStore(m, PC_SCRATCH + y, a);
    pcStore(m, PC_SCRATCH + y, (invB ^ pcLoad(m, shapeB + y)) & a);
  }
  pcStore(m, PC_PTR, 0x00); pcStore(m, PC_PTR + 1, 0x50);         // `$9C6E`
  pcFrameShape(m, PC_SCRATCH);                                    // `$9C76`
  pcOrient(m, PC_SCRATCH, orient);                                // `$9C79` → `$9C7D`
} // pcCompose

/* ------------------------------------------------------------ the cursor */

/** `$3EBA` — the hand: sprite 4, its block, its colour and its four walls */
function pcCursorSprite(m) {
  pcStore(m, PC_PTR4, 0x10);
  pcStore(m, 0xD02B, 0x01);
  pcStore(m, 0xD015, (pcLoad(m, 0xD015) & 0x8F) | 0x10);
  pcStore(m, PC_LIMIT + 0, 0xB0); pcStore(m, PC_LIMIT + 1, 0xE6);
  pcStore(m, PC_LIMIT + 2, 0x0E); pcStore(m, PC_LIMIT + 3, 0xA2);
  pcStore(m, PC_MODE, 0x01);
} // pcCursorSprite

/** `$3EA8` — the hand parked over a slot, and then `$3EBA` */
function pcCursorAt(m, slot) {
  pcStore(m, 0xD009, pcByte(pcLoad(m, PC_SLOT_Y + slot) + 0x08));
  pcStore(m, 0xD008, pcByte(pcLoad(m, PC_SLOT_X + slot) + 0x16));
  pcCursorSprite(m);
} // pcCursorAt

/**
 * `$3E7F` — the panel of the computer out of `$3340`, and the hand on top
 * of it. ★ It starts by **waiting for a frame**, because two hundred and
 * twenty-two characters do not fit under the raster.
 */
function* pcPanel(m) {
  yield;                                                   // `$3E7F`
  for (var y = PC_PANEL_BYTES; y >= 1; y--) {
    pcStore(m, PC_PANEL_TO + y, pcLoad(m, PC_PANEL_FROM + y));
  }
  var picked = pcLoad(m, PC_PICKED);                       // `$3E90`
  if (picked & 0x80) {
    pcStore(m, 0xD009, 0xD1); pcStore(m, 0xD008, 0x10);
    pcStore(m, 0xD010, pcLoad(m, 0xD010) | 0x10);
    pcCursorSprite(m);
  } else {
    pcCursorAt(m, picked);
  }
} // pcPanel

/** `$3EE3` — sprite 6, the marker that says which slot is chosen */
function pcSelectSprite(m) {
  var picked = pcLoad(m, PC_PICKED);
  if (picked & 0x80) { return; }
  pcStore(m, PC_PTR6, 0x13);
  pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xBF);
  pcStore(m, 0xD00C, pcLoad(m, PC_SLOT_X + picked));
  pcStore(m, 0xD00D, pcLoad(m, PC_SLOT_Y + picked));
  pcStore(m, 0xD02D, 0x08);
  pcStore(m, 0xD01D, pcLoad(m, 0xD01D) | 0x40);
  pcStore(m, 0xD015, pcLoad(m, 0xD015) | 0x40);
} // pcSelectSprite

/** `$3F75` — eight rows of a bar into the block sprite 5 is drawn from */
function pcBarRows(m, y) {
  for (var x = 7; x >= 0; x--) { pcStore(m, PC_BLOCK_A + y, 0x1F); y -= 3; }
} // pcBarRows

/**
 * `$3F16` — sprite 5, and it is **built, not chosen**: a bar for each of
 * the two pieces in the left column that the player has already asked the
 * telephone about (bit 6 of the list entry, `$7F80`).
 */
function pcIndicator(m) {
  pcStore(m, 0xD015, pcLoad(m, 0xD015) & 0xDF);
  for (var x = 0x3F; x >= 0; x--) { pcStore(m, PC_BLOCK_A + x, 0x00); }
  var at = pcLoad(m, PC_SCROLL);
  var top = pcLoad(m, PC_FOUND + at);
  if (top & 0x80) { return; }                              // `$3F2D`
  if (top & 0x40) { pcBarRows(m, 0x1A); }
  var next = pcLoad(m, PC_FOUND + 1 + at);
  if (!(next & 0x80) && (next & 0x40)) { pcBarRows(m, 0x38); }
  pcStore(m, 0xD00B, 0xB4); pcStore(m, 0xD00A, 0x36);
  pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xDF);
  pcStore(m, 0xD017, pcLoad(m, 0xD017) | 0x20);
  pcStore(m, PC_PTR5, 0x36);
  pcStore(m, 0xD02C, 0x0A);
  pcStore(m, 0xD015, pcLoad(m, 0xD015) | 0x20);
} // pcIndicator

/**
 * `$3FA9` — a piece between the character set and the two sprite blocks.
 * ★ Which way it goes is `$9F`: picking up (`$9F` still 1) copies out,
 * dropping (`$9F` 0) **ORs** back in — so a piece dropped on top of another
 * one merges with it instead of replacing it, which is what the whole
 * puzzle is about.
 *
 * ★ The walk is not a straight run: three characters wide at a time, eight
 * bytes down, and `$3FEC` steps the row on by `$17` with two wrap-arounds.
 * The same walk is in `$802A` and has to agree byte for byte.
 */
function pcTransfer(m, slot) {
  var at = pcSlotAddr(slot);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  var right = (at + 0x18) & 0xFFFF;
  pcStore(m, 0xE5, right & 0xFF); pcStore(m, 0xE6, right >> 8);
  var x = 0x3E, y = 0x74, out = pcLoad(m, PC_MODE) !== 0;
  for (;;) {
    pcStore(m, 0xE4, 0x02);
    for (var n = 2; ; ) {
      if (out) {
        pcStore(m, PC_BLOCK_A + x, pcLoad(m, (at + y) & 0xFFFF));
        pcStore(m, PC_BLOCK_B + x, pcLoad(m, (right + y) & 0xFFFF));
      } else {
        pcStore(m, (at + y) & 0xFFFF,
                pcLoad(m, PC_BLOCK_A + x) | pcLoad(m, (at + y) & 0xFFFF));
        pcStore(m, (right + y) & 0xFFFF,
                pcLoad(m, PC_BLOCK_B + x) | pcLoad(m, (right + y) & 0xFFFF));
      }
      x--;
      if (x < 0) { return; }                               // `$3FE1`
      y = pcByte(y - 8);
      n--; pcStore(m, 0xE4, pcByte(n));
      if (n < 0) { break; }
    }
    y = pcByte(y + 0x17);                                  // `$3FEC`
    if (y === 0x6F) { y = 0x47; }
    if (y === 0x3F) { y = 0x17; }
  }
} // pcTransfer

/**
 * `$802A` — may the carried piece be put down here? ★ The answer is not a
 * rectangle: the original builds the **shape of a border** in `$C100` and
 * then walks the carried sprites against the slot, byte by byte, asking
 * that everything they have in common be exactly that border.
 * @returns {boolean} True when they would overlap — the original's carry.
 */
function pcOverlap(m, slot) {
  var x, y;
  for (x = 0x8F; x >= 0; x--) { pcStore(m, 0xC100 + x, 0x00); }
  for (x = 7; x >= 0; x--) {
    pcStore(m, 0xC100 + x, 0xC0); pcStore(m, 0xC130 + x, 0xC0);
    pcStore(m, 0xC160 + x, 0xC0);
    pcStore(m, 0xC128 + x, 0x03); pcStore(m, 0xC158 + x, 0x03);
    pcStore(m, 0xC188 + x, 0x03);
  }
  for (x = 0x28; x >= 0; x -= 8) {
    pcStore(m, 0xC100 + x, 0xFF); pcStore(m, 0xC164 + x, 0xFF);
  }
  pcStore(m, 0xE6, slot);                                  // `$8062`
  var at = pcSlotAddr(slot);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  var right = (at + 0x18) & 0xFFFF;
  pcStore(m, 0xE4, right & 0xFF); pcStore(m, 0xE5, right >> 8);
  x = 0x3E; y = 0x74;
  for (;;) {
    pcStore(m, 0xE7, 0x02);
    for (var n = 2; ; ) {
      if ((pcLoad(m, PC_BLOCK_A + x) & pcLoad(m, (at + y) & 0xFFFF))
          !== pcLoad(m, 0xC100 + y)) { return true; }
      if ((pcLoad(m, PC_BLOCK_B + x) & pcLoad(m, (right + y) & 0xFFFF))
          !== pcLoad(m, 0xC118 + y)) { return true; }
      x--;
      if (x < 0) { return false; }
      y = pcByte(y - 8);
      n--; pcStore(m, 0xE7, pcByte(n));
      if (n < 0) { break; }
    }
    y = pcByte(y + 0x17);
    if (y === 0x6F) { y = 0x47; }
    if (y === 0x3F) { y = 0x17; }
  }
} // pcOverlap

/**
 * `$3E08` — the hand, moved by the stick inside its four walls. ★ The X it
 * works in is a **half-pixel** (`LSR` of `$D000` with the ninth bit rolled
 * in), and the whole dispatch below is written in it, which is why the
 * button boxes look like odd numbers.
 * @returns {Object} `x` and `y` as the dispatch wants them.
 */
function pcCursor(m) {
  var joy = pcJoy(m);
  var msb = (pcLoad(m, 0xD010) & 0x10) ? 1 : 0;            // `$3E08`, čtyři `ASL`
  var x = ((msb << 7) | (pcLoad(m, 0xD008) >> 1)) & 0xFF;
  // ★ **`Y` se načte jednou a dál se nemění** (`$3E14`): posun nahoru nebo
  // dolů přepíše `$D009`, ale rozcestník `$3C21` dostane **starou** hodnotu,
  // zatímco `X` je nová. Kdo vrátí obojí čerstvé, trefí tlačítko o řádek vedle.
  var y = pcLoad(m, 0xD009);
  var moved = false;
  if (!(joy & 0x01) && y >= pcLoad(m, PC_LIMIT + 0)) {     // `$3E1D`
    pcStore(m, 0xD009, pcByte(y - 1));
  }
  if (!(joy & 0x02) && y < pcLoad(m, PC_LIMIT + 1)) {      // `$3E27`
    pcStore(m, 0xD009, pcByte(pcLoad(m, 0xD009) + 1));
  }
  if (!(joy & 0x04) && x >= pcLoad(m, PC_LIMIT + 2)) {     // `$3E31`
    x = pcByte(x - 1);
    // ★ `$3E36 BNE` — a zero here **falls into the test for the other way**,
    // so the one step left the wall allows may be taken back at once
    if (x !== 0) { moved = true; }
  }
  if (!moved) {
    if ((joy & 0x08)) { return {x: x, y: y}; }               // `$3E39`
    if (x >= pcLoad(m, PC_LIMIT + 3)) { return {x: x, y: y}; }
    x = pcByte(x + 1);
  }
  pcStore(m, 0xD008, pcByte(x << 1));                      // `$3E40`
  if ((x >> 7) & 1) { pcStore(m, 0xD010, pcLoad(m, 0xD010) | 0x10); }
  else { pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xEF); }
  return {x: x, y: y};
} // pcCursor

/**
 * `$8516` — the clock in the panel, six digits of BCD plus the one that is
 * blank while the hour is under ten. ★ It is the **only** caller in the
 * program, so the clock is drawn nowhere but here.
 */
function pcClockDigits(m) {
  var s = pcLoad(m, PC_CLOCK + 1), mn = pcLoad(m, PC_CLOCK + 2),
      h = pcLoad(m, PC_CLOCK + 3);
  pcStore(m, 0x43B3, pcByte((s & 0x0F) + 0x80));
  pcStore(m, 0x43B2, pcByte((s >> 4) + 0x80));
  pcStore(m, 0x43B0, pcByte((mn & 0x0F) + 0x80));
  pcStore(m, 0x43AF, pcByte((mn >> 4) + 0x80));
  pcStore(m, 0x43AD, pcByte((h & 0x0F) + 0x80));
  pcStore(m, 0x43AC, (h & 0xF0) ? 0x81 : PC_BLANK);
} // pcClockDigits

/* ----------------------------------------------------------- what it says */

/**
 * `$81B8` — one of the eight sentences, two characters a frame, and then
 * the original **waits for the button** to be let go and pushed again.
 * ★ The second line is always `$81FB`, "push button": the prompt is not
 * part of the message, it is printed underneath it.
 */
function* pcSay(m, at) {
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  pcTone(m, 0x2C, 0xC1);
  var y = 0;
  while (y < 0x16) {
    yield;                                                 // `$81C5`
    for (var x = 1; x >= 0; x--) {
      pcStore(m, PC_MESSAGE + y, pcLoad(m, (at + y) & 0xFFFF));
      pcStore(m, PC_MESSAGE_COLOR + y, 0x07);
      pcStore(m, PC_PROMPT + y, pcLoad(m, PC_SAY_PROMPT + y));
      pcStore(m, 0xDB9E + y, 0x01);
      y++;
    }
  }
  while (!(pcJoy(m) & PC_JOY_FIRE)) { yield; }             // `$81EA`
  while (pcJoy(m) & PC_JOY_FIRE) { yield; }                // `$81F1`
  pcLabels(m);                                             // `$81F8`
} // pcSay

/**
 * `$7FFC` — one of the telephone's four sentences on the message line for
 * `$40` frames, and then the line is wiped. The index is **where the copy
 * ends**, which is how four twenty-two byte texts live in one run.
 */
function* pcBar(m, end) {
  var x = end;
  for (var y = 0x15; y >= 0; y--) {
    pcStore(m, PC_MESSAGE + y, pcLoad(m, PC_PHONE_TEXTS + x));
    x--;
  }
  yield* pcWait(0x40);
  for (x = 0x15; x >= 0; x--) { pcStore(m, PC_MESSAGE + x, PC_BLANK); }
} // pcBar

/* --------------------------------------------------- the buttons, one by one */

/** `$7901` — turn the chosen piece, ten steps two frames apart */
function* pcRotate(m) {
  var picked = pcLoad(m, PC_PICKED);
  if (picked & 0x80) { yield* pcSay(m, PC_SAY_NOTHING); return; }
  var at = pcSlotAddr(picked);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  var xy = [0x28, 0x8C];
  pcStore(m, 0xE4, 0x09);
  for (var i = 9; i >= 0; i--) {
    yield* pcWait(2);                                      // `$7927`
    xy = pcTurnStep(m, at, xy[0], xy[1]);
    pcStore(m, 0xE4, pcByte(i - 1));
  }
} // pcRotate

/** `$7968` — flip it, twenty-one steps one frame apart */
function* pcFlip(m) {
  var picked = pcLoad(m, PC_PICKED);
  if (picked & 0x80) { yield* pcSay(m, PC_SAY_NOTHING); return; }
  var at = pcSlotAddr(picked);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  var xy = [0x00, 0x28];
  pcStore(m, 0xE5, 0x14);
  for (var i = 0x14; i >= 0; i--) {
    yield;                                                 // `$798E`
    xy = pcFlipStep(m, at, xy[0], xy[1]);
    pcStore(m, 0xE5, pcByte(i - 1));
  }
} // pcFlip

/** `$7A89` — the one step of undo the computer has, into `$C100` */
function pcSaveUndo(m) {
  var picked = pcLoad(m, PC_PICKED);
  var at = pcSlotAddr(picked);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  for (var y = 0x8F; y >= 0; y--) {
    pcStore(m, 0xC100 + y, pcLoad(m, (at + y) & 0xFFFF));
  }
  pcStore(m, PC_UNDO, picked);
} // pcSaveUndo

/**
 * `$79E2` — the waste basket: the chosen slot is emptied and the choice
 * moves on to the next slot that has something in it, skipping 0 and 3,
 * which are the memory and not the workbench.
 */
function* pcTrash(m) {
  var picked = pcLoad(m, PC_PICKED);
  if (picked & 0x80) { yield* pcSay(m, PC_SAY_NOTHING); return; }
  pcSaveUndo(m);                                           // `$79ED`
  var at = pcSlotAddr(picked);
  for (var y = 0x8F; y >= 0; y--) { pcStore(m, (at + y) & 0xFFFF, 0x00); }
  pcStore(m, PC_FULL + picked, 0x00);
  var y2 = picked;
  for (;;) {                                               // `$7A02`
    y2++;
    if (y2 >= 6) { y2 = 1; }
    if (y2 === 3) { y2++; }
    if (y2 === picked) {                                   // `$7A1C`
      pcStore(m, PC_PICKED, 0xFF);
      pcStore(m, 0xD015, pcLoad(m, 0xD015) & 0xBF);
      return;
    }
    if (pcLoad(m, PC_FULL + y2) !== 0) {
      pcStore(m, PC_PICKED, y2);
      pcSelectSprite(m);                                   // `$7A19`
      return;
    }
  }
} // pcTrash

/** `$7A29` — one of the three colours, onto the chosen slot */
function* pcRecolour(m, colour) {
  var picked = pcLoad(m, PC_PICKED);
  if (picked & 0x80) { yield* pcSay(m, PC_SAY_NOTHING); return; }
  pcPaintSlot(m, colour, picked, true);
} // pcRecolour

/** `$7A61` — undo, and there is exactly one step of it */
function* pcUndo(m) {
  var slot = pcLoad(m, PC_UNDO);
  if (slot & 0x80) { yield* pcSay(m, PC_SAY_UNDO); return; }
  pcStore(m, PC_FULL + slot, 0x01);
  pcStore(m, PC_PICKED, slot);
  var at = pcSlotAddr(slot);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  for (var y = 0x8F; y >= 0; y--) {
    pcStore(m, (at + y) & 0xFFFF, pcLoad(m, 0xC100 + y));
  }
  pcStore(m, PC_UNDO, 0xFF);
  pcSelectSprite(m);
} // pcUndo

/**
 * `$7A9F` — the list one piece on. ★ It is not a redraw: the six character
 * rows of slots 0 and 3 **slide up one row a frame** and the colour RAM
 * slides with them, so the memory of the computer scrolls.
 */
function* pcScrollForward(m, entropy) {
  var at = pcLoad(m, PC_SCROLL);
  var any = pcLoad(m, PC_FOUND + at) | pcLoad(m, PC_FOUND + 1 + at)
          | pcLoad(m, PC_FOUND + 2 + at);
  if (any & 0x80) { yield* pcSay(m, PC_SAY_END); return; }
  pcStore(m, PC_SCROLL, pcByte(at + 1));
  at += 2;
  pcStore(m, PC_TINT, pcLoad(m, PC_FOUND_COLORS + at));
  pcCompose(m, pcLoad(m, PC_FOUND + at));
  pcStore(m, PC_PTR, 0x00); pcStore(m, PC_PTR + 1, 0x50);
  for (var x = 2; x >= 0; x--) {
    yield;                                                 // `$7ACC`
    var from = pcWord(m, PC_PTR);
    for (var y = 0x2F; y >= 0; y--) {
      pcStore(m, 0x5C50 + y, pcLoad(m, 0x5C80 + y));
      pcStore(m, 0x5C80 + y, pcLoad(m, 0x5CB0 + y));
      pcStore(m, 0x5CB0 + y, pcLoad(m, 0x5E00 + y));
      pcStore(m, 0x5E00 + y, pcLoad(m, 0x5E30 + y));
      pcStore(m, 0x5E30 + y, pcLoad(m, 0x5E60 + y));
      pcStore(m, 0x5E60 + y, pcLoad(m, (from + y) & 0xFFFF));
    }
    pcMovePtr(m, 0x30);
    var tint = pcLoad(m, PC_TINT);
    for (y = 5; y >= 0; y--) {
      pcStore(m, 0xDA87 + y, pcLoad(m, 0xDAAF + y));
      pcStore(m, 0xDAAF + y, pcLoad(m, 0xDAD7 + y));
      pcStore(m, 0xDAD7 + y, pcLoad(m, 0xDAFF + y));
      pcStore(m, 0xDAFF + y, pcLoad(m, 0xDB27 + y));
      pcStore(m, 0xDB27 + y, pcLoad(m, 0xDB4F + y));
      pcStore(m, 0xDB4F + y, tint);
    }
  }
  pcStore(m, PC_COLORS + 0, pcLoad(m, 0xDA87));            // `$7B27`
  pcStore(m, PC_COLORS + 3, pcLoad(m, 0xDAFF));
} // pcScrollForward

/** `$7B32` — and the same the other way */
function* pcScrollBack(m, entropy) {
  if (pcLoad(m, PC_SCROLL) === 0) { yield* pcSay(m, PC_SAY_END); return; }
  pcStore(m, PC_SCROLL, pcByte(pcLoad(m, PC_SCROLL) - 1));
  var at = pcLoad(m, PC_SCROLL);
  pcStore(m, PC_TINT, pcLoad(m, PC_FOUND_COLORS + at));
  pcCompose(m, pcLoad(m, PC_FOUND + at));
  pcStore(m, PC_PTR, 0x60); pcStore(m, PC_PTR + 1, 0x50);
  for (var x = 2; x >= 0; x--) {
    yield;                                                 // `$7B56`
    var from = pcWord(m, PC_PTR);
    for (var y = 0x2F; y >= 0; y--) {
      pcStore(m, 0x5E60 + y, pcLoad(m, 0x5E30 + y));
      pcStore(m, 0x5E30 + y, pcLoad(m, 0x5E00 + y));
      pcStore(m, 0x5E00 + y, pcLoad(m, 0x5CB0 + y));
      pcStore(m, 0x5CB0 + y, pcLoad(m, 0x5C80 + y));
      pcStore(m, 0x5C80 + y, pcLoad(m, 0x5C50 + y));
      pcStore(m, 0x5C50 + y, pcLoad(m, (from + y) & 0xFFFF));
    }
    pcMovePtr(m, -0x30);
    var tint = pcLoad(m, PC_TINT);
    for (y = 5; y >= 0; y--) {
      pcStore(m, 0xDB4F + y, pcLoad(m, 0xDB27 + y));
      pcStore(m, 0xDB27 + y, pcLoad(m, 0xDAFF + y));
      pcStore(m, 0xDAFF + y, pcLoad(m, 0xDAD7 + y));
      pcStore(m, 0xDAD7 + y, pcLoad(m, 0xDAAF + y));
      pcStore(m, 0xDAAF + y, pcLoad(m, 0xDA87 + y));
      pcStore(m, 0xDA87 + y, tint);
    }
  }
  pcStore(m, PC_COLORS + 0, pcLoad(m, 0xDA87));
  pcStore(m, PC_COLORS + 3, pcLoad(m, 0xDAFF));
} // pcScrollBack

/* ------------------------------------------------- a puzzle comes together */

/**
 * `$816E` — one piece out of the list, and everything behind it moves up.
 * ★ The list has no length: it ends at the `$FF` that `$39C1 STY $4EF5`
 * put there at the start of the game (§27), and this walks to it.
 */
function pcRemovePiece(m, piece) {
  pcStore(m, 0xE7, piece);
  var x = 0;
  for (;;) {                                               // `$8172`
    if ((pcLoad(m, PC_FOUND + x) & 0x3F) === pcByte(piece)) { break; }
    if (pcLoad(m, PC_FOUND + x) & 0x80) { x = -1; break; }
    x++;
  }
  if (x >= 0) {
    for (;;) {                                             // `$8184`
      pcStore(m, PC_FOUND_COLORS + x, pcLoad(m, PC_FOUND_COLORS + 1 + x));
      var next = pcLoad(m, PC_FOUND + 1 + x);
      pcStore(m, PC_FOUND + x, next);
      if (next & 0x80) { break; }
      x++;
    }
  }
  var at = pcLoad(m, PC_SCROLL);                           // `$8196`
  if (at !== 0 && (pcLoad(m, PC_FOUND + at) & 0x80)) {
    pcStore(m, PC_SCROLL, pcByte(at - 1));
  }
  at = pcLoad(m, PC_SCROLL);                               // `$81A1`
  pcPaintSlot(m, pcLoad(m, PC_FOUND_COLORS + at), 0, true);
  pcPaintSlot(m, pcLoad(m, PC_FOUND_COLORS + 1 + at), 3, true);
} // pcRemovePiece

/**
 * `$80B6` — is the chosen slot one of the nine cards? ★ The cards are
 * `$C9F0`-`$CEFF`, which §9 read as a grid of platforms and §15 corrected:
 * nine pictures of `$90` bytes, and the slot is compared against each of
 * them byte for byte. A hit is a hundred points, a letter of the password
 * revealed into the shaft's panel, and the puzzle's four pieces gone.
 */
function* pcCheckSolved(m) {
  var picked = pcLoad(m, PC_PICKED);
  var at = pcSlotAddr(picked);
  pcStore(m, PC_PTR, at & 0xFF); pcStore(m, PC_PTR + 1, at >> 8);
  var card = PC_CARDS, left = 8, hit = -1;
  for (; left >= 0; left--, card = (card + PC_SLOT) & 0xFFFF) {
    var same = true;
    for (var y = 0x8F; y >= 0; y--) {
      if (pcLoad(m, (at + y) & 0xFFFF) !== pcLoad(m, (card + y) & 0xFFFF)) {
        same = false; break;
      }
    }
    if (same) { hit = 8 - left; break; }                   // `$80E7`
  }
  pcStore(m, 0xE4, card & 0xFF); pcStore(m, 0xE5, card >> 8);
  pcStore(m, 0xE6, pcByte(left));
  if (hit < 0) { return; }
  if (pcLoad(m, PC_SOLVED + hit) !== 0) {                  // `$80EF`
    yield* pcSay(m, PC_SAY_AGAIN); return;
  }
  pcDid(m, 'solved');
  pcStore(m, PC_SOLVED + hit, pcByte(pcLoad(m, PC_SOLVED + hit) + 1));
  pcStore(m, PC_PUZZLES, pcByte(pcLoad(m, PC_PUZZLES) + 1));
  // ★ **Jedno písmeno hesla** (`$80FF`): do panelu šachty (`$345D`) i na
  // obrazovku (`$43A2`) — a je to táž devítice, kterou vylosoval generátor
  // na `$4FB5` (§14). Devět skládaček je devět písmen.
  var letter = pcLoad(m, PC_PASSWORD + hit);
  pcStore(m, 0x345D + hit, letter);
  pcStore(m, 0x43A2 + hit, letter);
  var base = pcByte(hit << 2);                             // `$8109`
  pcStore(m, 0xE4, 0x03);
  for (var i = 3; i >= 0; i--) {
    pcRemovePiece(m, pcByte(base + (3 - i)));
    pcStore(m, 0xE4, pcByte(i - 1));
  }
  yield;                                                   // `$8119`
  for (var x = 0x8F; x >= 0; x--) {
    pcStore(m, 0x5C50 + x, 0x00); pcStore(m, 0x5E00 + x, 0x00);
  }
  var scroll = pcLoad(m, PC_SCROLL);
  var top = pcLoad(m, PC_FOUND + scroll);
  if (!(top & 0x80)) {
    pcCompose(m, top);
    for (x = 0x8F; x >= 0; x--) { pcStore(m, 0x5C50 + x, pcLoad(m, PC_SCRATCH + x)); }
    var next = pcLoad(m, PC_FOUND + 1 + pcLoad(m, PC_SCROLL));
    if (!(next & 0x80)) {
      pcCompose(m, next);
      for (x = 0x8F; x >= 0; x--) { pcStore(m, 0x5E00 + x, pcLoad(m, PC_SCRATCH + x)); }
    }
  }
  // ★ **Tahle dvojice se do snímku nevejde** — dvě stě osmdesát osm bajtů
  // vymazaných a dvakrát `$9C3A` — takže `$7F6D` ve vlnce začne odpočítávat
  // až o snímek později. Změřeno na `compsolve42` (`$5E01` je ve výpisu
  // ještě vynulované, ne složené), ne odhadnuto; táž mez jako u mapy
  // a jako u hlavní smyčky v těžké místnosti (§19). Ten jeden snímek je
  // z rozdělané práce, takže se nedá srovnávat — přepis to přizná.
  if (m.pc) { m.pc.overrun = 1; }
  yield;
  for (var flash = 4; flash >= 0; flash--) {               // `$8159`
    pcClickTone(m);
    yield* pcWait(0x10);
  }
  yield* pcTrash(m);                                       // `$8166`
  pcStore(m, PC_UNDO, 0xFF);
} // pcCheckSolved

/* --------------------------------------------------------- the telephone */

/** `$7E9E` — the noise on the line, and every length in it is shuffled */
function* pcLine(m, entropy) {
  var a = pcRandom(m, entropy) & 0x0F;
  yield* pcWait(pcByte(a + 0x1F + m.pcCarry));             // `$7EA3 ADC #$1F`
  pcStore(m, 0xD40F, 0x03);
  var x = pcRandom(m, entropy) & 0x03;
  for (; x >= 0; x--) { yield* pcCrackle(m, entropy); }
  yield* pcWait(pcRandom(m, entropy) & 0x0F);
  pcStore(m, 0xD407, 0x80); pcStore(m, 0xD40E, 0x80);
  pcStore(m, 0xD408, 0x28); pcStore(m, 0xD40F, 0x1E);
  pcStore(m, 0xD418, 0x15);
  for (x = 0x13; x >= 0; x--) {                            // `$7EDA`
    yield;
    pcStore(m, 0xD40B, 0x11); pcStore(m, 0xD412, 0x11);
    yield* pcWait(2);
    pcStore(m, 0xD40B, 0x00); pcStore(m, 0xD412, 0x00);
  }
  yield* pcWait(pcRandom(m, entropy) & 0x1F);
  pcStore(m, 0xD40F, 0x03);
  x = pcRandom(m, entropy) & 0x01;
  for (; x >= 0; x--) { yield* pcCrackle(m, entropy); }
  pcStore(m, 0xD40E, 0x8D); pcStore(m, 0xD40F, 0x8E);
  pcStore(m, 0xD407, 0x5E); pcStore(m, 0xD408, 0x51);
  pcStore(m, 0xD409, 0x00); pcStore(m, 0xD410, 0x00);
  pcStore(m, 0xD40A, 0x08); pcStore(m, 0xD411, 0x08);
  pcStore(m, 0xD418, 0x02);
  pcStore(m, 0xD412, 0x41);
  yield* pcWait(0x20);
  pcStore(m, 0xD40B, 0x41);
  yield* pcWait(0x30);
  pcStore(m, 0xD40B, 0x00); pcStore(m, 0xD412, 0x00);
} // pcLine

/**
 * `$7F54` — one crackle: two frames, and ★ **a draw from the mixer that is
 * thrown away** (`$7F66 JSR $82D6 / AND #$0F` falls straight into
 * `$7F6B LDA #$01`, which overwrites it). It still moves the shuffle on,
 * so it has to be here.
 */
function* pcCrackle(m, entropy) {
  pcStore(m, 0xD412, 0x21); pcStore(m, 0xD418, 0x05);
  yield;
  pcStore(m, 0xD412, 0x00);
  pcRandom(m, entropy);
  yield;
} // pcCrackle

/** `$7DB9` — seven notes of the voice at the other end */
function* pcPhoneVoice(m, tune) {
  for (var x = 6; x >= 0; x--) {
    yield* pcWait(4);
    pcStore(m, 0xD40B, 0x00); pcStore(m, 0xD412, 0x00);
    yield* pcWait(2);
    var note = pcLoad(m, tune + x);
    if (note === 0) { note = 0x0B; }
    pcPhoneNote(m, note);
  }
  pcStore(m, PC_SOUND, 0x04);
} // pcPhoneVoice

/**
 * `$7F80` — "orientation corrected", and it is the one thing in the
 * computer that **rewrites the game's own data**: bit 6 of the list entry
 * says the player has asked, and bits 2 and 3 of the piece's record — the
 * scrambling `$B176` gave it — are cleared for good.
 */
function* pcHintOrientation(m) {
  var at = pcLoad(m, PC_SCROLL);
  if (pcLoad(m, PC_FOUND + at) & 0x80) {
    yield* pcBar(m, PC_TEXT_MEMORY); return;
  }
  var one = pcLoad(m, PC_FOUND + at) | 0x40;
  pcStore(m, PC_FOUND + at, one);
  var rec = (PC_RECORDS + 3 + pcByte(one << 2)) & 0xFFFF;
  pcStore(m, 0xE4, pcLoad(m, rec));
  pcStore(m, rec, pcLoad(m, rec) & 0x03);
  pcOrient(m, 0x5C50, pcLoad(m, 0xE4));
  var two = pcLoad(m, PC_FOUND + 1 + at);
  if (!(two & 0x80)) {
    two |= 0x40;
    pcStore(m, PC_FOUND + 1 + at, two);
    rec = (PC_RECORDS + 3 + pcByte(two << 2)) & 0xFFFF;
    pcStore(m, 0xE4, pcLoad(m, rec));
    pcStore(m, rec, pcLoad(m, rec) & 0x03);
    pcOrient(m, 0x5E00, pcLoad(m, 0xE4));
  }
  yield* pcBar(m, PC_TEXT_ORIENT);
} // pcHintOrientation

/**
 * `$7FCA` — "a solution exists" or "need more pieces": how many of the
 * pieces written down belong to the same puzzle as the one on top of the
 * list. Four is a solution.
 */
function* pcHintSolution(m) {
  var at = pcLoad(m, PC_SCROLL);
  if (pcLoad(m, PC_FOUND + at) & 0x80) {
    yield* pcBar(m, PC_TEXT_MEMORY); return;
  }
  var want = pcLoad(m, (PC_RECORDS + pcByte(pcLoad(m, PC_FOUND + at) << 2)) & 0xFFFF);
  pcStore(m, 0xE4, want);
  var count = 0, x = 0;
  for (; ; x++) {
    var entry = pcLoad(m, PC_FOUND + x);
    if (entry & 0x80) { break; }
    if (pcLoad(m, (PC_RECORDS + pcByte(entry << 2)) & 0xFFFF) === want) { count++; }
  }
  pcStore(m, 0xE5, pcByte(count));
  yield* pcBar(m, count >= 4 ? PC_TEXT_SOLUTION : PC_TEXT_MORE);
} // pcHintSolution

/** `$7BC2` — the telephone takes the lower half of the screen */
function* pcPhoneOpen(m) {
  pcStore(m, PC_MODE, pcByte(pcLoad(m, PC_MODE) + 1));
  yield;                                                   // `$7BC4`
  pcClearMessage(m);
  pcStore(m, 0xD015, pcLoad(m, 0xD015) & 0x9F);
  pcStore(m, PC_DRAW, 0x9E); pcStore(m, PC_DRAW + 1, 0x43);
  pcStore(m, PC_DRAW_COLOR, 0x9E); pcStore(m, PC_DRAW_COLOR + 1, 0xDB);
  var x = 0xAF;
  while (x !== 0xFF) {                                     // `$7BE2`
    for (var y = 0x15; y >= 0; y--) {
      pcStore(m, PC_PHONE_PARKED + x,
              pcLoad(m, (pcWord(m, PC_DRAW_COLOR) + y) & 0xFFFF));
      pcStore(m, (pcWord(m, PC_DRAW) + y) & 0xFFFF,
              pcLoad(m, PC_PHONE_COLORS + x));
      x = pcByte(x - 1);
    }
    pcAdvance(m, -0x28);
  }
  pcStore(m, PC_DRAW, 0x86); pcStore(m, PC_DRAW + 1, 0xDA);  // `$7BF9`
  for (x = 7; x >= 0; x--) {
    var colour = pcLoad(m, PC_PHONE_SCREEN + x);
    for (y = 0x15; y >= 2; y--) {
      pcStore(m, (pcWord(m, PC_DRAW) + y) & 0xFFFF, colour);
    }
    pcStore(m, (pcWord(m, PC_DRAW) + 1) & 0xFFFF, 0x09);
    pcStore(m, pcWord(m, PC_DRAW) & 0xFFFF, 0x09);
    pcAdvance(m, 0x28);
  }
  pcStore(m, PC_LIMIT + 2, 0x28); pcStore(m, PC_LIMIT + 3, 0x24);
  pcStore(m, PC_LIMIT + 0, 0xB3); pcStore(m, PC_LIMIT + 1, 0xEF);
  yield* pcWait(3);
  pcStore(m, 0xD009, 0xEF); pcStore(m, 0xD008, 0x4E);
} // pcPhoneOpen

/** `$7E05` — and gives it back, colours out of `$C220` and panel out of `$3340` */
function* pcPhoneClose(m) {
  pcClearMessage(m);
  pcStore(m, PC_DRAW, 0x9E); pcStore(m, PC_DRAW + 1, 0xDB);
  var x = 0xAF;
  while (x !== 0xFF) {
    for (var y = 0x15; y >= 0; y--) {
      pcStore(m, (pcWord(m, PC_DRAW) + y) & 0xFFFF, pcLoad(m, PC_PHONE_PARKED + x));
      x = pcByte(x - 1);
    }
    pcAdvance(m, -0x28);
  }
  yield* pcPanel(m);
  pcLabels(m);
  pcSelectSprite(m);
  pcIndicator(m);
  pcStore(m, 0xD418, 0x05);
} // pcPhoneClose

/**
 * `$7D8C` — what the telephone was asked. ★ Both questions cost **two
 * minutes** (`SED`, `LDA #$02`, `JSR $83C2` — the same routine the clock
 * ticks by, §31), which is exactly what the manual says.
 */
function* pcPhoneMenu(m, y, entropy) {
  if (y >= 0xE8) { yield* pcPhoneClose(m); return true; }
  if (y >= 0xE1) { return false; }
  var second = y >= 0xC8;
  if (!second && y >= 0xC2) { return false; }
  player.clockAdd(m, 0x02);                                // `$7D9F`
  yield* pcPhoneVoice(m, second ? PC_PHONE_TUNE + 7 : PC_PHONE_TUNE);
  yield* pcLine(m, entropy);
  if (second) { yield* pcHintSolution(m); }
  else { yield* pcHintOrientation(m); }
  return false;
} // pcPhoneMenu

/* ---------------------------------------------------------------- the map */

/**
 * `$B644`-`$B68D` — the half of the map button that swaps the **window of
 * the computer's character set**: the six slots are parked in `$C690` and
 * the picture the map shuffle drew (`$FC00`, §11) takes their place, with
 * the legend from `$B563` behind it. `$3E5C` on the way into the computer
 * is the other half of this.
 *
 * ★ It is **not only the map button** that does it: `$3A12` calls `$B63B`
 * when a game starts, before the shaft loop ever runs. Without it the
 * window keeps whatever the disk left in those glyphs — nothing — so every
 * square of the map in the panel is drawn with the blank `$FC`, and the map
 * is a wall of solid blocks instead of shafts and rooms (nahlásil operátor
 * 2026-09-21). The picture is **losovaná**, so `data/charset_computer.json`
 * cannot carry it (§14).
 *
 * @param {Object} m - The machine.
 */
function pcMapWindow(m) {
  for (var x = 0; x < 0x100; x++) {
    pcStore(m, 0xC690 + x, pcLoad(m, 0x5C50 + x));
    pcStore(m, 0x5C50 + x, pcLoad(m, PC_MAP_PICTURE + x));
    pcStore(m, 0xC790 + x, pcLoad(m, 0x5D50 + x));
    pcStore(m, 0x5D50 + x, pcLoad(m, PC_MAP_PICTURE + 0x100 + x));
    pcStore(m, 0xC890 + x, pcLoad(m, 0x5E50 + x));
    pcStore(m, 0x5E50 + x, pcLoad(m, PC_MAP_PICTURE + 0x200 + x));
  }
  for (x = 0x2F; x >= 0; x--) {
    pcStore(m, 0xC990 + x, pcLoad(m, 0x5F50 + x));
    pcStore(m, 0x5F50 + x, pcLoad(m, PC_MAP_PICTURE + 0x300 + x));
  }
  for (x = 0x2F; x >= 0; x--) {
    pcStore(m, 0xC9C0 + x, pcLoad(m, 0x5F80 + x));
    pcStore(m, 0x5F80 + x, pcLoad(m, PC_MAP_LEGEND + x));
  }
} // pcMapWindow

/**
 * `$B63B` — the map button, and ★ **it is the way out of the computer**:
 * the six slots are parked in `$C690`, the picture the map shuffle drew
 * (`$FC00`, §11) takes their place in the font, a frame is drawn round it
 * and the original jumps back to the shaft loop. `$3E5C` on the way in is
 * the other half of this.
 */
function* pcMap(m) {
  var x;
  yield;                                                   // `$B63B`
  pcClearMessage(m);
  yield;                                                   // `$B641`
  pcMapWindow(m);                                          // `$B644`-`$B68D`
  pcStore(m, PC_DRAW, 0x87); pcStore(m, PC_DRAW + 1, 0x42);
  pcStore(m, PC_DRAW_COLOR, 0x87); pcStore(m, PC_DRAW_COLOR + 1, 0xDA);
  var draw = function (y, v) { pcStore(m, (pcWord(m, PC_DRAW) + y) & 0xFFFF, v); };
  var tint = function (y, v) { pcStore(m, (pcWord(m, PC_DRAW_COLOR) + y) & 0xFFFF, v); };
  var y;
  for (y = 0x14; y >= 0; y--) { draw(y, 0xF4); tint(y, 0x07); }
  draw(0, 0xF0); draw(0x14, 0xF1);
  pcAdvance(m, 0x28);
  x = 0;
  for (var row = 5; row >= 0; row--) {                     // `$B6BE`
    y = 0;
    draw(y, 0xF5); tint(y, 0x07); y++;
    draw(y, 0xFC); tint(y, 0x05); y++;
    for (; y < 0x13; y++, x++) {                           // `$B6D2`
      draw(y, pcLoad(m, PC_MAP_CHARS + x)); tint(y, 0x05);
    }
    draw(y, 0xFC); tint(y, 0x05); y++;
    draw(y, 0xF5); tint(y, 0x07);
    pcAdvance(m, 0x28);
  }
  for (y = 0x14; y >= 0; y--) { draw(y, 0xF4); tint(y, 0x07); }
  draw(0, 0xF2); draw(0x14, 0xF3);
  pcMapMarker(m);                                          // `$B6FE`-`$B74B`
} // pcMap

/**
 * `$B6FE`-`$B74B` — the other half of the map button: the **marker of the
 * cabin** on the map. ★ It is a sprite, and its block is built on the spot:
 * three dots (`$C0` in bytes 0, 3 and 6 of an otherwise empty `$4D80`), the
 * place out of `$27`/`$28`, and `$43FE` = `$36`, which is exactly that
 * block. ★ Without it sprite 6 keeps whatever pointer it had and the map
 * has a blob on it instead of the marker (`--start` had `$C0`).
 * @param {Object} m - The machine.
 */
function pcMapMarker(m) {
  for (var x = 0x3F; x >= 0; x--) { pcStore(m, PC_BLOCK_A + x, 0x00); }
  pcStore(m, PC_BLOCK_A + 0, 0xC0);
  pcStore(m, PC_BLOCK_A + 3, 0xC0);
  pcStore(m, PC_BLOCK_A + 6, 0xC0);
  pcStore(m, 0xD00C, pcLoad(m, 0x27));                     // `$B727` — kabina
  pcStore(m, 0xD00D, pcLoad(m, 0x28));
  pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xBF);
  pcStore(m, 0xD02D, 0x00);
  pcStore(m, 0xD01D, pcLoad(m, 0xD01D) & 0xBF);
  pcStore(m, PC_PTR6, 0x36);
} // pcMapMarker

/* ------------------------------------------------------------ the dispatch */

/**
 * `$3B43` — which of the six slots the hand is over, in half-pixels.
 * @returns {number} The slot, or -1 for the gaps between them.
 */
function pcHitSlot(m) {
  var y = 0, a = pcLoad(m, 0xD009);
  if (a >= 0xB8) {
    if (a < 0xC5) { return -1; }
    y = 3;
  }
  a = pcLoad(m, 0xD008) >> 1;                              // `$3B52`
  if (a < 0x32) { return y; }
  y++;
  if (a < 0x44) { return -1; }
  if (a < 0x4E) { return y; }
  y++;
  if (a >= 0x5F) { return y; }
  return -1;
} // pcHitSlot

/**
 * `$3B43`-`$3C1E` — putting a carried piece down. ★ The refusals are in
 * order: the slot it came from means "never mind", the memory slots refuse
 * outright, a full slot has to agree in colour and then in shape.
 */
function* pcDrop(m) {
  pcDid(m, 'drop');
  var slot = pcHitSlot(m);
  if (slot < 0) { return; }
  if (slot === pcLoad(m, PC_FROM)) {                       // `$3B6B`
    pcTone(m, 0x96, 0x8B);
    pcCursorAt(m, slot);
    pcSelectSprite(m);
    pcIndicator(m);
    return;
  }
  if (slot === 0 || slot === 3) { pcTone(m, 0x2C, 0xC1); return; }
  var colour = pcLoad(m, 0xD02C);
  if (pcLoad(m, PC_FULL + slot) !== 0) {                   // `$3B9F`
    pcStore(m, 0xE4, colour & 0x0F);
    var at = pcLoad(m, PC_SLOT_COLOR_LO + slot)
           | (pcLoad(m, PC_SLOT_COLOR_HI + slot) << 8);
    if ((pcLoad(m, at) & 0x0F) !== (colour & 0x0F)) {      // `$3BAB`
      pcStore(m, PC_UNDO, 0xFF);
      yield* pcSay(m, PC_SAY_COLORS); return;
    }
    if (pcOverlap(m, slot)) {                              // `$3BBA`
      pcStore(m, PC_UNDO, 0xFF);
      yield* pcSay(m, PC_SAY_OVERLAP); return;
    }
    pcStore(m, PC_PICKED, slot);                           // `$3BD5`
    pcSaveUndo(m);
  } else {
    // ★ `$3BD1 STY $8F / BMI $3BDA` — **`STY` nemění příznaky**, takže
    // `BMI` se řídí `LDA #$FF` o dva řádky výš a **vždycky se vezme**:
    // do prázdného slotu se undo neukládá
    pcStore(m, PC_UNDO, 0xFF);
    pcStore(m, PC_PICKED, slot);
  }
  pcStore(m, PC_FULL + slot, 0x01);                        // `$3BDA`
  pcPaintSlot(m, colour, slot, true);
  pcTone(m, 0x96, 0x8B);                                   // `$3C08`
  pcTransfer(m, pcLoad(m, PC_PICKED));                     // `$3FA7`
  yield* pcPanel(m);                                       // `$3E7F`
  pcSelectSprite(m);
  yield* pcCheckSolved(m);                                 // `$80B6`
  pcIndicator(m);
} // pcDrop

/** `$3D24` — picking a piece up: it rides on sprites 4 and 5 from here on */
function* pcPickUp(m, slot) {
  pcStore(m, PC_FROM, slot);
  pcTone(m, 0x7E, 0x97);
  pcStore(m, 0xD015, pcLoad(m, 0xD015) & 0xCF);
  pcTransfer(m, slot);                                     // `$3FA9`, `$9F` je 1
  yield;                                                   // `$3D39`
  pcStore(m, PC_PTR4, 0x36); pcStore(m, PC_PTR5, 0x37);
  var x = pcLoad(m, PC_SLOT_X + slot);
  pcStore(m, 0xD008, x); pcStore(m, 0xD00A, pcByte(x + 0x18));
  var y = pcLoad(m, PC_SLOT_Y + slot);
  pcStore(m, 0xD009, y); pcStore(m, 0xD00B, y);
  pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xCF);
  var colour = pcLoad(m, PC_COLORS + slot);
  pcStore(m, 0xD02B, colour); pcStore(m, 0xD02C, colour);
  pcStore(m, 0xD01D, pcLoad(m, 0xD01D) & 0xCF);
  pcStore(m, 0xD017, pcLoad(m, 0xD017) & 0xCF);
  pcStore(m, 0xD015, pcLoad(m, 0xD015) | 0x30);
  pcStore(m, PC_LIMIT + 0, 0xB3); pcStore(m, PC_LIMIT + 1, 0xCA);
  pcStore(m, PC_LIMIT + 2, 0x29); pcStore(m, PC_LIMIT + 3, 0x64);
  pcStore(m, PC_MODE, 0x00);
} // pcPickUp

/**
 * `$3CBA`-`$3E05` — what the hand was pointing at when the button went
 * down. ★ Everything is decided in **half-pixels** and nothing is a table:
 * three rows of three buttons on the right, three on the left and the six
 * slots in between.
 * @returns {string} `'exit'` when the map button ends the session.
 */
function* pcClick(m, x, y, entropy) {
  if (x >= 0x84) {                                         // `$3C21`
    if (y < 0xB1) { return ''; }
    if (y < 0xC1) {                                        // `$3C2C`
      if (x < 0x8C) { pcDid(m, 'rotate'); pcClickTone(m); yield* pcRotate(m); yield* pcCheckSolved(m); return ''; }
      if (x < 0x90) { return ''; }
      if (x < 0x98) { pcDid(m, 'flip'); pcClickTone(m); yield* pcFlip(m); yield* pcCheckSolved(m); return ''; }
      if (x < 0x9C) { return ''; }
      pcDid(m, 'trash'); pcClickTone(m); yield* pcTrash(m); return '';
    }
    if (y < 0xC9) { return ''; }
    if (y < 0xD9) {                                        // `$3C49`
      if (x < 0x8C) {                                      // `$3DDA` — mapa a odchod
        pcDid(m, 'map');
        pcClickTone(m);
        pcStore(m, 0xD015, pcLoad(m, 0xD015) & 0x8F);
        yield* pcMap(m);
        pcStore(m, 0xD015, pcLoad(m, 0xD015) | 0x40);
        return 'exit';
      }
      if (x < 0x90) { return ''; }
      if (x < 0x98) { pcDid(m, 'undo'); pcClickTone(m); yield* pcUndo(m); return ''; }
      if (x < 0x9C) { return ''; }
      // ★ `$3DBE` — `INC $D5`, hláška, `$D5 = 0`. `$D5` **nikdo nečte**:
      // v celém programu jsou to jediné dva zápisy do něj (`disasm_notes` §34)
      pcDid(m, 'suspend');
      pcClickTone(m);
      pcStore(m, PC_SUSPEND, pcByte(pcLoad(m, PC_SUSPEND) + 1));
      yield* pcSay(m, PC_SAY_TIME);
      pcStore(m, PC_SUSPEND, 0x00);
      return '';
    }
    if (y < 0xE1) { return ''; }
    if (x < 0x8C) { pcDid(m, 'colour'); pcClickTone(m); yield* pcRecolour(m, 0x05); return ''; }
    if (x < 0x90) { return ''; }
    if (x < 0x98) { pcDid(m, 'colour'); pcClickTone(m); yield* pcRecolour(m, 0x07); return ''; }
    if (x < 0x9C) { return ''; }
    pcDid(m, 'colour'); pcClickTone(m); yield* pcRecolour(m, 0x03); return '';
  }
  if (y < 0xDF && x < 0x7A && x >= 0x28) {                 // `$3CBA` — šest slotů
    var slot = (y < 0xC7) ? 0 : 3;
    if (x >= 0x40) {
      slot++;
      if (x < 0x48) { return ''; }
      if (x >= 0x60) {
        slot++;
        if (x < 0x64) { return ''; }
      }
    }
    yield* pcSlotClick(m, slot);
    return '';
  }
  if (x < 0x13 || x >= 0x1C) { return ''; }                // `$3C8A`
  if (y < 0xBF) { pcDid(m, 'scroll'); yield* pcScrollForward(m, entropy); pcIndicator(m); return ''; }
  if (y < 0xC8) { return ''; }
  if (y < 0xD7) { pcDid(m, 'scroll'); yield* pcScrollBack(m, entropy); pcIndicator(m); return ''; }
  if (y < 0xE0) { return ''; }
  pcDid(m, 'phone');
  yield* pcPhoneOpen(m);
  return '';
} // pcClick

/** `$3F83` — the click every button on the right-hand side makes */
function pcClickTone(m) { pcTone(m, 0xC8, 0xF3); }

/**
 * `$3CE0` — one of the six slots was chosen. ★ Clicking the slot that is
 * already chosen **picks the piece up**; clicking another one only moves
 * the choice, and an empty one is refused.
 */
function* pcSlotClick(m, slot) {
  var picked = pcLoad(m, PC_PICKED);
  if (slot !== picked) {
    if (slot !== 0 && slot !== 3) {                        // `$3CE4`
      if (pcLoad(m, PC_FULL + slot) === 0) {
        pcTone(m, 0x2C, 0xC1); return;                     // `$3CF0`
      }
      pcStore(m, PC_PICKED, slot);                         // `$3CFA`
      pcStore(m, PC_UNDO, 0xFF);
      yield;                                               // `$3D00`
      pcTone(m, 0x64, 0x79);
      pcSelectSprite(m);
      return;
    }
    // ★ `$3D13 LDA $4EF5` — **bez indexu**: ptá se na **první** položku
    // seznamu, ne na tu zobrazenou. Tak to originál má a tak se to měří.
    if (pcLoad(m, PC_FOUND) === 0xFF) { pcTone(m, 0x2C, 0xC1); return; }
    if (slot !== 0 && pcLoad(m, PC_FOUND + 1) === 0xFF) {
      pcTone(m, 0x2C, 0xC1); return;
    }
  }
  pcDid(m, 'pick');
  yield* pcPickUp(m, slot);                                // `$3D24`
} // pcSlotClick

/* ------------------------------------------------------------ the session */

/**
 * `$3AC6` and the loop at `$3AF5` — the whole visit to the computer, from
 * the button in the shaft to the map that ends it.
 *
 * ★ Every `yield` is one `JSR $7F6B`, so the generator and the original
 * spend frames in step; the interrupt of the game goes on running around
 * it (the computer holds no `SEI`), which is why the clock keeps ticking
 * and why the clock running out ends the game from in here (`$83EA`).
 */
function* pcRun(m, entropy) {
  yield;                                                   // `$3AC6 JSR $7F6B`
  pcStore(m, 0xD010, pcLoad(m, 0xD010) & 0xCF);
  pcStore(m, 0xD01C, pcLoad(m, 0xD01C) & 0x8F);
  pcClearMessage(m);                                       // `$7218`
  pcRestoreWindow(m);                                      // `$3E5C`
  pcTone(m, 0x64, 0x79);
  pcSlotColours(m);                                        // `$7427`
  pcLabels(m);                                             // `$8018`
  yield* pcPanel(m);                                       // `$3E7F`
  pcSelectSprite(m);                                       // `$3EE3`
  pcIndicator(m);                                          // `$3F16`
  for (;;) {
    yield;                                                 // `$83EA JSR $7F6B`
    if (pcLoad(m, PC_DEATH) & 0x80) {                      // `$83ED` — vypršel čas
      m.pc.gameOver = 1;
      return;
    }
    var mode = pcLoad(m, PC_MODE);
    if (mode < 0x02) { pcClockDigits(m); }                 // `$3AFF`
    if (mode === 0x02) { pcRing(m); }                      // `$3B05`
    var hand = pcCursor(m);                                // `$3E08`
    if (pcLoad(m, PC_MODE) === 0) {                        // `$3B0B`
      pcStore(m, 0xD00A, pcByte(pcLoad(m, 0xD008) + 0x18));
      pcStore(m, 0xD00B, pcLoad(m, 0xD009));
    }
    if (pcJoy(m) & PC_JOY_FIRE) {                          // `$3B1E`
      pcStore(m, PC_FIRE_EDGE, 0x00);
      continue;
    }
    if (pcLoad(m, PC_FIRE_EDGE) !== 0) { continue; }       // `$3B2C`
    pcStore(m, PC_FIRE_EDGE, pcByte(pcLoad(m, PC_FIRE_EDGE) + 1));
    mode = pcLoad(m, PC_MODE);
    if (mode === 0) { yield* pcDrop(m); continue; }        // `$3B34`
    if (mode >= 0x02) { yield* pcPhoneMenu(m, hand.y, entropy); continue; }
    if ((yield* pcClick(m, hand.x, hand.y, entropy)) === 'exit') { return; }
  }
} // pcRun

/**
 * The computer opens. ★ The generator is advanced **once at once**: the
 * `JSR $7F6B` of `$3AC6` belongs to the frame the button was seen in, and
 * everything after it to the next one.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - The replaceable source (§8).
 * @returns {Object} The session, for `pcFrame`.
 */
function pcStart(m, entropy) {
  m.pc = {joy: 0x7F, gameOver: 0};
  var st = {gen: pcRun(m, entropy), done: false};
  st.gen.next();
  return st;
} // pcStart

/**
 * One frame of the computer.
 * @param {Object} m - The machine.
 * @param {Object} st - What `pcStart` gave.
 * @param {number} joy - What `$DC00` would give; port 2, active low.
 * @returns {Object} `done` when the session is over, `gameOver` when the
 *   clock ran out inside it (`$83EA`).
 */
function pcFrame(m, st, joy) {
  m.pc.joy = joy & 0xFF;
  m.pc.did = ''; m.pc.overrun = 0;
  var step = st.gen.next();
  if (step.done) { st.done = true; }
  return {done: st.done ? 1 : 0, gameOver: m.pc.gameOver || 0, did: m.pc.did,
          overrun: m.pc.overrun || 0};
} // pcFrame

// published the way every classic worker script is
// (`svision/tools/classicScript.cjs`): in the worker through `self`, under
// Node through `module.exports` — the same file
var pocketComputer = {
  seedMemory: pcSeedMemory,
  start: pcStart, frame: pcFrame,
  // ★ `$B644`: okno sady s obrázkem mapy sází i **rozběh hry** (`$3A12`)
  mapWindow: pcMapWindow, mapMarker: pcMapMarker,
  compose: pcCompose, orient: pcOrient, slotAddr: pcSlotAddr,
  // ★ `$3E08` je ruka **obou** zvláštních místností taky (§35), tak se sdílí
  cursor: pcCursor, tone: pcTone, wait: pcWait,
  WINDOW: PC_WINDOW, SLOT: PC_SLOT, SLOTS: PC_SLOTS, PARKED: PC_PARKED
};
if (typeof self !== 'undefined') { self.pocketComputer = pocketComputer; }
if (typeof module !== 'undefined' && module.exports) { module.exports = pocketComputer; }
