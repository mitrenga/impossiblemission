// classic worker script (importScripts): no import, no export — R-001
// begin code

// The two halves of the shuffle, transcribed from the original (`MILNIKY.md`
// M2): the map of the fortress first (`$398F`), the fortress itself second
// (`$7236`), and the builder that draws a room out of what they shuffled
// (`$A39C`). Under Node a tool loads the same files by hand.
//
// The version the application was started with rides on this worker's own
// URL, so it is passed on to the three it takes with it: without it the
// browser is free to keep an old copy of a file that is edited every day
// while the application itself is already new (dev mode serves them from
// `app/` one by one).
if (typeof importScripts === 'function') {
  var query = (typeof self !== 'undefined' && self.location) ? self.location.search : '';
  importScripts('fortressGen.js'+query, 'fortressMap.js'+query,
                'roomBuild.js'+query, 'roomsLoader.js'+query,
                'elevator.js'+query, 'shaftBuild.js'+query,
                'transition.js'+query, 'roomLift.js'+query, 'furniture.js'+query,
                'terminal.js'+query,
                // ★ M5: **kapesní počítač** — šest přihrádek je okno do
                // znakové sady, ne obrázek (§34)
                'pocketComputer.js'+query,
                // ★ M5: **dvě zvláštní místnosti** — kódová `$A771` a řídicí
                // `$AA40` (§35); nábytek, který není nábytek
                'codeRoom.js'+query, 'controlRoom.js'+query,
                'robots.js'+query, 'orb.js'+query,
                // ★ kolize sprajtů počítá knihovna — `$D01E` je vlastnost
                // stroje, ne hry. Soubor je proto v svision, a je to
                // **klasický skript**, aby ho worker mohl vzít (R-001).
                'svision/js/platform/canvas2D/c64/c64Collision.js'+query,
                'collision.js'+query,
                'death.js'+query,
                // ★ M5: **konec hry** — třes, rozpad a tabule se skóre (§33)
                'endGame.js'+query,
                // ★ M6: zvuk je **posloupnost zápisů do SID** (`sound.js`)
                // a řeč je vlastní přehrávač vzorků na cyklech (`speech.js`)
                'sound.js'+query,
                'speech.js'+query,
                'player.js'+query);
}

/**
 * The game's clock, in its own thread. The world of Impossible Mission is a
 * simulation: it has to run at the pace of the original and it has to be
 * repeatable, so it lives here and not in the animation loop.
 *
 * M1 has nothing to simulate yet — the screen is a photograph of the
 * original's memory. What the worker already does is the shape every later
 * milestone needs:
 *
 *   - it ticks at **50 Hz**, the PAL frame the whole project measures in
 *     (`ZADANI.md` §2, operator 2026-09-19): a frame is 19 656 cycles of
 *     the 6510;
 *   - it owns a **seeded, replaceable source of randomness** from the start
 *     (`STANDARDS.md`; never `Math.random()`), because the fortress of the
 *     original is shuffled and a remake that cannot repeat a shuffle cannot
 *     be compared with a recording (`ZADANI.md` §10.4);
 *   - it answers every frame, and the model draws on that message
 *     (`needDraw`, R-037).
 */

/** the screen of the game and how many cells it has (§6) */
var SCREEN_AT = 0x4000, SCREEN_CELLS = 1000;
/** the room's character set, and the part a search rewrites (§27) */
var ROOM_CHARSET = 0x5000, WINDOW_GLYPHS = 0x90;
/**
 * ★ The six slots of the pocket computer — and they are **the computer's
 * character set**, not a picture (§34): `$5C50` + `$90` apiece. Everything
 * the computer draws of the puzzle it draws by rewriting these glyphs, so
 * without sending them the window would stay whatever the last map left in
 * it. The same trap as the window of a search, one set over.
 */
var COMPUTER_CHARSET = 0x5800, COMPUTER_WINDOW = 0x5C50, COMPUTER_SLOTS = 6*0x90;

/** the PAL frame: 50 a second, 19 656 cycles of the 6510 */
var FRAME_MS = 20;
/** ★ how many ticks `schedule` may catch up at once — see there */
var MAX_CATCHUP = 4;
var CYCLES_PER_FRAME = 19656;

var state = {
  running: false,
  frame: 0,
  seed: 0,
  rng: null,
  timer: null,
  /** ★ the accumulator of the world's clock and the last reading — see `schedule` */
  accumulator: 0,
  lastTime: false,
  memory: null,
  fortress: null,
  rooms: null,
  /** the machine a game is played in, and the byte the agent's step reads */
  machine: null,
  joystick: 0x7F,
  playing: false,
  /** the copy the worker compares against to see whether the picture moved */
  picture: null,
  /** and the same for the sprites that are not the agent — see `changedSprites` */
  sprites: null,
  /** and for the glyphs a search rewrites — see `changedGlyphs` */
  glyphs: null,
  /** and for the six slots of the pocket computer — see `changedWindow` */
  window: null,
  /**
   * ★ Které bloky sprajtů jsou **v datech** (`data/sprites.json`, §13).
   * Co v nich není, si hra postavila za běhu a `spriteState` to posílá
   * s sebou — jinak to model nemá kde vzít.
   */
  staticBlocks: {},
  /**
   * ★ Druhá půlka rozběhu v šachtě (`$3A05`-`$3A12`, `player.startShaftMap`)
   * čeká, až doznějí obě úvodní věty — do té doby mapa v panelu není.
   */
  mapPending: false,
  /** the parsed `data/speech.json` — the words and the driver's tables (M6) */
  speech: null,
  /** the parsed `data/end.json` — the tables the score board is made of (M5) */
  end: null,
  /**
   * ★ **The end of a game is not a frame of the world, it is its own reel**
   * (`app/endGame.js`, §33). From the moment the clock runs out the original
   * holds `SEI`: no interrupt, no clock, no robots — and no main loop either.
   * The worker therefore stops running `player.frame` and runs one **round**
   * of the ending per tick instead, which is what `endGame.frame` is for.
   */
  ending: null,
  /** what the player has typed into the hall of fame, waiting for a round */
  typed: [],
  /** ★ the hall of fame the main thread handed over — `localStorage`, not a disk */
  fame: null,
  /**
   * ★ The two sentences a game opens with (`$39F4` and `$39FF`): the
   * original says one, waits `$20` frames (`$7F6D`) and says the other —
   * "another visitor… stay a while, stay forever". They are **not** a tune:
   * measured on the machine, nothing writes to `$D400`-`$D418` between the
   * reset and `$3855`, so the title screen is silent and this is the first
   * sound of the game (`ZADANI.md` §10.16).
   */
  say: [],
  /**
   * ★ **Na čem stojí `$BF51`**: `speakingId` je značka věty, na jejíž
   * dohrání se čeká (zprávu `spoken` posílá hlavní vlákno, když ji ohlásí
   * čip — `ChipStream`, `blockDone`), `speakingUntil` je snímek, do kterého
   * se ještě drží **mezera za větou** (`$39FA JSR $7F6D`, a to je snímky).
   * Dokud platí jedno nebo druhé, hlavní smyčka nejede.
   */
  speakingId: null,
  speakingUntil: 0,
  /** pořadové číslo vyslovené věty, tedy ta značka */
  saidCount: 0
};

/**
 * `$39F4`/`$39FF` — which sentences, and how many frames apart (`$7F6D`).
 * ★ The gap is counted **from the end of the first one**: `$BF51` waits for
 * the player to finish (`$BF7E`) before `$39FA` counts its `$20` frames.
 */
var OPENING_WORDS = [2, 3], OPENING_GAP = 0x20;

/**
 * ★ Věty, na které `$BF51` **čeká** (`$BF75`: všechny kromě `4` a `5`) —
 * po jejich dobu hlavní smyčka nejede a jede jen obsluha přerušení.
 */
var SPEECH_WAITS = [0, 1, 2, 3, 6, 7];

/** where the shuffle leaves what the world needs (`disasm_notes.md` §9, §11) */
var PASSWORD_AT = 0x4FB5;             // nine letters of the password
var LETTER_BASE = 0x66;               // `a`
var GRID_AT = 0xFF96;                 // the map, 9 x 6 squares
var GRID_SIZE = 54;
var SLOTS_AT = 0x30F3;                // 128 pointers to searchable furniture
var SLOT_COUNT = 128;

/**
 * The seeded source of randomness — a 32-bit xorshift, so that a seed is a
 * whole run. Every place the original reads entropy from the hardware goes
 * through this, and a trace can put the recorded values back in its stead.
 * @param {number} seed - Anything but zero.
 * @returns {function(): number} Next value, 0-255.
 */
function makeRandom(seed) {
  var x = (seed | 0) || 0x1D872B41;
  return function () {
    x ^= x << 13; x |= 0;
    x ^= x >>> 17;
    x ^= x << 5; x |= 0;
    return (x >>> 24) & 255;
  };
} // makeRandom

/**
 * The machine's memory, with the tables the shuffle reads put back where the
 * original had them.
 *
 * `data/fortress.json` carries only those tables — 36 stretches, 1 745 bytes,
 * found by `tools/dumpfortress.mjs` — not a dump of the original. Everything
 * else the generators touch they write themselves.
 *
 * @param {Object} data - The parsed `data/fortress.json`.
 * @returns {Uint8Array} 64 KB, ready for the generators.
 */
function buildMemory(data, rooms) {
  var mem = new Uint8Array(0x10000);
  // ★ Nejdřív místnosti, pak vstupy losování. Obojí je z téhož statického
  // obrazu, takže se tam, kde se překrývají, **musí shodovat** — a shodují
  // se (`tools/runworker.mjs`). Generátor pak na záznamy místností píše sám.
  if (rooms) { roomsLoader.memory(rooms, mem); }
  for (var i = 0; i < data.segments.length; i++) {
    var segment = data.segments[i], raw = atob(segment.bytes);
    for (var j = 0; j < raw.length; j++) { mem[segment.at + j] = raw.charCodeAt(j); }
  }
  return mem;
} // buildMemory

/**
 * Shuffles a fortress the way a game of the original starts one.
 *
 * The seed goes in two places and only those two: the state of the original's
 * mixer (`$EB`/`$EC`) and the entropy it mixes in, which on the real machine
 * is the raster line (`EOR $D012` at `$82E3`). The mixer itself is the
 * original's, instruction for instruction — that is what `ZADANI.md` §10.4
 * asks for and what `matchfortressgen.mjs` proves.
 *
 * @param {Object} data - The parsed `data/fortress.json`.
 * @param {function(): number} random - The seeded source.
 * @returns {Object} What the rest of the world asks about a fortress.
 */
function shuffleFortress(data, random, rooms) {
  var mem = buildMemory(data, rooms);
  // ★ `$38D2`-`$3906`: hra si nultou stránku vyčistí **před** losováním,
  // protože losování mapy si do ní na konci uloží, kde stojí kabina
  // (`$27`/`$28`) — a z ní se pak kreslí šachta (`player.resetZeroPage`)
  player.resetZeroPage(mem, {mem: mem, vic: new Uint8Array(0x2F), color: new Uint8Array(0x400)});
  mem[0xEB] = random();
  mem[0xEC] = random();
  generateFortressMap(mem, random);
  generateFortress(mem, random);
  state.memory = mem;

  var password = '', i;
  for (i = 0; i < 9; i++) {
    password += String.fromCharCode(97 + mem[PASSWORD_AT + i] - LETTER_BASE);
  }
  var map = [];
  for (i = 0; i < GRID_SIZE; i++) { map.push(mem[GRID_AT + i]); }
  // ★ Tabulka `$30F3` má 128 položek, ale jen **126 různých adres**: `$11CD`
  // a `$14D0` jsou v ní dvakrát (`disasm_notes.md` §9). Počítá se proto po
  // adresách, ne po položkách — jinak by jeden dílek vyšel jako dva.
  var seen = {}, pieces = 0, terminals = 0, slots = 0;
  for (i = 0; i < SLOT_COUNT; i++) {
    var slot = mem[SLOTS_AT + i*2] | (mem[SLOTS_AT + i*2 + 1] << 8);
    if (seen[slot]) { continue; }
    seen[slot] = true;
    slots++;
    var held = mem[slot];
    if (held < 36) { pieces++; }
    else if (held === 0xFC || held === 0xFD) { terminals++; }
  }
  return {password: password, map: map,
          slots: slots, pieces: pieces, terminals: terminals};
} // shuffleFortress

/**
 * One frame of the world.
 *
 * From M3 on this is not empty: it is **one pass of the original's main
 * loop** (`$7249` in a room, `$3A15` in the shaft — `disasm_notes.md` §19),
 * interrupt and clock and all, transcribed in `app/player.js` and measured
 * by `tools/matchplayer.mjs`. The joystick byte is what `$DC00` would give,
 * port 2, active low; the main thread sets it from the keys.
 */
function tick() {
  state.frame++;
  var message = {
    message: 'frame',
    frame: state.frame,
    cycles: state.frame*CYCLES_PER_FRAME
  };
  // ★ **Konec hry běží místo světa, ne vedle něj.** Na stroji v něm drží
  // `SEI`, takže hodiny ani roboti nejdou (§33) — a tady se proto `tick`
  // vůbec nedostane k `player.frame`.
  if (state.ending && state.machine) {
    endingTick(message);
    postMessage(message);
    return;
  }
  if (state.playing && state.machine) {
    // ★ **Když se mluví, hlavní smyčka stojí a obsluha přerušení jede dál.**
    // `$BF51` po `JSR $0880` čeká v `$BF7E` dokola, dokud přehrávač
    // nedomluví, ale `$BF6A CLI` je **před** tím čekáním — takže `$E0`
    // tiká, hodiny jdou a krok agenta se **nevolá**. Model je to `passes`
    // = 0 (`plFrame`). Bez toho píše `$8E77` do `$D418` padesátkrát za
    // vteřinu **doprostřed věty**, protože hlasitost a vzorky řeči jsou
    // týž registr (§32) — a věta z toho bzučí.
    // ★ `$BF51` **nečeká jen u vět 4 a 5** (`$BF75`), tedy u řídicí
    // místnosti a u vypršelého času; ty se říkají za běhu světa.
    // ★ **A na čem se čeká, řekne čip**: `state.speakingId` drží, dokud
    // hlavní vlákno nepošle `spoken` s toutéž značkou — tu pošle, až
    // `ChipStream` ohlásí `blockDone`. Sběrnice, která blok nepřehraje
    // (ztlumený zvuk, zavřená sběrnice), ho dohlásí sama, takže se hra
    // nemá o co zaseknout.
    var waiting = state.speakingId !== null || state.speakingUntil > state.frame;
    // ★ A **teprve až se domluví, dokreslí se mapa** (`$3A05`-`$3A12`):
    // prázdná fronta `state.say` znamená, že už žádná věta nepřijde.
    if (state.mapPending && !waiting && !state.say.length) {
      state.mapPending = false;
      player.startShaftMap(state.machine);
    }
    // ★★ A **do té doby hlavní smyčka ještě ani nezačala**: na stroji je
    // `$3A15` až za `$3A12`, takže po celý rozběh běží jen obsluha
    // přerušení. Kdo pustí byť jediný průchod dřív, zavolá `$73E4` (kabina
    // na mapě) dřív, než `$B6FE` postaví značku — a sprajt 6 skočí do
    // panelu s ukazatelem `$00`, tedy s obrazovkou místo obrázku
    // (nahlásil operátor 2026-09-21).
    var loops = (waiting || state.mapPending) ? 0 : 1;
    var out = player.frame(state.machine, loops ? state.joystick : 0x7F, loops);
    message.agent = player.view(state.machine);
    message.out = out;
    var picture = changedPicture();
    if (picture) { message.picture = picture; }
    // ★ Sprajty se posílají **zvlášť od obrazu**, a od M4 to je nutnost:
    // robot ani koule se po místnosti nepohybují kreslením, hýbou jen
    // registry VIC, takže obraz se nezmění a zpráva by nikdy nepřišla
    // (do M3 se žádný z nich nehýbal a jezdily s obrazem).
    var sprites = changedSprites();
    if (sprites) { message.sprites = sprites; }
    // ★ A **glyfy**, které prohledávání přepisuje: okno nad agentem není
    // obrázek, je to osmnáct znaků, jejichž tvar se v tu chvíli mění (§27).
    // Bez tohohle by model kreslil okno starou sadou, tedy nábytkem.
    var glyphs = changedGlyphs();
    if (glyphs) { message.glyphs = glyphs; }
    // ★ M5: a **šest přihrádek kapesního počítače** (§34) — glyfy druhé sady
    var window = changedWindow();
    if (window) { message.window = window; }
    // ★ M6: **zvuk je posloupnost zápisů do SID**, ne událost. Co hra za
    // ten průchod napsala do `$D400`–`$D418`, jde na hlavní vlákno tak, jak
    // to napsala, a model čipu to přehraje (`app/sound.js`, R-044).
    var sid = sndTake(state.machine);
    if (sid.length) { message.sid = sid; }
    // ★ A **věta se posílá jako blok vzorků**, ne jako desetitisíce zápisů:
    // přehrávač řeči tiká po 101 cyklech, tedy 195krát za snímek (§18).
    if (out && out.speech !== undefined) {
      speak(message, out.speech);
      // ★ i tahle věta se říká přes `$BF51`, takže se na ni čeká (viz `tick`)
      if (SPEECH_WAITS.indexOf(out.speech) >= 0) {
        state.speakingId = message.speech.id;
      }
    }
    // ★ A **rozběh hry mluví sám** (`$39F4`, `$39FF`): je to jediný zvuk,
    // který nevychází z kroku světa, takže se nevejde do `out.speech` —
    // vede se ve frontě a vydá se ve snímku, ve kterém na něj přijde řada.
    // ★ **A další věta se odpočítává od konce té předchozí**, ne od jejího
    // začátku: `$BF51` po `JSR $0880` **čeká, až přehrávač domluví**
    // (`$BF7E`-`$BF84` se ho ptá `$FF` dokola) a teprve pak se ve `$39FA`
    // napočítá `$20` snímků. Kdo by ten gap vzal od začátku, pustí druhou
    // větu doprostřed první — a protože obě jdou na **týž registr**
    // `$D418`, promíchají se a prostředek je nesrozumitelný (nahlásil
    // operátor 2026-09-21). Konec té předchozí hlásí **čip** (`spoken`).
    if (state.say.length && state.speakingId === null
        && state.speakingUntil <= state.frame) {
      var next = state.say.shift();
      speak(message, next.word);
      // ★ `$BF51` na větu **čeká** (`$BF7E`), takže po dobu jejího trvání
      // stojí hlavní smyčka — a pustí ji teprve zpráva `spoken`, tedy čip
      // (viz `tick` a `spoken` v `onmessage`).
      if (SPEECH_WAITS.indexOf(next.word) >= 0) {
        state.speakingId = message.speech.id;
      }
    }
    // ★ **Vypršel čas** (`$83DF` → `$43` = `$FF`, §33): obřad umírání se na
    // to podívá jako první a nezačne (`$95DC`), takže sem to dojde jako
    // `gameOver` — a odtud už běží konec hry, ne svět.
    if (out && out.gameOver) { startEnding(); }
  }
  postMessage(message);
} // tick

/**
 * Konec hry se rozjíždí: síň slávy do paměti stroje a stav do `state.ending`.
 *
 * ★ **Síň slávy se musí do paměti dostat předem.** Na stroji ji tam nahrál
 * `LOAD "HI"` ještě před hrou (`$3887`, §33), takže `$BBF7` ji tam prostě
 * najde; v prohlížeči ji drží hlavní vlákno a posílá se se zprávou `play`.
 * Bez ní by se vkládalo do toho, co v `$CF00` zbylo po obrázku titulky.
 */
function startEnding() {
  if (state.ending) { return; }
  if (state.fame) { endGame.fameIn(state.machine, state.fame); }
  else { endGame.blankFame(state.machine); }
  state.ending = endGame.start(state.machine, state.end);
  state.typed = [];
} // startEnding

/**
 * Jedno kolo konce hry. Obraz se posílá jako každý jiný (`changedPicture`),
 * protože tabule **je** obrazovka — jen se v ní nehýbe nic jiného.
 * @param {Object} message - Zpráva snímku, do které se to přibalí.
 */
function endingTick(message) {
  var keys = state.typed;
  state.typed = [];
  var went = endGame.frame(state.machine, state.ending,
                           function () { return state.rng ? state.rng() : 0; }, keys);
  var picture = changedPicture();
  if (picture) { message.picture = picture; }
  var sprites = changedSprites();
  if (sprites) { message.sprites = sprites; }
  var sid = sndTake(state.machine);
  if (sid.length) { message.sid = sid; }
  if (went.speech !== undefined) { speak(message, went.speech); }
  if (went.name) { message.enteringName = 1; }
  if (!went.done) { return; }
  // ★ **Skóre a síň slávy jdou na hlavní vlákno**, protože uložit je umí jen
  // ono (`localStorage` místo `SAVE` do `HI`, §33).
  var m = state.machine;
  message.gameOver = {
    score: [rbLoad(m, 0xD9), rbLoad(m, 0xDA), rbLoad(m, 0xDB)],
    hours: rbLoad(m, 0xD4),
    pieces: rbLoad(m, 0xD6), passwords: rbLoad(m, 0xD7), puzzles: rbLoad(m, 0xD8),
    fame: endGame.fameOut(m),
    entered: went.fame || null
  };
  state.ending = null;
  state.playing = false;
} // endingTick

/**
 * A sentence, decoded into the samples the original's player would write
 * to `$D418` — one block for the whole sentence, with the cadence it is
 * played at (`app/speech.js`, §32).
 *
 * ★ The game **stands still while it talks** (`$BF51` waits for the player
 * to say it has stopped), so this is not something the world runs
 * alongside: the samples are made once and the frames go on afterwards.
 *
 * @param {Object} message - The frame message the block rides on.
 * @param {number} word - The sentence, 0-7.
 */
function speak(message, word) {
  if (!state.speech) { return; }
  var said = speechSentence(state.speech, word);
  // ★ **Jak dlouho věta trvá, ví přehrávač sám**: `said.cycles` je počet
  // cyklů, které `$0880` na stroji spotřeboval, než domluvil — tedy přesně
  // to, na co `$BF51` čeká (`$BF7E`). Ve snímcích je to tohle, a posílá se
  // to s sebou, aby se to nikde nepočítalo podruhé.
  var frames = Math.ceil(said.cycles/CYCLES_PER_FRAME);
  state.saidCount++;
  message.speech = {word: word, cadence: SPEECH_CYCLES, samples: said.samples,
                    register: 0x18, frames: frames, id: state.saidCount};
  return frames;
} // speak

/**
 * What the screen looks like now — but **only when it has changed**.
 *
 * ★ From M3 on the picture is not a still: the curtains of a transition
 * redraw two rows every two frames (§21), a ride in the shaft rebuilds a
 * whole row every two (§20), and walking out of a room replaces the lot
 * (§22). The model therefore cannot be told the room once and left alone —
 * but it also must not be sent a kilobyte fifty times a second for nothing,
 * so the worker keeps a copy and compares.
 *
 * @returns {Object|null} `screen`, `color`, which character set the VIC is
 *   pointing at and the colours it draws with — or null when nothing moved.
 */
function changedPicture() {
  var m = state.machine, i, changed = false;
  if (!state.picture) { state.picture = new Uint8Array(SCREEN_CELLS*2); }
  for (i = 0; i < SCREEN_CELLS; i++) {
    if (state.picture[i] !== m.mem[SCREEN_AT + i]) { changed = true; break; }
    if (state.picture[SCREEN_CELLS + i] !== (m.color[i] & 0x0F)) { changed = true; break; }
  }
  if (!changed) { return null; }
  var screen = new Uint8Array(SCREEN_CELLS), color = new Uint8Array(SCREEN_CELLS);
  for (i = 0; i < SCREEN_CELLS; i++) {
    screen[i] = m.mem[SCREEN_AT + i];
    color[i] = m.color[i] & 0x0F;
    state.picture[i] = screen[i];
    state.picture[SCREEN_CELLS + i] = color[i];
  }
  // ★ `$D018` říká, kterou sadu VIC čte: `$04` je místnost (`$5000`),
  // `$02` šachta (`$4800`) a `$06` kapesní počítač (`$5800`) — §6
  // ★ A **která obsluha přerušení je ve vektoru**: `$82E7` je herní a dělí
  // obraz rastrovými clonami, `$838C` jen zvedne `$E0`. Za úvodní řečí
  // (`$391E` ≺ `$BF3A`) a v řídicí místnosti (§35) běží ta druhá, takže je
  // celá obrazovka jednou sadou — bez tohohle by model kreslil spodní
  // desetinu sadou počítače dřív, než tam panel vůbec je.
  return {screen: screen, color: color, sprites: spriteState(),
          irq: m.mem[0xFFFE] | (m.mem[0xFFFF] << 8),
          charset: (m.vic[0x18] & 0x0E) >> 1,
          place: m.mem[0x1A],
          colors: {border: m.vic[0x20] & 0x0F,
                   background0: m.vic[0x21] & 0x0F,
                   background1: m.vic[0x22] & 0x0F,
                   background2: m.vic[0x23] & 0x0F,
                   spriteMulti0: m.vic[0x25] & 0x0F,
                   spriteMulti1: m.vic[0x26] & 0x0F,
                   split: m.mem[0x8D]}};
} // changedPicture

/**
 * The sprites that are **not** the agent, as the VIC has them: in a room the
 * orb (0) and the robots (4-7), in the shaft the cabin (0) and the pocket
 * computer's marker (7). The agent's three ride in `agent` and come from
 * `player.view()`.
 *
 * @returns {Object} Which sprites are on, their modes, positions, block
 *   pointers and colours — the eight of them, the agent's included, because
 *   the registers are one set and the receiver picks.
 */
function spriteState() {
  var m = state.machine, i;
  // ★ `$D025`/`$D026` patří **sprajtům**, ne obrazu: stavitel místnosti je
  // sází z jejího záznamu (`$A495`, `$A49B`) a robot je v nich celý — jeho
  // vlastní barva (`$D02B`-`$D02E`) je v bloku `$C0` jen dvanáct bodů z dvou
  // set čtyř. Jezdí proto **ve stavu sprajtů**, ne v `colors` obrazu: obraz
  // se posílá, jen když se změní obrazovka, takže do místnosti, kterou hráč
  // prošel bez překreslení, by nikdy nedorazil.
  var out = {enabled: m.vic[0x15], multicolor: m.vic[0x1C],
             expandX: m.vic[0x1D], expandY: m.vic[0x17], msbX: m.vic[0x10],
             multi0: m.vic[0x25] & 0x0F, multi1: m.vic[0x26] & 0x0F,
             x: [], y: [], pointer: [], color: []};
  for (i = 0; i < 8; i++) {
    out.x.push(m.vic[i*2]);
    out.y.push(m.vic[i*2 + 1]);
    out.pointer.push(m.mem[0x43F8 + i]);
    out.color.push(m.vic[0x27 + i] & 0x0F);
  }
  // ★ A **bloky, které na disketě nejsou**: `data/sprites.json` veze ty,
  // které jsou v obrazu statické (§13), jenže některé si hra **staví za
  // běhu** — značku kabiny na mapě pevnosti (`$B6FE` staví `$4D80`, tedy
  // blok `$36`) a kopii agenta, ze které se rozpouští (`$9720`). Kdo je
  // hledá jen podle ukazatele v datech, nenajde nic a nenakreslí nic.
  for (i = 0; i < 8; i++) {
    var ptr = out.pointer[i];
    if (!(out.enabled & (1 << i)) || state.staticBlocks[ptr]) { continue; }
    var bytes = new Uint8Array(64), b;
    for (b = 0; b < 64; b++) { bytes[b] = m.mem[(0x4000 + ptr*64 + b) & 0xFFFF]; }
    if (!out.blocks) { out.blocks = {}; }
    out.blocks[ptr] = bytes;
  }
  return out;
} // spriteState

/**
 * The sprites, but **only when one of them moved** — the same bargain the
 * picture strikes, on a hundredth of the data.
 *
 * ★ It cannot be folded into `changedPicture`, and that is the whole point:
 * a robot walking a platform writes `$D000`-`$D010` and nothing else, so the
 * screen it is walking on does not change (§24). Until M4 nothing but the
 * agent moved and the two travelled together; now they must not.
 *
 * ★ The agent's own three sprites are in the state too and are compared with
 * the rest, because the receiver keeps the whole register set — but they are
 * drawn from `agent`, which every frame carries, so nothing depends on this
 * message arriving for the agent to move.
 *
 * @returns {Object|null} The state, or null when no register moved.
 */
function changedSprites() {
  var now = spriteState(), i, at = 0, changed = false;
  if (!state.sprites) { state.sprites = new Uint8Array(7 + 8*4); }
  var flat = state.sprites, mine = [now.enabled, now.multicolor, now.expandX,
                                    now.expandY, now.msbX, now.multi0, now.multi1];
  for (i = 0; i < 8; i++) {
    mine.push(now.x[i], now.y[i], now.pointer[i], now.color[i]);
  }
  for (at = 0; at < mine.length; at++) {
    if (flat[at] !== mine[at]) { changed = true; break; }
  }
  if (!changed) { return null; }
  for (at = 0; at < mine.length; at++) { flat[at] = mine[at]; }
  return now;
} // changedSprites

/**
 * The glyphs a search rewrites (`$5000`-`$508F`), and **only when one of
 * them changed** — the same bargain the picture and the sprites strike.
 * @returns {Object|null} `{at, bytes}`, or null when nothing moved.
 */
function changedGlyphs() {
  var m = state.machine, i, changed = false;
  if (!state.glyphs) { state.glyphs = new Uint8Array(WINDOW_GLYPHS); changed = true; }
  for (i = 0; !changed && i < WINDOW_GLYPHS; i++) {
    if (state.glyphs[i] !== m.mem[ROOM_CHARSET + i]) { changed = true; }
  }
  if (!changed) { return null; }
  var bytes = new Uint8Array(WINDOW_GLYPHS);
  for (i = 0; i < WINDOW_GLYPHS; i++) {
    bytes[i] = m.mem[ROOM_CHARSET + i];
    state.glyphs[i] = bytes[i];
  }
  return {at: ROOM_CHARSET, bytes: bytes};
} // changedGlyphs

/**
 * The same for the six slots of the pocket computer (§34): `$5C50`-`$5FAF`
 * is the window into the computer's own set, and the whole puzzle lives in
 * it. ★ It changes on far fewer frames than the room's glyphs — listing the
 * memory, carrying a piece, the map — so like the picture it is sent only
 * when it moved.
 * @returns {Object|null} `{at, bytes}` when it changed.
 */
function changedWindow() {
  var m = state.machine, i, changed = false;
  if (!state.window) { state.window = new Uint8Array(COMPUTER_SLOTS); changed = true; }
  for (i = 0; !changed && i < COMPUTER_SLOTS; i++) {
    if (state.window[i] !== m.mem[COMPUTER_WINDOW + i]) { changed = true; }
  }
  if (!changed) { return null; }
  var bytes = new Uint8Array(COMPUTER_SLOTS);
  for (i = 0; i < COMPUTER_SLOTS; i++) {
    bytes[i] = m.mem[COMPUTER_WINDOW + i];
    state.window[i] = bytes[i];
  }
  return {at: COMPUTER_WINDOW, bytes: bytes};
} // changedWindow

/**
 * The clock of the world — ★ **`setTimeout` with an accumulator, never
 * `setInterval`** (**R-046**, and every other remake here does the same:
 * `manicminer/app/gameWorker.js`, `jetpac`, `boulderdash`, `battlezone`…).
 *
 * ★ `setInterval(tick, 20)` does **not** give fifty ticks a second. The
 * browser rounds the period to whole milliseconds, coalesces timers and
 * adds whatever the event loop owes, so what comes out is **42 to 47 Hz**
 * (reported by the operator 2026-09-20) — the world then runs a tenth slow,
 * the clock of the fortress with it, and `ChipStream` re-anchors because the
 * frames arrive later than the audio thread expects.
 *
 * ★ **It is not the work.** One tick costs **0,058 ms** of the 20 ms budget,
 * three tenths of a percent (measured on the room with robots). So the world
 * is not asked to run slower; it is only asked at the wrong times, and
 * measuring the real elapsed time puts that right.
 *
 * The accumulator collects what really passed and spends it in whole ticks,
 * so jitter evens out instead of piling up. ★ At most **four** at once: a
 * tab that was in the background for a minute must not try to catch up three
 * thousand frames — it would freeze the worker and the world would jump.
 */
function schedule() {
  if (!state.running) {
    return;
  }
  state.timer = setTimeout(function () {
    if (!state.running) { return; }
    var now = Date.now();
    if (state.lastTime === false) { state.lastTime = now; }
    state.accumulator += now-state.lastTime;
    state.lastTime = now;
    var steps = Math.min(Math.floor(state.accumulator/FRAME_MS), MAX_CATCHUP);
    state.accumulator -= steps*FRAME_MS;
    for (var step = 0; step < steps; step++) { tick(); }
    schedule();
  }, FRAME_MS);
} // schedule

onmessage = function (event) {
  var data = event.data || {};
  switch (data.message) {
    case 'init':
      state.seed = data.seed || 1;
      state.rng = makeRandom(state.seed);
      state.frame = 0;
      state.rooms = data.rooms || null;
      state.speech = data.speech || null;              // M6: řeč, jestli ji volající stáhl
      state.end = data.end || null;                    // M5: tabulky konce hry
      state.fortress = data.fortress
        ? shuffleFortress(data.fortress, state.rng, state.rooms) : null;
      postMessage({message: 'ready', seed: state.seed, fortress: state.fortress});
      break;
    case 'start':
      if (!state.running) {
        state.running = true;
        state.accumulator = 0;
        // ★ **Hodiny se čtou hned tady, ne až v prvním `setTimeout`u.**
        // Kdyby se nechaly na `false`, první probuzení by jen zapsalo čas
        // a neudělalo **ani jeden** tik — svět by začal o snímek později
        // a harness by napočítal o jeden míň (`tools/runworker.mjs`).
        state.lastTime = Date.now();
        schedule();
      }
      break;
    case 'stop':
      state.running = false;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      break;
    case 'room':
      // ★ místnost se **staví** ze záznamu vylosované pevnosti, nekreslí se
      // z obrázku (`disasm_notes.md` §12). Bez `init` s daty místností se
      // nedá postavit nic, tak se to přizná.
      postMessage(state.rooms
        ? roomsLoader.buildRoom(state.rooms, (data.room | 0) & 31, data.side ? 1 : 0,
                                state.memory)
        : {message: 'room', room: null});
      break;
    case 'play':
      // ★ hra v místnosti: stavitel originálu postaví místnost do paměti
      // a agent se v ní hýbe krokem originálu (`app/player.js`). Tabulky
      // pohybu, bloky sprajtů a tabulku otočených bitů musí mít paměť
      // v sobě — o to se stará `player.seedMemory`
      if (state.memory) {
        // ★ Stroj se zakládá **před** nasypáním: patří do něj i `$D024`,
        // příznak, který parkuje zavaděč (§4) a na kterém visí výška
        // střílejícího robota (`$84EA`, `app/sound.js`).
        state.machine = {mem: state.memory, color: new Uint8Array(0x400),
                         vic: new Uint8Array(0x2F), entropy: state.rng};
        player.seedMemory(state.memory, data.global || null, data.sprites || null,
                          data.furniture || null, data.terminal || null,
                          data.charsetShaft || null, state.machine,
                          data.computer || null, data.puzzle || null,
                          data.special || null);
        // ★ **znaková sada místnosti do paměti stroje** (`$5000`): na stroji
        // tam je z diskety a prohledávání nábytku do ní **zapisuje** (§27) —
        // okno nad agentem není obrázek, jsou to přepsané glyfy `$00`-`$1F`
        if (data.charset && data.charset.bytes) {
          for (var ci = 0; ci < data.charset.bytes.length; ci++) {
            state.memory[ROOM_CHARSET + ci] = data.charset.bytes[ci] & 0xFF;
          }
        }
        state.staticBlocks = {};
        if (data.sprites && data.sprites.blocks) {
          for (var bk in data.sprites.blocks) {
            if (!Object.prototype.hasOwnProperty.call(data.sprites.blocks, bk)) { continue; }
            state.staticBlocks[data.sprites.blocks[bk].pointer] = true;
          }
        }
        state.glyphs = null;                  // ať se sada pošle hned
        state.window = null;                  // a okno počítače taky
        elevator.seedMemory(state.memory, data.shaft || null);
        // ★ Entropie: na stroji je to rastrový řádek (`EOR $D012`, §8), a ten
        // v prohlížeči není. Bere se proto tentýž seedovaný zdroj, ze kterého
        // se losovala pevnost — jinak by se jízda výtahem nedala zopakovat.
        // ★ **Hra začíná v šachtě** (`$3960`-`$3A12`, `plStartShaft`): agent
        // stojí v kabině pod stropem pevnosti a do místnosti se teprve
        // dojede a projde dveřmi. Do místnosti se staví jen na vyžádání —
        // to je vývojářská prohlížečka místností (`GameModel` s `dev`).
        if (data.where === 'shaft') {
          // ★ **Mapa se kreslí až za úvodní řečí** (`$3A05`-`$3A12`): mezi
          // `$39F1` a `$3A05` stojí dvě věty a `$BF51` u obou čeká, až
          // přehrávač domluví, takže na originálu je za řeči v panelu jen
          // to, co nakreslil `$731C` (nahlásil operátor 2026-09-21). Druhou
          // půlku rozběhu proto pustí `tick`, až fronta vět doběhne.
          player.startShaft(state.machine, true);
          state.mapPending = true;
          // ★ `$39F4` a `$39FF`: první věta hned, druhá o `$20` snímků
          // později (`$7F6D`). Na stroji stojí mezi nimi svět, protože
          // `$BF51` čeká, až přehrávač domluví; tady to stát nemusí —
          // v tu chvíli se stejně jen dokresluje panel šachty.
          // ★ `gap` je **kolik snímků se čeká, než se věta řekne** — a
          // počítá se **od konce té předchozí**, protože `$BF51` na ni
          // čeká (`$BF7E`) a teprve pak `$39FA` odpočítá `$20` (viz `tick`
          // a `spoken`). První věta gap nemá, jde hned.
          state.say = OPENING_WORDS.map(function (word, i) {
            return {word: word, gap: i === 0 ? 0 : OPENING_GAP};
          });
          state.speakingId = null;
          state.speakingUntil = 0;
        } else {
          state.say = [];
          state.mapPending = false;
          player.startRoom(state.machine, (data.room | 0) & 31, data.side ? 1 : 0);
        }
        // ★ **Hodiny se dají nastavit, a je to jediná cesta, jak konec hry
        // vidět.** Od dvanácté k šesté je **1 296 000 snímků**, tedy sedm
        // hodin hraní; `?devClock=5:59:57` (`window.devMode.clock`) je proto
        // posadí tam, odkud přetečou samy — rutinou originálu (`$83C2`,
        // `plClockAdd`), ne záplatou. Bez toho by se konec hry nedal ani
        // v prohlížeči zkontrolovat, ani ve `tools/runworker.mjs` změřit.
        if (data.clock && data.clock.length === 3) {
          rbStore(state.machine, 0xD1, 0);
          rbStore(state.machine, 0xD4, data.clock[0] & 0xFF);
          rbStore(state.machine, 0xD3, data.clock[1] & 0xFF);
          rbStore(state.machine, 0xD2, data.clock[2] & 0xFF);
        }
        // ★ a nálezy k tomu, aby na tabuli bylo co sečíst (`$D6`-`$D8`)
        if (data.found && data.found.length === 3) {
          rbStore(state.machine, 0xD6, data.found[0] & 0xFF);
          rbStore(state.machine, 0xD7, data.found[1] & 0xFF);
          rbStore(state.machine, 0xD8, data.found[2] & 0xFF);
        }
        state.picture = null;                 // ať se obraz pošle hned
        state.sprites = null;                 // a sprajty s ním
        state.ending = null;
        state.typed = [];
        // ★ síň slávy z hlavního vlákna; `null` znamená „ještě se nehrálo"
        state.fame = data.fame || null;
        state.playing = true;
        state.joystick = 0x7F;
        postMessage({message: 'playing', room: (data.room | 0) & 31,
                     side: data.side ? 1 : 0, where: data.where || 'room',
                     agent: player.view(state.machine)});
      }
      break;
    case 'input':
      // co by dal `$DC00`: port 2, aktivní v nule (§7)
      state.joystick = (data.joystick === undefined ? 0x7F : data.joystick) & 0xFF;
      break;
    case 'name':
      // ★ **Jméno do síně slávy je vstup, jako joystick.** Originál ho čte
      // z matice klávesnice (`$BEA5`, §33); tady je screen code posílá model
      // a kolo konce hry si je vezme, až na ně přijde řada.
      if (state.ending && data.key !== undefined) { state.typed.push(data.key & 0xFF); }
      break;
    case 'spoken':
      // ★ **Čip dohrál větu** (`blockDone` z `ChipStream` přes `GameModel`):
      // tohle je to, na co `$BF51` čeká v `$BF7E`. Teprve teď se pustí
      // hlavní smyčka — a je-li ve frontě další věta, odpočítá se před ní
      // ještě její `gap` snímků (`$39FA JSR $7F6D`).
      // ★ Přijde to i tehdy, když se nehrálo (ztlumený zvuk, zavřená
      // sběrnice): sběrnice, která blok nepřehraje, ho dohlásí sama
      // (`AbstractAudioHandler.reportBlocksDone`), takže hra nestojí.
      if (state.speakingId !== null && data.ids
          && data.ids.indexOf(state.speakingId) >= 0) {
        state.speakingId = null;
        state.speakingUntil = state.say.length
          ? state.frame+state.say[0].gap : 0;
      }
      break;
    case 'random':
      postMessage({message: 'random', value: state.rng ? state.rng() : 0});
      break;
  } // switch
}; // onmessage
