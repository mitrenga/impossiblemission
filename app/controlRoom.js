// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The control room — `$AA40`, and there is **one** of it in every fortress
 * (`sources/docs/disasm_notes.md` §35).
 *
 * A piece of furniture whose content is `$FE` is not furniture: `$98FD`
 * calls `$AA40`. Five things about it are worth knowing.
 *
 * 1. ★ **It refuses politely.** `$AA40` looks at the nine letters of the
 *    password in the shaft's panel (`$345D`) and if **any one of them is
 *    still a blank**, it returns at once and the search ends as an empty
 *    piece of furniture. Nothing is said, nothing is shown.
 * 2. ★ **The picture is not in the program where the program keeps it.**
 *    `$71C0`, at the very entry of the game (`$3868`), moves three blocks
 *    out from under itself: `$C800`-`$CFFF` to `$D000`, `$C000`-`$C3FF` to
 *    `$F800` and `$C400`-`$C7FF` to `$DC00` — because `$C100`, `$C220`,
 *    `$C500` and `$C690` are all wanted for the game (§29, §34, §13). The
 *    control room copies them back, one under the I/O and one over it.
 * 3. ★ **It changes the VIC's bank.** `$AAEE` puts `$DD00` on bank 3 and
 *    `$D018` on `$04`, so the screen is `$C000` and the character set
 *    `$D000` — the only place in the game where either moves. On the way
 *    out (`$AB5A`) it goes back to bank 1.
 * 4. ★ **`SEI` holds from `$AAD9`, but not for long**: `$AB25 JSR $BF51`
 *    says sentence 4 and `$BF6A CLI` lets the interrupt back in, so the
 *    blinking that follows can wait for frames again.
 * 5. ★ **It ends in the score board**: `$AB64` is one of the two `JMP
 *    $B77C` in the whole program (§33), and because the clock is not on
 *    six, the board says "mission complete" and `$B86E` says sentence 0.
 */

/** the nine letters of the password in the shaft's panel, and the blank */
var COR_PASSWORD = 0x345D, COR_LETTERS = 9, COR_BLANK = 0x53;

/** where `$71C0` parked the picture, and where the room puts it back */
var COR_PICTURE_FROM = 0xDC00, COR_PICTURE_TO = 0xC000;
var COR_COLOR_FROM = 0xF800, COR_COLOR_TO = 0xD800;
var COR_PAGES = 4;

/** the console that is drawn before the bank changes (`$AAA7`) */
var COR_CONSOLE_COLOR = 0x25F3, COR_CONSOLE_CHARS = 0x2611;
var COR_CONSOLE_AT = 0x4301, COR_CONSOLE_COLOR_AT = 0xDB01;
var COR_CONSOLE_RUN = 6, COR_CONSOLE_BYTES = 0x1E;

/** the sprite that opens the door, and its block */
var COR_BLOCK = 0x4D80, COR_PTR7 = 0x43FF;

/** the blinking: how long each round is, and the two sets of characters */
var COR_ROUNDS = 0xAB67, COR_SET_A = 0xAB8C, COR_SET_B = 0xAB99, COR_SPOTS = 0xABA6;
var COR_SET_BYTES = 13, COR_PANEL = 0xC2B6;

/** zero page: the flag the room raises, and the clock the board reads */
var COR_DONE = 0xDC;

/** which sentence the control room says (§32) */
var COR_WORD = 4;

function corByte(v) { return v & 0xFF; }
function corLoad(m, a) { return rbLoad(m, a); }
function corStore(m, a, v) { rbStore(m, a, v); }

/**
 * What the control room needs to find in memory: the picture `$71C0` parked
 * and the tables the console and the blinking are made of. ★ Data of the
 * program again — and this lot is the only one that is **not where the
 * unpacker put it**, because the entry of the game moved it (§35).
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} data - The parsed `data/special.json`.
 */
function corSeedMemory(mem, data) {
  var i, key;
  if (!data) { return; }
  if (data.picture) {
    // ★ `$71C0` doslova: `$C400`-`$C7FF` na `$DC00` a `$C000`-`$C3FF` na
    // `$F800`. Data nesou obojí tak, jak je zná rozbalený obraz, a sem se
    // sázejí **na místo, kam je vstup hry odstěhoval**.
    for (i = 0; i < data.picture.screenBytes.length; i++) {
      mem[(COR_PICTURE_FROM + i) & 0xFFFF] = data.picture.screenBytes[i] & 0xFF;
    }
    for (i = 0; i < data.picture.colorBytes.length; i++) {
      mem[(COR_COLOR_FROM + i) & 0xFFFF] = data.picture.colorBytes[i] & 0xFF;
    }
  }
  if (!data.control) { return; }
  for (key in data.control) {
    if (!Object.prototype.hasOwnProperty.call(data.control, key)) { continue; }
    var at = parseInt(data.control[key].addr.replace('$', ''), 16);
    for (i = 0; i < data.control[key].values.length; i++) {
      mem[(at + i) & 0xFFFF] = data.control[key].values[i] & 0xFF;
    }
  }
} // corSeedMemory

/**
 * `$71FB` — the one page copier the game has. ★ Here it reads and writes
 * **with the I/O banked out** (`$01` = `$24`), so it goes straight at the
 * memory: `$DC00` is RAM at that moment, not the CIA.
 */
function corCopyPages(m, from, to, pages, throughIo) {
  // ★ Ukazatele jsou `$18`/`$19` a `$E4`/`$E5` a **zůstanou posunuté**
  // o tolik stránek, kolik se přeneslo — originál si je po sobě neuklízí
  corStore(m, 0x18, from & 0xFF); corStore(m, 0x19, from >> 8);
  corStore(m, 0xE4, to & 0xFF); corStore(m, 0xE5, to >> 8);
  for (var page = 0; page < pages; page++) {
    for (var y = 0; y < 0x100; y++) {
      var b = m.mem[((corLoad(m, 0x19) << 8) + y) & 0xFFFF];
      var at = ((corLoad(m, 0xE5) << 8) + y) & 0xFFFF;
      if (throughIo) { corStore(m, at, b); }
      else { m.mem[at] = b; }
    }
    corStore(m, 0x19, corByte(corLoad(m, 0x19) + 1));    // `$71FB INC $19`
    corStore(m, 0xE5, corByte(corLoad(m, 0xE5) + 1));
  }
} // corCopyPages

/** `$AB6E` / `$AB7D` — one of the two faces of the console's panel */
function corPanel(m, from) {
  for (var x = COR_SET_BYTES - 1; x >= 0; x--) {
    corStore(m, (COR_PANEL + corLoad(m, COR_SPOTS + x)) & 0xFFFF,
             corLoad(m, from + x));
  }
} // corPanel

/**
 * `$ABB3` — one bout of the console coming alive: `X`+1 frames, and in each
 * of them **six cells of the first page of colour RAM** are repainted.
 *
 * ★ Where is drawn from the mixer (`$82D6`) and **the range is picked**:
 * anything from `$D6` to `$DE` is thrown away and drawn again, so the nine
 * cells that carry the text are never touched. ★ And *what* colour is drawn
 * from `$84EA`, the shift register the robots take their pitch from — the
 * one place in the game where that doubles as a source of randomness.
 */
function* corBlink(m, rounds, entropy) {
  for (var x = rounds; x >= 0; x--) {
    yield;                                               // `$ABB3`
    for (var y = 5; y >= 0; y--) {
      var where;
      do {
        where = fgRandom(m.mem, entropy());
      } while (where >= 0xF0 || (where >= 0xD6 && where < 0xDF));
      corStore(m, 0xD800 + where, (sndChurn(m) & 0x07) | 0x08);
    }
  }
} // corBlink

/**
 * `$AA40` — the whole of it, from the nine letters to the score board.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - The replaceable source (§8).
 */
function* corRun(m, entropy) {
  var i, x, y;
  corStore(m, COR_DONE, corByte(corLoad(m, COR_DONE) + 1));   // `$AA4D`
  for (x = 0x3F; x >= 0; x--) { corStore(m, COR_BLOCK + x, 0x00); }
  // ★ `$AA59` — dva bajty z každých tří: `STA / DEX / STA / DEX / DEX`
  for (x = 0x2E; x >= 0; x -= 3) {
    corStore(m, COR_BLOCK + x, 0xFF);
    corStore(m, COR_BLOCK + x - 1, 0xFF);
  }
  corStore(m, COR_PTR7, 0x36);                           // `$AA68`
  corStore(m, 0xD02E, 0x06);
  corStore(m, 0xD01D, corLoad(m, 0xD01D) | 0x80);
  corStore(m, 0xD017, corLoad(m, 0xD017) | 0x80);
  corStore(m, 0xD00F, 0xCE); corStore(m, 0xD00E, 0x68);
  corStore(m, 0xD01C, corLoad(m, 0xD01C) & 0x7F);
  yield;                                                 // `$AA94`
  corStore(m, 0xD015, corLoad(m, 0xD015) | 0x80);
  x = 0; y = 0;                                          // `$AA9F`
  while (x < COR_CONSOLE_BYTES) {
    corStore(m, 0xE4, 0x05);                             // `$AAA3`
    for (i = COR_CONSOLE_RUN - 1; i >= 0; i--) {
      corStore(m, COR_CONSOLE_COLOR_AT + y, corLoad(m, COR_CONSOLE_COLOR + x));
      corStore(m, COR_CONSOLE_AT + y, corLoad(m, COR_CONSOLE_CHARS + x));
      x++; y++;
      corStore(m, 0xE4, corByte(i - 1));
    }
    y = corByte(y + 0x22);
  }
  for (y = 0x2F; y >= 0; y -= 3) {                       // `$AAC3` — sprajt mizí
    yield;
    corStore(m, COR_BLOCK + y, 0x00);
    corStore(m, COR_BLOCK + y - 1, 0x00);
    corStore(m, COR_BLOCK + y - 2, 0x00);
  }
  yield;                                                 // `$AAD6`
  // ★ `$AAD9 SEI` — a drží jen do `$BF51`, ve kterém je `CLI` (§32)
  corStore(m, 0xD015, 0x00);
  corStore(m, 0xD021, 0x0B); corStore(m, 0xD022, 0x0F); corStore(m, 0xD023, 0x0A);
  m.cor.bank = 3;                                        // `$AAEE` — `$DD00 &= $FC`
  corStore(m, 0xD018, 0x04);
  // ★ `$01 = $24`: RAM i tam, kde je jinak I/O — proto se čte a píše
  // **přímo do paměti**, ne přes `rbStore`
  corCopyPages(m, COR_PICTURE_FROM, COR_PICTURE_TO, COR_PAGES, false);
  // ★ a `$01 = $25` I/O zase pustí, takže tahle půlka jde do barevné paměti
  corCopyPages(m, COR_COLOR_FROM, COR_COLOR_TO, COR_PAGES, true);
  m.cor.speech = COR_WORD;                               // `$AB23` — věta 4
  // ★★ **Od téhle chvíle běží jiná obsluha přerušení.** `$BF62` přehodí
  // vektor IRQ na `$838C`, a to je devět bajtů: potvrdí rastr, zavolá
  // `$00FC` — což je `INC $E0 / RTS` — a `RTI`. Takže `$E0` tiká dál, ale
  // **hodiny stojí, zvuk nedoznívá a posuvné registry robotů se nehýbou**,
  // protože to všechno dělá `$8365 JSR $8398` v té **herní**. A u vět 4
  // a 5 se vektor zpátky nevrací (`$BF75` skočí rovnou na `RTS`), takže
  // to platí až do tabule se skóre.
  m.cor.speaking = 1;
  // ★ **A `SEI` přes dva kilobajty stojí snímek navíc**: rastrové přerušení
  // čeká v latchi, `$BF6A CLI` ho pustí — a teprve `$ABB3 JSR $7F6B` si
  // počká na ten **další**. Změřeno (`ctrlfull`), ne odhadnuto.
  yield;
  // ★ `$AB28` — sedm bout blikání, a **střídají se dvě tváře panelu**
  for (y = 6; y > 0; y--) {
    yield* corBlink(m, corLoad(m, COR_ROUNDS + y), entropy);
    corPanel(m, COR_SET_A);
    y--;
    yield* corBlink(m, corLoad(m, COR_ROUNDS + y), entropy);
    corPanel(m, COR_SET_B);
  }
  yield* corBlink(m, corLoad(m, COR_ROUNDS), entropy);   // `$AB48`
  yield;                                                 // `$AB52`
  corStore(m, 0xD011, 0x0B);
  m.cor.bank = 1;                                        // `$AB5A`
  m.cor.gameOver = 1;                                    // `$AB64 JMP $B77C`
} // corRun

/**
 * The room opens.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - The replaceable source.
 * @returns {Object} The session, for `corFrame`.
 */
function corStart(m, entropy) {
  m.cor = {refused: 0, gameOver: 0, bank: 1, speech: undefined, speaking: 0};
  // ★ **Odmítnutí je v témže průchodu** (`$AA42`): devět písmen se přečte
  // dřív, než se na cokoli čeká, `RTS` přijde hned a prohledávání pokračuje
  // jako u prázdného nábytku. Proto se zkouška dělá tady a **generátor se
  // předem neposouvá** — všechno ostatní, i `$AA4D`-`$AA92`, patří až
  // prvnímu snímku, protože past záznamu sedí na `$AA40` (§35).
  for (var y = COR_LETTERS - 1; y >= 0; y--) {
    if (corLoad(m, COR_PASSWORD + y) === COR_BLANK) {
      m.cor.refused = 1;
      return {gen: corRun(m, entropy), done: true};
    }
  }
  return {gen: corRun(m, entropy), done: false};
} // corStart

/**
 * One frame of the control room.
 * @param {Object} m - The machine.
 * @param {Object} st - What `corStart` gave.
 * @returns {Object} `done`, `refused`, `gameOver`, `speech`.
 */
function corFrame(m, st) {
  var out = {done: st.done ? 1 : 0, refused: m.cor.refused,
             gameOver: m.cor.gameOver, bank: m.cor.bank};
  if (!st.done) {
    var step = st.gen.next();
    if (step.done) { st.done = true; }
    out.done = st.done ? 1 : 0;
    out.gameOver = m.cor.gameOver;
    out.bank = m.cor.bank;
  }
  if (m.cor.speech !== undefined) { out.speech = m.cor.speech; m.cor.speech = undefined; }
  out.speaking = m.cor.speaking;
  return out;
} // corFrame

// published the way every classic worker script is
var controlRoom = {
  seedMemory: corSeedMemory, start: corStart, frame: corFrame,
  PASSWORD: COR_PASSWORD, LETTERS: COR_LETTERS, BLANK: COR_BLANK,
  PICTURE_FROM: COR_PICTURE_FROM, COLOR_FROM: COR_COLOR_FROM
};
if (typeof self !== 'undefined') { self.controlRoom = controlRoom; }
if (typeof module !== 'undefined' && module.exports) { module.exports = controlRoom; }
