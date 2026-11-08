const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { C64TextModeEntity } = await import('./svision/js/platform/canvas2D/c64/c64TextModeEntity.js?ver='+window.srcVersion);
const { C64TextRAM } = await import('./svision/js/platform/canvas2D/c64/c64TextRAM.js?ver='+window.srcVersion);
const { C64Charset } = await import('./svision/js/platform/canvas2D/c64/c64Charset.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
const { C64SpriteEntity } = await import('./svision/js/platform/canvas2D/c64/c64SpriteEntity.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { PauseGameEntity } = await import('./pauseGameEntity.js?ver='+window.srcVersion);
// begin code

/**
 * A game of Impossible Mission, and the first picture of this remake that is
 * not a photograph of the original's memory.
 *
 * ★ **It starts in the shaft** (`$3960`-`$3A12`, `player.startShaft`): the
 * agent stands in the cabin under the ceiling of the fortress, the clock
 * says twelve, and a room is something he rides to and walks into. Nothing
 * here is drawn — the worker shuffles a fortress with the original's own
 * routines (`$398F` and `$7236`), the lift draws the shaft with its own
 * seventeen steps (§22) and a room is **built** by the original's builder
 * (`$A39C`, `app/roomBuild.js`) out of the record the shuffle left behind.
 * What comes back is what the machine would have: 1 000 screen codes, 1 000
 * colour nibbles, the VIC registers and the sprite pointers. This model only
 * hands them to the library — the character sets from `data/charset_*.json`,
 * the sprite blocks from `data/sprites.json`.
 *
 * Measured: `tools/matchrooms.mjs` (the builder against the machine, 64
 * rooms, 4 246 144 checks) and `tools/matchrooms.mjs --data` (the same room
 * built from `data/rooms.json`, 131 008 checks).
 *
 * The arrows and the space bar are a joystick (port 2, active low —
 * `disasm_notes.md` §7) whose byte goes to the worker, where the original's
 * own step moves the agent (`app/player.js`, measured by
 * `tools/matchplayer.mjs`).
 *
 * What the step does not do yet it **says** rather than guesses: the pocket
 * computer and the code rooms come back in `out` and nothing moves.
 *
 * ★ **The title screen opens it and the title screen takes it back**
 * (`app/mainApp.js`): a game shuffles a fortress, builds the room the agent
 * starts in and starts the clock by itself, and when it ends it goes back
 * to the title. Escape — or the cross in the border, which sends the same
 * key — stops the worker and puts up the pause panel; the panel's EXIT is
 * the way to the menu. ★ The **worker's clock is its own**, so pausing
 * means telling it (`stop`/`start`); hiding the panel over a running world
 * would leave the agent walking behind it.
 *
 * ★ With `dev` it stops short of starting: the room is built and stands
 * still, the arrows walk through the 32 rooms, `N` shuffles another
 * fortress and `P` starts the agent. That is the menu's A ROOM OF THE
 * FORTRESS, and it is how M2 and M3 were looked at.
 */
export class GameModel extends AbstractModel {

  constructor(app, options) {
    super(app);
    this.id = 'GameModel';
    /** ★ true = the menu's A ROOM OF THE FORTRESS: build a room, start nothing */
    this.dev = !!(options && options.dev);
    /** whether the pause panel is up; the worker is stopped while it is */
    this.paused = false;
    /**
     * ★ **R-037**: the picture is drawn on the worker's message, and the
     * model's loop is only the fallback. `handleWorkerMessage` draws and
     * drops the flag; `loopModel` draws only if the flag survived — that is,
     * when no frame came (a pause, a modal, a stalled worker) — and raises
     * it again. Předloha `manicminer/app/caveModel.js`.
     */
    this.needDraw = true;
    /**
     * ★ **R-045** — the dev-mode counter, in the shape every game uses:
     * `nakresleno/zpráv/tiků FPS`. `frames` is how often the model drew,
     * `workerFrames` how many `frame` messages arrived, and `ticks` how many
     * steps **the world** actually took — that one is differenced from the
     * counter the message carries, so a worker that skips or coalesces shows
     * up as a third number lower than the second.
     */
    this.fps = {frames: 0, workerFrames: 0, ticks: 0, since: false, lastFrame: false};
    /** which room, which way in, which fortress */
    this.room = 0;
    this.side = 0;
    // ★ **Semínko je na hru, ne na aplikaci** (`MainApp.newGameSeed`): každá
    // nová hra losuje jinou pevnost, jinak hráč vejde do první místnosti
    // vlevo a vidí pokaždé tutéž (nahlásil operátor 2026-09-20). Prohlížečka
    // místností (`dev`) si drží to, které dostala, a `N` je posouvá.
    this.seed = this.dev ? (app.gameSeed || 1) : app.newGameSeed();
    /** the four files the picture is made of, as they arrive */
    this.data = {rooms: null, fortress: null, charset: null, sprites: null,
                 global: null, shaft: null, charsetShaft: null, furniture: null,
                 terminal: null, speech: null, end: null,
                 charsetComputer: null, elevator: null};
    /** the three character sets, built on first use */
    this.sets = null;
    /** where the agent is, as the worker last reported it: 0 shaft, 1 room */
    this.place = 1;
    /** M3: which keys are down, and the joystick byte they make (§7) */
    this.keys = {};
    this.joystick = 0x7F;
    /**
     * ★ **Stisk musí přežít aspoň jeden tik světa.** Vstupy chodí rychlostí
     * prohlížeče (rAF, 60 a víc Hz), svět tiká po 20 ms — takže se stisk
     * i puštění vejdou **mezi dva tiky** a worker uvidí jen to poslední,
     * tedy klid. Změřeno: ťuknutí na tlačítko mezi dvěma tiky agentem
     * nehne, tentýž stisk držený jeden tik ho pustí do salta.
     * `true` znamená „poslal jsem stisk, který worker ještě nepřečetl";
     * puštění se do příští zprávy `frame` odloží.
     */
    this.unseenPress = false;
    this.playing = false;
    /**
     * ★ **Osm sprajtů stroje, jedna sada na celou dobu** — ne osm nových
     * entit na každý snímek. Index je číslo sprajtu, aby seděla **priorita**:
     * VIC kreslí nižší číslo nad vyšší, entity knihovny zase pozdější nad
     * dřívější, takže se zakládají odzadu (7 → 0). Sprajty 1-3 patří agentovi
     * (`showAgent`), 0 a 4-7 světu (`showSpriteState`).
     */
    this.hwSprites = [];
    /** kterou ze tří sad má obrazovka na sobě — `showPicture` to určuje */
    this.fontSet = 'room';
    this.built = null;
    this.screen = null;
    this.status = null;
    this.password = '';
    /**
     * ★ **M5: konec hry.** `enteringName` znamená, že tabule čeká na pět
     * znaků do síně slávy (`$BD0B`, §33) a klávesnice tedy nepatří
     * joysticku; `gameOver` je to, co konec hry spočítal, a drží se proto,
     * aby se tabule dala popsat i po tom, co svět přestal tikat.
     */
    this.enteringName = false;
    this.gameOver = null;
  } // constructor

  /** kde v prohlížeči leží síň slávy — v originálu je to soubor `HI` (§33) */
  static get FAME_KEY() { return 'impossiblemission.hallOfFame'; }

  newBorderEntity() {
    return new BorderEntity(true);
  } // newBorderEntity

  init() {
    super.init();
    this.screen = new C64TextModeEntity(this.desktopEntity, 0, 0,
      this.desktopWidth, this.desktopHeight, this.app.fonts.c64Fonts8x8);
    this.desktopEntity.addEntity(this.screen);
    this.screen.textRAM.setBackground(0).showCursor(false);
    this.screen.textRAM.clear(12);
    this.screen.textRAM.printAt(1, 1, 'BUILDING A FORTRESS...', 12);
    this.desktopEntity.bkColor = C64Color.color(0);
    if (this.borderEntity != null) {
      this.borderEntity.bkColor = C64Color.color(0);
    }
    // one file at a time: `fetchData` keeps one id per receiver, so the
    // answers are chained in `setData` by the url that came back
    this.fetchData('rooms.data', {key: 'rooms', when: 'required'}, {});
  } // init

  /**
   * Takes the six files in turn and, when they are all in, asks the worker
   * for a fortress and for a room of it.
   * @param {Object} data - `{url, source, data}`.
   */
  setData(data) {
    if (data && data.data) {
      switch (data.url) {
        case 'rooms.data':
          this.data.rooms = data.data;
          this.fetchData('fortress.data', {key: 'fortress', when: 'required'}, {});
          break;
        case 'fortress.data':
          this.data.fortress = data.data;
          this.fetchData('charset_room.data', {key: 'charsetRoom', when: 'required'}, {});
          break;
        case 'charset_room.data':
          this.data.charset = data.data;
          this.fetchData('sprites.data', {key: 'sprites', when: 'required'}, {});
          break;
        case 'sprites.data':
          this.data.sprites = data.data;
          this.fetchData('global.data', {key: 'global', when: 'required'}, {});
          break;
        case 'global.data':
          this.data.global = data.data;
          this.fetchData('shaft.data', {key: 'shaft', when: 'required'}, {});
          break;
        case 'shaft.data':
          // tabulky šachty (§20) — bez nich by krok výtahu skládal nový řádek
          // z nul, jakmile agent do šachty vyjde
          this.data.shaft = data.data;
          this.fetchData('charset_shaft.data', {key: 'charsetShaft', when: 'required'}, {});
          break;
        case 'charset_shaft.data':
          this.data.charsetShaft = data.data;
          this.fetchData('charset_computer.data', {key: 'charsetComputer', when: 'required'}, {});
          break;
        case 'charset_computer.data':
          this.data.charsetComputer = data.data;
          this.fetchData('elevator.data', {key: 'elevator', when: 'required'}, {});
          break;
        case 'elevator.data':
          // ★ jen kvůli **pruhům** dělené obrazovky šachty, které jsou v něm
          // změřené na běžící hře (§6)
          this.data.elevator = data.data;
          this.fetchData('furniture.data', {key: 'furniture', when: 'required'}, {});
          break;
        case 'furniture.data':
          // ★ tabulky a okna **prohledávání nábytku** (§27) — data programu,
          // bez kterých se okno nad agentem neotevře
          this.data.furniture = data.data;
          this.fetchData('terminal.data', {key: 'terminal', when: 'required'}, {});
          break;
        case 'terminal.data':
          // ★ obrazovka a tabulky **bezpečnostního terminálu** (§29)
          this.data.terminal = data.data;
          this.fetchData('speech.data', {key: 'speech', when: 'required'}, {});
          break;
        case 'speech.data':
          // ★ **řeč** (M6, §32): 6 016 bajtů `IM.WORDS` a tabulky ovladače.
          // Bez nich hra mluvit nezačne, ale hrát se dá.
          this.data.speech = data.data;
          this.fetchData('end.data', {key: 'end', when: 'required'}, {});
          break;
        case 'end.data':
          // ★ **konec hry** (M5, §33): nadpisy tabule, maska rovnice
          // a matice klávesnice. Je to poslední soubor v řadě, protože bez
          // něj se dá hrát celá hra — jen by neměla jak skončit.
          this.data.end = data.data;
          this.fetchData('computer.data', {key: 'computer', when: 'required'}, {});
          break;
        case 'computer.data':
          // ★ **kapesní počítač** (M5, §34): tabulky přihrádek, obrazovka
          // telefonu a osm hlášek
          this.data.computer = data.data;
          this.fetchData('puzzle.data', {key: 'puzzle', when: 'required'}, {});
          break;
        case 'puzzle.data':
          // ★ a **šestnáct tvarů dílku** (`$2763`, §15), ze kterých `$9C3A`
          // skládá obrázek. Do M5 je nikdo nepotřeboval, protože se dílek
          // nekreslil.
          this.data.puzzle = data.data;
          this.fetchData('special.data', {key: 'special', when: 'required'}, {});
          break;
        case 'special.data':
          // ★ **dvě zvláštní místnosti** (M5, §35): osm tónů kódové místnosti
          // a obrázek té řídicí
          this.data.special = data.data;
          this.shuffle(this.seed);
          break;
      } // switch
    }
    super.setData(data);
  } // setData

  /**
   * Shuffles a fortress in the worker and asks for the current room.
   * @param {number} seed - The seed; the same seed is the same fortress.
   */
  shuffle(seed) {
    this.seed = seed;
    this.sendWorkerMessage({message: 'init', seed: seed,
                            fortress: this.data.fortress, rooms: this.data.rooms,
                            speech: this.data.speech, end: this.data.end});
    // ★ Náhled místnosti si vyžádá **jen vývojářská prohlížečka**. Hra
    // začíná v šachtě, takže by postavená místnost jen blikla přes obrazovku
    // a `showRoom` by po ní nechal `this.built` z místa, kde hráč nikdy
    // nebyl (§13, bod 4 — právě tím se kdysi kreslili roboti špatnými
    // barvami).
    if (this.dev) {
      this.sendWorkerMessage({message: 'room', room: this.room, side: this.side});
    } else {
      this.startPlaying();
    }
  } // shuffle

  /**
   * @param {Object} event - The message from `app/gameWorker.js`.
   */
  handleWorkerMessage(event) {
    var data = event.data || {};
    if (data.message === 'ready' && data.fortress) {
      this.password = data.fortress.password;
    }
    if (data.message === 'room' && data.screen) {
      this.showRoom(data);
    }
    if (data.message === 'playing') {
      this.playing = true;
      this.showAgent(data.agent);
      this.drawModel();
    }
    // ★ Na zprávu `frame` se kreslí (R-037): `loopModel` knihovny nekreslí
    // a svět se hýbe ve workeru, takže bez tohohle by obrazovka stála.
    if (data.message === 'frame' && data.agent) {
      // ★ Obraz se od M3 hýbe sám: clony přechodu překreslí dva řádky za dva
      // snímky (§21), jízda šachtou celý řádek (§20) a odchod z místnosti
      // úplně všechno (§22). Worker proto posílá obrazovku, **když se
      // změní**, a model ji přebírá.
      if (data.picture) { this.showPicture(data.picture); }
      // ★ Sprajty chodí **zvlášť od obrazu**, protože od M4 se hýbou i tehdy,
      // když se obraz nemění: robot po plošině a koule po místnosti píšou jen
      // registry VIC (§24). Do M3 se nehýbal nikdo než agent a jezdily
      // s obrazem — kdo to nechá tak, má roboty přilepené tam, kde je
      // postavil stavitel místnosti.
      // ★ V **bezpečnostním terminálu** patří všech osm sprajtů jemu (§29),
      // agent na obrazovce není — takže se kreslí všechny a `showAgent` se
      // vynechá. Bez toho si terminál a agent sprajty 1-3 přepisují
      // navzájem a ty **blikají na střídačku**.
      var inTerminal = !!(data.out && data.out.terminal);
      if (data.sprites) { this.showSpriteState(data.sprites, inTerminal); }
      // ★ A glyfy, které prohledávání přepisuje (§27): okno nad agentem je
      // **přepsaná znaková sada**, ne obrázek, takže se musí přebrat, jinak
      // by v okně byl vidět nábytek.
      if (data.glyphs) { this.showGlyphs(data.glyphs); }
      if (data.window) { this.showWindow(data.window); }
      if (!inTerminal) { this.showAgent(data.agent); }
      this.hearFrame(data);
      // ★ R-037: nakresleno **na zprávu**, takže smyčka už kreslit nemusí
      this.fps.workerFrames++;
      // ★ R-045: a hodiny světa zvlášť — `state.frame` workeru roste o jedna
      // na tik, takže rozdíl řekne, kolik jich mezi dvěma zprávami uteklo
      if (this.fps.lastFrame !== false) { this.fps.ticks += data.frame-this.fps.lastFrame; }
      this.fps.lastFrame = data.frame;
      // ★ Svět ten tik proběhl, takže **stisk je přečtený** — a jestli mezitím
      // hráč pustil, teprve teď se to pošle. Bez toho se ťuknutí kratší než
      // 20 ms ztratí celé (viz `unseenPress`).
      if (this.unseenPress) {
        this.unseenPress = false;
        this.pushJoystick();
      }
      this.drawModel();
      this.needDraw = false;
    }
    // ★ **Konec hry chodí jako obyčejný snímek** — třes, rozpad i tabule jsou
    // obrazovka a nic jiného (§33), takže je nakreslí `showPicture` výš. Tady
    // se řeší jen dvě věci, které obrazovka není: kdy se čeká na jméno, a co
    // se s hotovou síní slávy udělá.
    if (data.message === 'frame' && !data.agent) {
      if (data.picture) { this.showPicture(data.picture); }
      if (data.sprites) { this.showSpriteState(data.sprites, true); }
      this.hearFrame(data);
      this.drawModel();
      this.needDraw = false;
    }
    if (data.enteringName) { this.enteringName = true; }
    if (data.gameOver) { this.finishGame(data.gameOver); }
  } // handleWorkerMessage

  /**
   * Konec hry dojel: síň slávy se uloží a tabule zůstane stát.
   *
   * ★ **Sama od sebe se hra nevrátí do menu.** Originál na tabuli čeká na
   * `RUN/STOP` (`$B88D`) a pak jde na `$38D2`, tedy na **novou hru** —
   * v remaku je to `Escape` nebo křížek v borderu, které vedou do menu
   * (`ZADANI.md` §10.15), a tabule do té doby svítí.
   *
   * @param {Object} over - Co poslal worker: skóre, počitadla a síň slávy.
   */
  finishGame(over) {
    this.enteringName = false;
    this.gameOver = over;
    this.saveFame(over.fame);
    // ★ Svět už neběží (worker si shodil `playing` sám), takže hodiny stojí
    // a joystick nemá kam chodit; `playing` modelu jde dolů s ním, jinak by
    // stisky na tabuli šly do prázdna jako vstup hry.
    this.playing = false;
    this.stopPlaying();
  } // finishGame

  /**
   * Síň slávy z prohlížeče. ★ V originálu je to soubor `HI` na disketě
   * (`$BDFB`, §33); tady `localStorage`, protože na disketu se v prohlížeči
   * nepíše — a **čtení se musí obalit**, protože v soukromém okně vyhodí
   * výjimku i prostý `getItem`.
   *
   * @returns {Array|null} Šestnáct položek, nebo `null`, když se ještě nehrálo.
   */
  loadFame() {
    try {
      var raw = window.localStorage.getItem(GameModel.FAME_KEY);
      if (!raw) { return null; }
      var list = JSON.parse(raw);
      return (list && list.length) ? list : null;
    } catch (ignored) {
      return null;
    }
  } // loadFame

  /**
   * A zpátky.
   * @param {Array} list - Co vrátil worker (`endGame.fameOut`).
   */
  saveFame(list) {
    if (!list || !list.length) { return; }
    try {
      window.localStorage.setItem(GameModel.FAME_KEY, JSON.stringify(list));
    } catch (ignored) {
      // ★ plná nebo zakázaná kvóta síň slávy nezruší, jen ji nepřežije
    }
  } // saveFame

  /**
   * The dev-mode indicator in the border (R-045): drawn frames, `frame`
   * messages and **the world's own ticks**, each per second. ★ Svět tiká
   * 50× za vteřinu (PAL), takže „60/50/50" je v pořádku; „60/12/12" znamená,
   * že worker nestíhá, a „60/50/12", že zprávy chodí, ale svět stojí.
   * @param {number} timestamp - What the animation loop was given.
   */
  updateFps(timestamp) {
    if (!this.borderEntity || !this.borderEntity.fpsEntity) { return; }
    this.fps.frames++;
    if (this.fps.since === false) { this.fps.since = timestamp; return; }
    var elapsed = timestamp-this.fps.since;
    if (elapsed < 1000) { return; }
    this.borderEntity.setFps(Math.round(this.fps.frames*1000/elapsed)+'/'
                             +Math.round(this.fps.workerFrames*1000/elapsed)+'/'
                             +Math.round(this.fps.ticks*1000/elapsed)+' FPS');
    this.fps.frames = 0;
    this.fps.workerFrames = 0;
    this.fps.ticks = 0;
    this.fps.since = timestamp;
  } // updateFps

  /**
   * ★ **The other half of R-037.** `AbstractModel.loopModel` does not draw —
   * it only runs the event queue and the gamepads — so without this the
   * picture stands still whenever the worker is not ticking: under the pause
   * panel, in a tab that lost focus, or if the worker dies. And the modal
   * entity needs its own loop, or the panel never animates.
   * @param {number} timestamp - What the animation loop was given.
   */
  loopModel(timestamp) {
    super.loopModel(timestamp);
    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    }
    this.updateFps(timestamp);
    // obsluha snímku kreslila a shodila příznak; když žádný snímek nepřišel
    // (pauza, modál), kreslí smyčka (R-037)
    if (this.needDraw) {
      this.drawModel();
    }
    this.needDraw = true;
  } // loopModel

  /**
   * ★ **Zvuk snímku** (M6): co hra ten průchod napsala do `$D400`–`$D418`,
   * jde rovnou do modelu čipu ve workletu — a **věta jde s tím**, jako blok
   * vzorků s kadencí 101 cyklů, protože na stroji je to týž registr
   * (`app/audioManager.js`, `app/speech.js` §32).
   * @param {Object} data - Zpráva `frame`.
   */
  hearFrame(data) {
    if (!this.app.audioManager) { return; }
    if (!data.sid && !data.speech) { return; }
    var batch = {frame: data.frame, writes: data.sid || []};
    if (data.speech) {
      // ★ Pátý prvek je **značka**: vrátí se zprávou `blockDone`, až blok
      // dohraje, a tím se worker dozví, že `$BF51` může pustit svět dál.
      batch.blocks = [[0, data.speech.register, data.speech.samples,
                       data.speech.cadence, data.speech.id]];
    }
    this.app.audioManager.writeChip('sid', batch);
  } // hearFrame

  /**
   * The eight sprites of the chip, founded once and in the order the chip
   * draws them.
   *
   * ★ The order is the point. The VIC draws sprite 0 over sprite 1 over …
   * over sprite 7; the library draws a child over the children added before
   * it. So the bank is founded **backwards**, 7 first and 0 last, and from
   * then on nobody adds or destroys anything — the agent is drawn over the
   * robots and under the orb, as he is on the machine, and it stays that way
   * for the whole game.
   *
   * ★ Before this the room's sprites were destroyed and built again on every
   * picture (decoding the blocks each time), which put them **after** the
   * agent and therefore over him. That was wrong for the robots and right for
   * the orb by accident (2026-09-20).
   *
   * @param {number} n - The sprite number, 0-7.
   * @returns {C64SpriteEntity} That sprite's entity.
   */
  hwSprite(n) {
    if (this.hwSprites.length === 0) {
      for (var i = 7; i >= 0; i--) {
        this.hwSprites[i] = new C64SpriteEntity(this.desktopEntity, {});
        this.hwSprites[i].hide = true;
        this.desktopEntity.addEntity(this.hwSprites[i]);
      }
    }
    return this.hwSprites[n];
  } // hwSprite

  /**
   * One sprite of the bank, brought up to what the registers say.
   *
   * ★ The shapes are decoded again **only when the block changes**: a robot
   * walking a platform moves its position registers every frame and its
   * pointer every few (§24), and decoding 504 pixels fifty times a second for
   * a shape that did not move is work for nothing. The agent asks for every
   * frame all the same (`blockId: null`), because turning him mirrors the
   * block **in place** and the pointer does not say so (§13).
   *
   * @param {number} n - The sprite number, 0-7.
   * @param {Object} how - `block` (64 bytes or null), `color`, `multi0`,
   *   `multi1`, `multicolor`, `expandX`, `expandY`, `x`, `y`, `on`.
   */
  putSprite(n, how) {
    var sprite = this.hwSprite(n);
    // ★ Zhasnutý sprajt se schovává **`hide`** — `visible` knihovna nezná,
    // takže se do něj dá přiřadit a nestane se nic (§13). Bez bloku se taky
    // nedá nic nakreslit: to je stav, ve kterém je agent, než začne hrát.
    sprite.hide = !how.on || !how.block;
    if (sprite.hide) { return; }
    if (sprite.multicolor !== !!how.multicolor) { sprite.setMulticolor(how.multicolor); }
    if (sprite.expandX !== !!how.expandX || sprite.expandY !== !!how.expandY) {
      sprite.setExpand(how.expandX, how.expandY);
    }
    // ★ `blockId` je ukazatel sprajtu; `null` znamená **dosadit vždycky**,
    // a to je agent: otočka mu blok **zrcadlí na místě** (§13), takže týž
    // ukazatel neznamená tytéž pixely.
    if (how.blockId === null || sprite.blockShown !== how.blockId) {
      sprite.blockShown = how.blockId;
      sprite.setShapes(Uint8Array.from(how.block), 1);
    }
    sprite.setColors(how.color, how.multi0, how.multi1);
    sprite.setSpritePosition(how.x, how.y);
  } // putSprite

  /**
   * The agent, as the worker's step left him: three hardware sprites, and
   * **the blocks read out of the machine**, because turning him round
   * mirrors the blocks in place (`disasm_notes.md` §13).
   * @param {Object} agent - What `player.view()` returned.
   */
  showAgent(agent) {
    var i;
    // ★ **Ne `this.built`**: to je místnost z náhledu, a hra, která začíná
    // v šachtě (`$3960`, `player.startShaft`), žádnou nepostavila. Čeká se
    // na sady, protože bez nich není na čem agenta kreslit.
    if (!this.sets && !this.data.charset) { return; }
    if (!agent.sprites.color) { return; }
    // ★ příznaky i barvy jsou **ze stroje**, ne z postavené místnosti: barvy
    // agenta se sázejí až po stavbě (`$970E`), takže v místnosti jsou nuly
    for (i = 0; i < 3; i++) {
      var bit = 1 << (i + 1);
      // ★ Agent **není multicolor.** `$D01C` je v místnosti `$F1` a v šachtě
      // `$01` — multicolor je koule (sprajt 0) a roboti (4-7), sprajty
      // agenta 1-3 jsou v obou případech hires. Kdo je nakreslí jako
      // multicolor, dostane figurku rozsypanou na dvojnásobně široké body,
      // protože se bitové dvojice čtou jako barvy.
      // ★ A sprajt, který VIC nesvítí, se musí **schovat** (dělá to
      // `putSprite`). Je to vidět **jen v saltu**: `$8737` ve stavech
      // `$14`-`$19` shodí v `$D015` bit 2 a ukazatel prostředního sprajtu
      // nechá stát, takže by na obrazovce visel **starý blok** (§13, §17).
      // ★ Bloky agenta se dosazují **každý snímek**, na rozdíl od ostatních
      // sprajtů: otočka je **zrcadlí na místě** (§13), takže stejný ukazatel
      // neznamená stejné pixely — proto tu `blockShown` není.
      this.putSprite(i + 1, {
        block: agent.sprites.blocks[i], blockId: null,
        color: agent.sprites.color[i],
        multi0: agent.shared[0], multi1: agent.shared[1],
        multicolor: agent.multicolor & bit,
        expandX: agent.expandX & bit, expandY: agent.expandY & bit,
        x: agent.sprites.x[i], y: agent.sprites.y[i],
        on: agent.enabled & bit
      });
    }
    this.status = 'ROOM ' + this.room + '  ' + this.clockOf(agent.clock)
      + '  STATE $' + agent.state.toString(16);
  } // showAgent

  /**
   * The picture the worker sent, whichever place it belongs to.
   *
   * ★ Which character set the VIC reads says which it is (§6): `$04` is the
   * room's set (`$5000`), `$02` the shaft's (`$4800`) and `$06` the pocket
   * computer's (`$5800`). The shaft is **split** — its bottom ten rows are
   * drawn with the computer's set and other background colours — and the
   * split is data, `C64TextRAM.setSplits()`, not an interrupt.
   *
   * @param {Object} picture - `screen`, `color`, `charset`, `colors`.
   */
  showPicture(picture) {
    // ★ Sada šachty (`$D018` = `$02`) je **dvojznačná**: čte ji i
    // **bezpečnostní terminál** (§29), který si jen přepne `$D018` o dvě
    // níž. Rozhodne `$1A`: v šachtě je 0, v terminálu 1, protože ten se
    // otevírá z místnosti. A **terminál dělený není** — kdo mu nasadí pruhy
    // šachty, dostane spodní třetinu kreslenou sadou kapesního počítače.
    // ★ **Kterou sadou se kreslí a jestli se obraz dělí, jsou dvě různé
    // otázky.** Sadu říká `$D018`, a ta platí vždycky. Pruhy dělá **clona**,
    // a ta za úvodní řečí neběží: ve vektoru je `$838C`, obsluha, která jen
    // zvedne `$E0` (`$391E` ≺ `$BF3A`), takže je obrazovka celá sadou šachty
    // a panel na ní ještě není (§22). Kdo si ty dvě otázky splete, nakreslí
    // za řeči celou šachtu **sadou místnosti** a grafika se rozsype
    // (nahlásil operátor 2026-09-21).
    var shaftSet = picture.charset === 1;
    var split = shaftSet && picture.place === 0 && picture.irq !== 0x838C;
    var sets = this.charsets();
    if (!sets.room) { return; }
    var textRAM = new C64TextRAM(Uint8Array.from(picture.screen),
                                 Uint8Array.from(picture.color));
    textRAM.setMulticolor(true);
    textRAM.setBackground(picture.colors.background0);
    textRAM.setSharedColors(picture.colors.background1, picture.colors.background2);
    textRAM.showCursor(false);
    if (split && sets.computer) {
      // ★ pruhy jsou změřené na běžící hře a vezou se v `data/elevator.json`
      textRAM.setSplits(this.data.elevator.splits.map(function (s) {
        return {fromLine: Math.max(0, s.fromRaster - 50),
                font: s.charsetAddr === 22528 ? sets.computer : sets.shaft,
                background: s.background0, background1: s.background1,
                background2: s.background2};
      }));
    } else {
      textRAM.setSplits(null);
    }
    this.screen.textRAM = textRAM;
    // ★ **Která sada je na obrazovce, si model musí pamatovat**: přepíše ji
    // i `showGlyphs` a `showWindow`, které sady přestavují (§27, §34), a bez
    // toho by ji vrátily na sadu místnosti (viz `refont`).
    this.fontSet = shaftSet ? 'shaft' : 'room';
    this.screen.setFont(sets[this.fontSet]);
    this.screen.paintedVersion = -1;
    this.desktopEntity.bkColor = C64Color.color(picture.colors.background0);
    if (this.borderEntity != null) {
      this.borderEntity.bkColor = C64Color.color(picture.colors.border);
    }
    this.place = picture.place;
    if (picture.sprites) { this.showSpriteState(picture.sprites); }
  } // showPicture

  /**
   * The sprites that are **not** the agent, as the machine has them: the orb
   * and the robots in a room, the cabin and the pocket computer's marker in
   * the shaft. Sprites 1 to 3 are the agent and `showAgent` owns them.
   * @param {Object} state - What the worker read out of the VIC.
   * @param {boolean} [all] - ★ True v **bezpečnostním terminálu**, kde
   *   všech osm sprajtů patří jemu a agent na obrazovce není (§29).
   */
  showSpriteState(state, all) {
    if (!this.data.sprites) { return; }
    var blocks = this.data.sprites.blocks;
    for (var i = 7; i >= 0; i--) {
      if (!all && i >= 1 && i <= 3) { continue; }         // agent, `showAgent`
      var bit = 1 << i;
      // ★ Blok, který hra **postavila za běhu** (značka kabiny na mapě
      // pevnosti, `$B6FE`), v `data/sprites.json` není — veze ho proto
      // zpráva. A `blockId` je pak `null`, protože týž ukazatel neznamená
      // tytéž body: obsah `$4D80` se přepisuje.
      var live = state.blocks && state.blocks[state.pointer[i]];
      this.putSprite(i, {
        block: live || this.blockOf(blocks, state.pointer[i]),
        blockId: live ? null : state.pointer[i],
        color: state.color[i],
        // ★ Sdílené barvy sprajtů jsou **ve stavu sprajtů**, ne v postavené
        // místnosti: `this.built` je místnost z náhledu (`showRoom`), a ta
        // se za hry nemění — agent projde dveřmi a robotům by zůstaly barvy
        // z předchozí. V bloku robota je `$D026` osmdesát bodů z dvou set
        // čtyř, takže je to vidět hned (v půlce místností je bílá).
        multi0: state.multi0 | 0, multi1: state.multi1 | 0,
        multicolor: state.multicolor & bit,
        expandX: state.expandX & bit, expandY: state.expandY & bit,
        x: state.x[i] | (((state.msbX >> i) & 1) << 8), y: state.y[i],
        on: state.enabled & bit
      });
    }
  } // showSpriteState

  /**
   * The three character sets the game draws with, built once and kept.
   * @returns {Object} `{room, shaft, computer}`.
   */
  /**
   * The glyphs the worker says have changed, into the set the room is drawn
   * with. ★ `C64Charset` keeps the bytes it was built from, so the set is
   * rebuilt — eighteen glyphs, a few times per search, is nothing.
   * @param {Object} glyphs - `{at, bytes}` out of the machine.
   */
  showGlyphs(glyphs) {
    if (!this.data.charset) { return; }
    var at = glyphs.at - 0x5000, i;
    for (i = 0; i < glyphs.bytes.length; i++) {
      this.data.charset.bytes[at + i] = glyphs.bytes[i];
    }
    this.refont();
  } // showGlyphs

  /**
   * ★ Sady se přestavují za běhu — prohledávání přepisuje glyfy sady
   * místnosti (§27) a kapesní počítač okno sady počítače (§34) — a tohle je
   * to, co po přestavbě dosadí **tytéž sady zpátky tam, kde visely**:
   * do obrazovky i do **pruhů**, které si sadu drží odkazem.
   *
   * ★★ Bez toho `showGlyphs` sázel natvrdo sadu místnosti. Dokud měla
   * šachta pruhy, nebylo to vidět — pruh si sadu nese sám, takže se kreslilo
   * správně navzdory špatnému písmu obrazovky. Jakmile se ukázalo, že za
   * úvodní řečí **clona neběží a pruhy tedy nejsou** (§22), zůstala obrazovka
   * na sadě místnosti a celá se rozsypala; sprajty, které sadu nepotřebují,
   * vypadaly dál dobře (nahlásil operátor 2026-09-21).
   */
  refont() {
    var old = this.sets;
    this.sets = null;                        // postaví se znovu
    var sets = this.charsets(), textRAM = this.screen.textRAM, i;
    this.screen.setFont(sets[this.fontSet || 'room']);
    if (old && textRAM && textRAM.splits) {
      for (i = 0; i < textRAM.splits.length; i++) {
        if (textRAM.splits[i].font === old.computer) { textRAM.splits[i].font = sets.computer; }
        else if (textRAM.splits[i].font === old.shaft) { textRAM.splits[i].font = sets.shaft; }
        else if (textRAM.splits[i].font === old.room) { textRAM.splits[i].font = sets.room; }
      }
      textRAM.version++;
    }
    this.screen.paintedVersion = -1;
  } // refont

  /**
   * ★ The six slots of the pocket computer, and they are **glyphs of the
   * computer's set** (§34): `$5C50` + `$90` apiece. The puzzle is not drawn
   * anywhere else, so without this the window keeps whatever the map put in
   * it — the same trap as the window of a search, one set over.
   * @param {Object} window - `{at, bytes}` out of the machine.
   */
  showWindow(window) {
    if (!this.data.charsetComputer) { return; }
    var at = window.at - this.data.charsetComputer.addr, i;
    if (at < 0) { return; }
    for (i = 0; i < window.bytes.length; i++) {
      this.data.charsetComputer.bytes[at + i] = window.bytes[i];
    }
    // ★ Pruhy šachty (`setSplits`) si sadu **drží odkazem**, takže samotné
    // přestavění `this.sets` na spodní panel nedosáhne — a mapa pevnosti se
    // kreslí právě tam (§14). Bez tohohle by se okno projevilo až při
    // nejbližší změně obrazovky, tedy o krok výtahu později.
    this.refont();
  } // showWindow

  charsets() {
    if (!this.sets) {
      this.sets = {
        room: this.charsetOf(this.data.charset),
        shaft: this.charsetOf(this.data.charsetShaft),
        computer: this.charsetOf(this.data.charsetComputer)
      };
    }
    return this.sets;
  } // charsets

  /**
   * One character set as the **machine** has it, not as the disk does.
   *
   * ★ Písmena a číslice v sadě šachty a kapesního počítače **na disketě
   * nejsou**: `$39AA` si přepne `$01` na `$21` a nakopíruje je do obou sad
   * z **Char ROM stroje** (§14). `data/charset_*.json` je proto vezou
   * zvlášť, v `charRom.parts`, a kdo je nedosadí, má v terminálu i v šachtě
   * rámečky bez textu (nahlásil operátor 2026-09-20).
   *
   * @param {Object} data - Parsed `charset_*.json`.
   * @returns {C64Charset|null} The set, or null when the file is not in yet.
   */
  charsetOf(data) {
    if (!data) { return null; }
    var bytes = Uint8Array.from(data.bytes), parts, i, j, at;
    parts = (data.charRom && data.charRom.parts) || [];
    for (i = 0; i < parts.length; i++) {
      at = parts[i].addr - data.addr;
      for (j = 0; j < parts[i].bytes.length; j++) {
        bytes[at + j] = parts[i].bytes[j] & 0xFF;
      }
    }
    return new C64Charset(bytes);
  } // charsetOf

  /**
   * The clock of the original, in BCD, as the pocket computer prints it.
   * @param {Object} clock - `{hours, minutes, seconds}` in BCD.
   * @returns {string} `12:04:11`.
   */
  clockOf(clock) {
    var two = function (bcd) {
      return ((bcd >> 4) & 15).toString(10) + (bcd & 15).toString(10);
    };
    return two(clock.hours) + ':' + two(clock.minutes) + ':' + two(clock.seconds);
  } // clockOf

  /**
   * The joystick byte the agent's step reads: port 2, **active low**, bit 0
   * up, 1 down, 2 left, 3 right, 4 button (`disasm_notes.md` §7). The keys
   * of a keyboard stand in for it.
   * @returns {number} What `$DC00` would give.
   */
  joystickOf() {
    var down = 0x7F, k = this.keys;
    if (k.ArrowUp) { down &= ~0x01; }
    if (k.ArrowDown) { down &= ~0x02; }
    if (k.ArrowLeft) { down &= ~0x04; }
    if (k.ArrowRight) { down &= ~0x08; }
    if (k[' '] || k.Mouse1 || k.Touch) { down &= ~0x10; }
    return down & 0xFF;
  } // joystickOf

  /**
   * Puts a built room into the machine: the text mode first, the sprites on
   * top of it, the way the chip has them ($D01B is 0 in a room, so sprites
   * are in front of the picture — `disasm_notes.md` §6).
   * @param {Object} built - What the worker sent back.
   */
  showRoom(built) {
    var textRAM = new C64TextRAM(Uint8Array.from(built.screen),
                                 Uint8Array.from(built.color));
    textRAM.setMulticolor(true);
    textRAM.setBackground(built.colors.background0);
    textRAM.setSharedColors(built.colors.background1, built.colors.background2);
    textRAM.showCursor(false);
    this.screen.textRAM = textRAM;
    // ★ náhled místnosti je jediné místo, kde se sada volí **napevno** — a
    // i tady přes `fontSet`, aby ji `refont` uměl dosadit zpátky
    this.fontSet = 'room';
    this.screen.setFont(this.charsets().room);
    this.screen.paintedVersion = -1;
    this.desktopEntity.bkColor = C64Color.color(built.colors.background0);
    if (this.borderEntity != null) {
      // ★ Rámeček **není pozadí**: `$D020` a `$D021` jsou dva registry a hra
      // drží rámeček černý po celou dobu (`$3967`), i když se pozadí
      // místnost od místnosti mění.
      this.borderEntity.bkColor = C64Color.color(built.colors.border);
    }
    this.built = built;
    this.showSprites(built);
    this.showStatus(built);
    // ★ The room arrives from the worker, not from `setData`, so nothing has
    // drawn it: `loopModel` of the library does not paint (it only runs the
    // queue and the gamepads), painting happens in `drawModel`. Until M3 the
    // room is a still picture, so it is drawn right here; from M3 on it will
    // be drawn on the `frame` message of the worker, with `needDraw` (R-037).
    this.drawModel();
  } // showRoom

  /**
   * The hardware sprites: the pointer picks the block out of
   * `data/sprites.json`, the registers say where it is and how it looks.
   *
   * ★ The builder places the **robots** (sprites 4-7, pointer `$C0`) and the
   * **orb** (sprite 0, `$1F`), not the agent: which block the agent shows is
   * decided by its state through `$8731` (`disasm_notes.md` §13), and the
   * agent's state machine is M3. So sprites 1-3 are on in `$8E` but have no
   * pointer yet, and a sprite without a block is left out.
   *
   * @param {Object} built - What the worker sent back.
   */
  showSprites(built) {
    var blocks = this.data.sprites.blocks, state = built.sprites;
    for (var i = 7; i >= 0; i--) {
      var bit = 1 << i;
      this.putSprite(i, {
        block: this.blockOf(blocks, built.spritePointers[i]),
        blockId: built.spritePointers[i],
        color: built.colors.sprites[i],
        multi0: built.colors.spriteMulti0, multi1: built.colors.spriteMulti1,
        multicolor: state.multicolor & bit,
        expandX: state.expandX & bit, expandY: state.expandY & bit,
        x: state.x[i] | (((state.msbX >> i) & 1) << 8), y: state.y[i],
        on: state.enabled & bit
      });
    }
  } // showSprites

  /**
   * The 64-byte block a sprite pointer points at. The pointers of the
   * original are counted from the start of VIC bank 1, and that is how
   * `tools/dumpsprites.py` wrote them down.
   * @param {Object} blocks - The `blocks` of `data/sprites.json`.
   * @param {number} pointer - The pointer, 0-255.
   * @returns {number[]|null} The 64 bytes, or null when nothing is there.
   */
  blockOf(blocks, pointer) {
    var keys = Object.keys(blocks);
    for (var i = 0; i < keys.length; i++) {
      if (blocks[keys[i]].pointer === pointer) { return blocks[keys[i]].bytes; }
    }
    return null;
  } // blockOf

  /**
   * One line over the room saying what is being looked at. It is written in
   * the room's own character set, so it is drawn with the sprites' colours
   * off to the side — in M2 the room is still a picture, not a game.
   * @param {Object} built - What the worker sent back.
   */
  showStatus(built) {
    this.status = 'ROOM ' + built.room + (built.side ? ' R' : ' L')
      + (built.codeRoom ? ' CODE' : '')
      + '  SEED ' + this.seed + '  ' + this.password.toUpperCase();
    console.log('GameModel: ' + this.status
      + '  (' + built.furniture + ' furniture, ' + built.robots + ' robots)');
  } // showStatus

  /**
   * The keys of M2: walk the rooms, turn the entry around, shuffle another
   * fortress, go back to the menu.
   * @param {Object} event - The library's event.
   * @returns {boolean} Whether it was taken.
   */
  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    if (event.id === 'continueGame') {
      this.resumeGame();
      return true;
    }
    // ★ **Čip hlásí, že věta dohrála** (`blockDone`, `ChipStream`): na stroji
    // `$BF51` čeká, až přehrávač domluví (`$BF7E`), a teprve pak jede svět
    // dál — tady na to čeká worker a tohle je ta zpráva, na kterou čeká.
    // Přijde i tehdy, když zvuk nehraje vůbec, protože sběrnice, která blok
    // nepřehraje, ho dohlásí sama (`AbstractAudioHandler.reportBlocksDone`).
    if (event.id === 'blockDone') {
      var tags = (event.data && event.data.tags) || [];
      if (tags.length) {
        this.sendWorkerMessage({message: 'spoken', ids: tags});
      }
      return true;
    }
    // ★ a tab that loses focus stops: the worker would tick on in the
    // background and the agent would be somewhere else when it comes back
    if (event.id === 'blurWindow') {
      this.pauseGame();
      return true;
    }
    if (event.id === 'keyRelease') {
      delete this.keys[event.key];
      return this.pushJoystick();
    }
    if (event.id !== 'keyPress') {
      return false;
    }
    this.keys[event.key] = true;
    var key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    // ★ **Na tabuli se píše jméno**, ne hraje (§33): klávesnice jde do
    // workeru jako screen codes sady šachty. `Escape` se nechává projít, aby
    // z tabule vedla cesta do menu i uprostřed zadávání.
    if (this.enteringName && key !== 'Escape') {
      return this.pushName(event.key);
    }
    if (key === 'Escape') {
      // ★ **Z tabule se nepauzuje, z tabule se odchází.** Originál na ní čeká
      // na `RUN/STOP` a jde na `$38D2`, tedy na novou hru (§33); tady vede
      // `Escape` (a s ním křížek v borderu) na titulku, odkud se nová hra
      // pustí spouští — je to týž tok, jen v tvaru sourozenců.
      if (this.gameOver) {
        this.endGame();
        return true;
      }
      this.pauseGame();
      return true;
    }
    // ★ `P` rozejde agenta (M3) — ale **jen když nehraje**: podruhé by hru
    // postavilo znovu od začátku, a v rozehrané hře je `P` prostě klávesa
    if (key === 'P' && !this.playing) {
      this.startPlaying();
      return true;
    }
    if (this.playing) {
      return this.pushJoystick();
    }
    switch (key) {
      case 'ArrowRight':
      case 'Mouse1':
      case 'Touch':
        this.room = (this.room + 1) & 31;
        break;
      case 'ArrowLeft':
        this.room = (this.room + 31) & 31;
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        this.side = this.side ? 0 : 1;
        break;
      case 'N':
        this.shuffle(this.seed + 1);
        return true;
      default:
        return false;
    } // switch
    this.sendWorkerMessage({message: 'room', room: this.room, side: this.side});
    return true;
  } // handleEvent

  /**
   * Jeden stisk do síně slávy.
   *
   * ★ **Překládá se na screen code sady šachty**, protože originál si nic
   * jiného neumí přečíst: jeho `$BEA5` vrací rovnou to, co se dá napsat na
   * obrazovku (tabulka `$BEF0`, §33). Písmena jsou od `$71`, číslice od
   * `$8B`; `Enter` je `$00`, `Backspace` `$01`, a co se nedá napsat, se
   * zahodí.
   *
   * @param {string} raw - `event.key`, jak přišla.
   * @returns {boolean} Jestli se klávesa vzala.
   */
  pushName(raw) {
    var code = null;
    if (raw.length === 1) {
      var ch = raw.toLowerCase();
      if (ch >= 'a' && ch <= 'z') { code = 0x71 + (ch.charCodeAt(0)-97); }
      else if (ch >= '0' && ch <= '9') { code = 0x8B + (ch.charCodeAt(0)-48); }
      else if (ch === ' ') { code = 0x53; }
    } else if (raw === 'Enter') { code = 0x00; }
    else if (raw === 'Backspace' || raw === 'Delete') { code = 0x01; }
    if (code === null) { return false; }
    this.sendWorkerMessage({message: 'name', key: code});
    return true;
  } // pushName

  /**
   * Sends the joystick to the worker, but only when it has changed — the
   * step reads one byte a frame and nothing else.
   * @returns {boolean} Whether the key was taken.
   */
  pushJoystick() {
    if (!this.playing) { return false; }
    var value = this.joystickOf();
    if (value === this.joystick) { return true; }
    // ★ Port 2 je **aktivní v nule** (§7): stisknuté je to, co je v bajtu
    // nulové, takže se s tím počítá přes masku stisků.
    var was = (~this.joystick) & 0x1F, now = (~value) & 0x1F;
    // ★ Puštění, které by zrušilo stisk, jejž svět ještě nepřečetl, se
    // **neposílá** — dopošle ho obsluha zprávy `frame`, tedy až za tikem.
    if (this.unseenPress && (was & ~now)) { return true; }
    if (now & ~was) { this.unseenPress = true; }   // něco se zmáčklo
    this.joystick = value;
    this.sendWorkerMessage({message: 'input', joystick: value});
    return true;
  } // pushJoystick

  /**
   * Starts the world in the worker's machine and the clock with it (M3).
   *
   * ★ **A game starts in the shaft** (`$3960`-`$3A12`, `player.startShaft`):
   * the agent stands in the cabin under the ceiling of the fortress, and a
   * room is something he rides to and walks into. Building a room to stand
   * in is the developer's way in — the menu's A ROOM OF THE FORTRESS, `dev`,
   * where `P` is what starts him.
   *
   * @param {string} [where] - `'shaft'` or `'room'`; `dev` decides by itself.
   */
  startPlaying(where) {
    // ★ Sběrnice `sid` se otevírá **až tady**, za gestem uživatele (R-024):
    // menu je němé a prohlížeč zvuk bez gesta nepustí.
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sid', options: {}});
    this.sendWorkerMessage({message: 'play',
                            where: where || (this.dev ? 'room' : 'shaft'),
                            room: this.room, side: this.side,
                            global: this.data.global, sprites: this.data.sprites,
                            shaft: this.data.shaft, furniture: this.data.furniture,
                            terminal: this.data.terminal, charset: this.data.charset,
                            // ★ sada šachty jde do **paměti stroje**, ne jen
                            // do fontu: leží v ní `$4EF0`, ze kterého start
                            // bere výšky sprajtů agenta (§14, `plSeedMemory`)
                            charsetShaft: this.data.charsetShaft,
                            // ★ M5: tabulky kapesního počítače a tvary dílku (§34)
                            computer: this.data.computer, puzzle: this.data.puzzle,
                            special: this.data.special,
                            // ★ **síň slávy z prohlížeče**: v originálu ji
                            // před hrou nahraje `LOAD "HI"` (`$3887`, §33),
                            // tady ji drží `localStorage` — a musí být
                            // v paměti stroje **dřív**, než se do ní vkládá
                            fame: this.loadFame(),
                            // ★ `?devClock=5:59:57` — jediná cesta, jak konec hry
                            // v prohlížeči vidět, aniž by se hrálo sedm hodin
                            clock: this.app.devClock()});
    this.sendWorkerMessage({message: 'start'});
  } // startPlaying

  /**
   * Stops the world and puts the panel up.
   *
   * ★ The worker has to be told. Its clock is a `setTimeout` of its own
   * (`app/gameWorker.js`), so a modal entity over the picture would hide a
   * world that keeps running — the agent would walk behind the panel and
   * the ten minutes would tick away. `stop` only stops the timer; what the
   * machine has stays where it is, and `start` goes on from there.
   *
   * ★ **A se světem se musí zastavit i čip.** Zvuk téhle hry není přehrávaná
   * nahrávka, je to **model SID**, který si ve workletu běží po svých
   * (`app/audioManager.js`, R-044): zastavený svět mu přestane posílat
   * zápisy, ale poslední, co dostal, byl **otevřený gate** — a tón, který na
   * něm visí, drží dál, protože ho nemá co zavřít (nahlásil operátor
   * 2026-09-20: „hra se pauzla, ale zůstaly viset poslední tóny").
   * ★ A je to **`pause`, ne `stop`**: `stop` čipu zahodí frontu a
   * **vynuluje registry** (`ChipStream.stop`), takže by se hra probudila
   * s jiným zvukem, než s jakým usnula. `pause` proud jen postaví — ztichne
   * hned, stav si nechá a `continue` v něm pokračuje.
   */
  pauseGame() {
    if (this.paused) { return; }
    this.paused = true;
    if (this.playing) {
      this.sendWorkerMessage({message: 'stop'});
      if (this.app.audioManager) { this.sendEvent(0, {id: 'pauseAllAudioBuses'}); }
      // ★ and the joystick is let go with it: the last byte sent stays in
      // the worker, so an agent paused mid-stride would walk on when the
      // panel closes
      this.keys = {};
      this.joystick = 0x7F;
      this.sendWorkerMessage({message: 'input', joystick: this.joystick});
    }
    this.desktopEntity.addModalEntity(new PauseGameEntity(this.desktopEntity,
      84, 72, 153, 44, 'PAUSE GAME', 'MenuModel'));
  } // pauseGame

  /** The panel's RESUME (or Escape again): the worker ticks on — ★ a s ním
   * i čip, který stojí od `pauseGame`. */
  resumeGame() {
    if (!this.paused) { return; }
    this.paused = false;
    if (this.playing) {
      this.sendWorkerMessage({message: 'start'});
      if (this.app.audioManager) { this.sendEvent(0, {id: 'continueAllAudioBuses'}); }
    }
  } // resumeGame

  /**
   * The end of a game: back to the title screen, as in the siblings.
   *
   * ★ **Volá se z tabule** (M5, §33): hodiny dojdou na šestou, `$83DF` shodí
   * `$43`, worker odehraje třes, rozpad a tabuli se skóre a pošle
   * `gameOver`; tabule pak svítí, dokud hráč nedá `Escape` nebo křížek
   * v borderu. Originál by na `RUN/STOP` pustil **novou hru** (`$38D2`);
   * tady se jde na titulku, protože odtud vede nová hra spouští
   * (`ZADANI.md` §10.15).
   */
  endGame() {
    this.stopPlaying();
    this.app.setModel('MainModel');
  } // endGame

  /** Stops the clock; the model is leaving. ★ And the chip with it, so the
   * speech stops too — it is the chip being driven, not a sample playing. */
  stopPlaying() {
    if (this.playing) {
      this.sendWorkerMessage({message: 'stop'});
      // ★ **Zastavit, ne zavřít**: zavírá menu (R-024, `MenuModel.init`),
      // protože teprve tam se má model čipu zahodit i s registry. Odsud se
      // dá jít do hry rovnou zpátky (konec hry → titulka → hra).
      if (this.app.audioManager) { this.sendEvent(0, {id: 'stopAllAudioBuses'}); }
      this.playing = false;
    }
  } // stopPlaying

  /**
   * ★ Whichever way the model is left — the panel's EXIT, the end of a
   * game, anything — the world is stopped here. The worker outlives the
   * model (it hangs on the application), so a model that goes away without
   * saying so leaves it ticking into nobody.
   */
  shutdown() {
    this.stopPlaying();
    super.shutdown();
  } // shutdown

  /**
   * Sends to the worker of the application.
   * @param {Object} message - The message.
   */
  sendWorkerMessage(message) {
    if (this.app.worker) {
      this.app.worker.postMessage(message);
    }
  } // sendWorkerMessage

} // GameModel
