const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { C64TextModeEntity } = await import('./svision/js/platform/canvas2D/c64/c64TextModeEntity.js?ver='+window.srcVersion);
const { C64Charset } = await import('./svision/js/platform/canvas2D/c64/c64Charset.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
const { C64TextRAM } = await import('./svision/js/platform/canvas2D/c64/c64TextRAM.js?ver='+window.srcVersion);
const { ScreenLoader } = await import('./screenLoader.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { PauseGameEntity } = await import('./pauseGameEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The original's title screen, built out of the memory of the running
 * machine: the screen codes, the colour RAM and the character set come from
 * `data/title.json` (`tools/mkscreen.py`), the mode and the colours from the
 * loader's own code (`sources/docs/disasm_notes.md` §4) — multicolour
 * character mode, VIC bank 3, screen at $C400, character set at $C800.
 *
 * ★ It is proved: `tools/matchscreen.mjs` paints this screen with the library
 * and compares it with a screenshot of VICE pixel by pixel — 64 000 checks,
 * 0 differences.
 *
 * The data arrives the way every other screen in the library does, through
 * `fetchData('title.data')` and `setData()`, so the browser can keep it in
 * local storage; until it comes, the machine shows what it shows after RUN.
 *
 * ★ **It is the screen in front of the game**, as the siblings have it
 * (`manicminer`, `boulderdash/app/mainModel.js`): the menu's START GAME
 * opens it, the trigger — fire, Enter, the space bar, a click or a tap —
 * starts the game, and a game that has ended comes back here. Escape (or
 * the cross in the border) opens the pause panel, whose EXIT is the way
 * back to the menu; that is the remake's, the original has no menu at all.
 */
export class MainModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'MainModel';
    this.screen = null;
    this.loaded = false;
  } // constructor

  newBorderEntity() {
    return new BorderEntity(true);
  } // newBorderEntity

  init() {
    super.init();
    this.screen = new C64TextModeEntity(this.desktopEntity, 0, 0,
      this.desktopWidth, this.desktopHeight, this.app.fonts.c64Fonts8x8);
    this.desktopEntity.addEntity(this.screen);
    this.screen.textRAM.showCursor(false);
    // ★ Titulka **mlčí** — na originálu se při ní do SID nezapíše ani
    // jednou (§10.16), takže se zvuk zastaví. Zastaví, **ne zavře**: hráč
    // z ní jde do hry a sběrnice se má dát pustit dál bez nahrávání
    // workletu znovu. Zavírá až menu (R-024).
    this.sendEvent(0, {id: 'stopAllAudioBuses'});
    this.fetchData('title.data', {key: 'title', when: 'required'}, {});
  } // init

  /**
   * Puts the original's screen into the machine when it arrives.
   * @param {Object} data - `{url, source, data}`; the screen is `data.data`.
   */
  setData(data) {
    if (data && data.data && data.data.screen) {
      this.showScreen(data.data);
    }
    super.setData(data);
  } // setData

  /**
   * @param {Object} raw - The parsed `data/title.json`.
   */
  showScreen(raw) {
    var loader = new ScreenLoader(raw);
    var textRAM = new C64TextRAM(loader.screen(), loader.colorRAM());
    loader.applyTo(textRAM);
    this.screen.textRAM = textRAM;
    this.screen.setFont(new C64Charset(loader.charsetBytes()));
    this.screen.paintedVersion = -1;
    this.desktopEntity.bkColor = C64Color.color(raw.colors.background0);
    if (this.borderEntity != null) {
      this.borderEntity.bkColor = C64Color.color(loader.border());
    }
    this.loaded = true;
  } // showScreen

  /** The pause panel, over the title: the one way back to the menu. */
  pauseGame() {
    this.desktopEntity.addModalEntity(new PauseGameEntity(this.desktopEntity,
      84, 72, 153, 44, 'IMPOSSIBLE MISSION', 'MenuModel'));
  } // pauseGame

  /**
   * The trigger starts the game, Escape opens the panel. The library hands
   * every input to `handleEvent` as an event with an `id` and a `key`;
   * `Mouse1` and `Touch` are key names like any other — ★ and a tap is the
   * trigger here, not an Escape, because a touchscreen starts the game the
   * way a joystick does and leaves it by the cross in the border.
   * @param {Object} event - The library's event.
   * @returns {boolean} Whether it was taken.
   */
  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    if (event.id !== 'keyPress') {
      return false;
    }
    if (event.key === 'Escape') {
      this.pauseGame();
      return true;
    }
    if (['Enter', ' ', 'Mouse1', 'Touch'].indexOf(event.key) >= 0) {
      this.app.setModel('GameModel');
      return true;
    }
    return false;
  } // handleEvent

  /**
   * ★ **R-037 i tady.** `AbstractModel.loopModel` **nekreslí** — obraz
   * překreslí jen `drawModel()`, a ten si knihovna sama zavolá pouze ze
   * `setData` a `resizeModel`. Bez téhle smyčky by se modální panel
   * (pauza, dialog) na obrazovce objevil až při změně velikosti okna.
   * Obraz je statický, takže překreslení nic nestojí: entity si nesou
   * `paintedVersion` a co se nezměnilo, se nepřekresluje.
   * @param {number} timestamp - What the animation loop was given.
   */
  loopModel(timestamp) {
    super.loopModel(timestamp);
    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    }
    this.drawModel();
  } // loopModel

} // MainModel
