const { AbstractApp } = await import('./svision/js/abstractApp.js?ver='+window.srcVersion);
const { C64Fonts8x8 } = await import('./svision/js/platform/canvas2D/c64/c64Fonts8x8.js?ver='+window.srcVersion);
const { Fonts5x5 } = await import('./svision/js/platform/canvas2D/fonts5x5.js?ver='+window.srcVersion);
const { C64BootModel } = await import('./svision/js/platform/canvas2D/c64/c64BootModel.js?ver='+window.srcVersion);
const { MainModel } = await import('./mainModel.js?ver='+window.srcVersion);
const { MenuModel } = await import('./menuModel.js?ver='+window.srcVersion);
const { AboutModel } = await import('./aboutModel.js?ver='+window.srcVersion);
const { GameModel } = await import('./gameModel.js?ver='+window.srcVersion);
const { AudioManager } = await import('./audioManager.js?ver='+window.srcVersion);
const { Version } = await import('./version.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
// begin code

/**
 * The application: switches the machine on, loads the game the way the
 * original's disk does it and shows what M1 has — the title screen of the
 * original, built from its memory.
 *
 * ★ The boot commands are the ones the manual gives (`LOAD"*",8` and `RUN`,
 * `sources/docs/manual_transcript.md`), not the usual `,8,1`: the first file
 * on the disk is a BASIC loader (`disasm_notes.md` §4).
 *
 * ★ **The SID hangs on the one `sid` bus** (`app/audioManager.js`, M6):
 * the register writes the worker reports go straight into the library's
 * model of the chip, and the speech — which on the machine is the same
 * register — rides with them as a block of samples.
 *
 * The world lives in a worker from M2 on (`app/gameWorker.js`): it shuffles
 * the fortress with the original's routines and builds a room out of what it
 * shuffled. It is a classic worker script — it takes `fortressGen.js`,
 * `fortressMap.js`, `roomBuild.js` and `roomsLoader.js` with `importScripts`,
 * so all five have to be reachable by URL (`config/compile.json`).
 */
export class MainApp extends AbstractApp {

  /**
   * @param {Object} platform - `app/appPlatform.js`.
   * @param {string} importPath - Where the application's files are.
   * @param {string} wsURL - The library's socket.
   * @param {string} [devModeName] - ★ The banner the developer build puts
   *   in the border (`app/borderEntity.js`). A production build has none,
   *   so this stays undefined — the border tests for a string, not for
   *   `false`, because the sibling remakes' apps take it as an argument and
   *   this one did not.
   */
  constructor(platform, importPath, wsURL, devModeName) {
    super(platform, 'bodyApp', importPath, wsURL);
    this.id = 'MainApp';
    this.version = Version;
    this.devModeName = devModeName;

    this.worker = new Worker(this.importPath+'/gameWorker.js?ver='+window.srcVersion);
    this.worker.onmessage = (event) => {
      if (this.model) {
        this.model.handleWorkerMessage(event);
      }
    };
    // a worker that dies says nothing by itself: without this the picture
    // simply never arrives and there is nothing to go on
    this.worker.onerror = (event) => {
      console.error('gameWorker: '+event.message+' ('+event.filename+':'+event.lineno+')');
    };

    this.audioManager = new AudioManager(this);

    /**
     * ★ **Semínko pevnosti** — entropie, kterou remake dosazuje za rastr
     * (`EOR $D012` na `$82E3`, §8). Losuje se **jednou na hru**, ne jednou
     * na aplikaci: s pevnou hodnotou je pevnost pokaždé tatáž a hráč vejde
     * do první místnosti vlevo a vidí, co viděl minule.
     *
     * ★ **Není to `Math.random()`** (`ZADANI.md` §10.4): bere se z hodin,
     * jako u sourozenců (`boulderdash/app/gameApp.js`), takže dvě hry se
     * liší, ale jedna se dá zopakovat — semínko se dá pevně nastavit
     * v `$devMode` (§10.3) a `tools/runworker.mjs` si posílá vlastní.
     */
    this.gameSeed = this.devSeed() || 1;

    this.fonts = {};
    /** the character ROM, for the menu and for ABOUT */
    this.fonts.c64Fonts8x8 = new C64Fonts8x8(this, false);
    /** the library's small font, for the titles of the panels the remake adds */
    this.fonts.fonts5x5 = new Fonts5x5(this);
    // ★ The banner of a developer build is `◢◤ ◢◤ … DEVELOPER MODE … ◢◤ ◢◤`
    // (`svision/php/appPage.php`), and the library's core font is ASCII only
    // — without these two triangles the stripes around the text are missing.
    // The same pair the siblings add (`boulderdash/app/gameApp.js`).
    this.fonts.fonts5x5.addGlyphs({
      '◢': {width: 4, data: [[4,0,1,1], [3,1,2,1], [2,2,3,1], [1,3,4,1], [0,4,5,1]]},
      '◤': {width: 4, data: [[0,0,5,1], [0,1,4,1], [0,2,3,1], [0,3,2,1], [0,4,1,1]]}
    });

    this.controls = {
      keyboard: {},
      mouse: {enable: false},
      gamepads: {supported: false, devices: {}},
      touchscreen: {supported: false, type: false}
    };

    this.setModel('BootModel');
  } // constructor

  /**
   * Switches models.
   * ★ The chain is the sibling remakes' (`boulderdash/app/gameApp.js`):
   * the boot goes to the **menu**, the menu's START GAME shows the
   * **title screen of the original**, the title screen starts the
   * **game**, and the end of a game comes back to the title screen. Escape
   * anywhere in that last pair opens the pause panel, whose EXIT is the
   * one way back to the menu (`app/pauseGameEntity.js`).
   *
   * @param {string} model - 'BootModel', 'MenuModel', 'MainModel',
   *   'GameModel' or 'AboutModel'.
   * @param {Object} [options] - What the model is opened with; the only one
   *   there is is `GameModel`'s `dev`, which leaves the agent standing so
   *   that the rooms can be walked through (the menu's A ROOM OF THE
   *   FORTRESS).
   */
  /**
   * The seed a developer build may pin, so that a run can be repeated:
   * `?devSeed=` in the address, or `$devMode = ['seed' => N]` (`Tool.devParam`).
   * ★ Never shown in the menu — the original offers no seed (§10.3).
   * @returns {number} The seed, or 0 when nothing pins one.
   */
  devSeed() {
    var pinned = Number(Tool.devParam('devSeed', 0));
    return (Number.isFinite(pinned) && pinned > 0) ? (pinned & 0x7FFFFFFF) : 0;
  } // devSeed

  /**
   * Hodiny, se kterými hra začne — `?devClock=` v adrese, nebo
   * `$devMode = ['clock' => '5:59:57']` (`Tool.devParam`), ve tvaru `h:m:s` šestnáctkově (BCD, jak je má stroj).
   *
   * ★ **Bez tohohle se konec hry nedá v prohlížeči vidět.** Hodiny jdou od
   * dvanácté k šesté, tedy **1 296 000 snímků** — sedm hodin hraní na jednu
   * kontrolu (§33). `?devClock=5:59:57` je posadí tři vteřiny před konec a
   * přetečení pak udělá **rutina originálu** (`$83C2`), ne záplata.
   * ★ V menu to není a být nemá: originál žádné hodiny nabídnout neumí.
   *
   * @returns {number[]|null} `[hodiny, minuty, vteřiny]` v BCD, nebo `null`.
   */
  devClock() {
    var text = String(Tool.devParam('devClock', ''));
    var parts = text.split(':');
    if (parts.length !== 3) { return null; }
    var out = parts.map(function (x) { return parseInt(x, 16); });
    return out.every(function (x) { return Number.isFinite(x); }) ? out : null;
  } // devClock

  /** ★ A fresh fortress for every game, unless `$devMode` pinned one. */
  newGameSeed() {
    var pinned = this.devSeed();
    this.gameSeed = pinned || ((Date.now() & 0x7FFFFFFF) || 1);
    return this.gameSeed;
  } // newGameSeed

  setModel(model, options) {
    var needResizeApp = false;
    if (this.model) {
      this.model.shutdown();
      needResizeApp = true;
    }
    switch (model) {
      case 'BootModel':
        this.model = new C64BootModel(this, {
          nextModel: 'MenuModel',
          commands: [
            {command: 'LOAD"*",8', output: ['', 'SEARCHING FOR *', 'LOADING'], ready: true},
            {command: 'RUN'}
          ]
        });
        break;
      case 'MainModel':
        this.model = new MainModel(this);
        break;
      case 'MenuModel':
        this.model = new MenuModel(this);
        break;
      case 'GameModel':
        this.model = new GameModel(this, options);
        break;
      case 'AboutModel':
        this.model = new AboutModel(this);
        break;
    } // switch
    this.model.init();
    if (needResizeApp) {
      this.resizeApp();
    }
  } // setModel

} // MainApp
