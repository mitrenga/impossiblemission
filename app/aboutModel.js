const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { C64TextModeEntity } = await import('./svision/js/platform/canvas2D/c64/c64TextModeEntity.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
const { Version } = await import('./version.js?ver='+window.srcVersion);
// begin code

/**
 * What the project is and how far it has got. Esc goes back to the menu.
 */
export class AboutModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'AboutModel';
  } // constructor

  init() {
    super.init();
    this.screen = new C64TextModeEntity(this.desktopEntity, 0, 0,
      this.desktopWidth, this.desktopHeight, this.app.fonts.c64Fonts8x8);
    this.desktopEntity.addEntity(this.screen);
    var text = this.screen.textRAM;
    text.setBackground(0).showCursor(false);
    text.clear(15);
    this.desktopEntity.bkColor = C64Color.color(0);
    if (this.borderEntity != null) {
      this.borderEntity.bkColor = C64Color.color(0);
    }
    var lines = [
      ['IMPOSSIBLE MISSION', 1],
      ['EPYX 1984, BY DENNIS CASWELL', 14],
      ['SPEECH BY ELECTRONIC SPEECH SYSTEMS', 14],
      ['', 15],
      ['A REMAKE ON THE SVISION LIBRARY.', 15],
      ['NOTHING IS REDRAWN: THE PICTURE IS', 15],
      ['BUILT BY THE ROUTINES OF THE ORIGINAL', 15],
      ['AND THE SPEECH IS ITS OWN SAMPLES.', 15],
      ['', 15],
      ['M0 - M6 ARE DONE: THE FORTRESS IS', 13],
      ['SHUFFLED, THE ROOMS ARE BUILT, THE', 13],
      ['AGENT, THE ROBOTS, THE LIFTS, THE', 13],
      ['SEARCHING, THE POCKET COMPUTER AND', 13],
      ['THE END OF THE GAME RUN ON THE CODE', 13],
      ['OF THE ORIGINAL, AND IT SPEAKS.', 13],
      ['EVERY MEASURE IS AT ZERO DIFFERENCES;', 13],
      ['A FULL-GAME REGRESSION IS PENDING.', 13],
      ['', 15],
      ['VERSION '+Version, 12],
      ['ESC  BACK', 12]
    ];
    for (var i = 0; i < lines.length; i++) {
      text.printAt(1, 2+i, lines[i][0], lines[i][1]);
    }
  } // init

  /**
   * Anything goes back to the menu.
   * @param {Object} event - The library's event.
   * @returns {boolean} Whether it was taken.
   */
  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    if (event.id === 'keyPress') {
      this.app.setModel('MenuModel');
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

} // AboutModel
