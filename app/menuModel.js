const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { C64TextModeEntity } = await import('./svision/js/platform/canvas2D/c64/c64TextModeEntity.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
const { DialogEntity } = await import('./svision/js/platform/canvas2D/dialogs/dialogEntity.js?ver='+window.srcVersion);
const { C64DialogProperties } = await import('./svision/js/platform/canvas2D/c64/c64DialogProperties.js?ver='+window.srcVersion);
const { C64VolumeEntity } = await import('./svision/js/platform/canvas2D/c64/c64VolumeEntity.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The menu, written in the machine's own character ROM so that it reads as
 * part of the machine and not as a web page.
 *
 * ★ **It is where the boot lands and where the pause panel comes back to**
 * (`app/mainApp.js`): START GAME shows the title screen of the original and
 * the game starts from there, so the menu itself is never on the screen
 * while the world is running. The original has no menu — this one is the
 * remake's, like the pause panel and the cross in the border.
 *
 * A ROOM OF THE FORTRESS is the same `GameModel` with the agent left
 * standing: the keys walk through the 32 rooms and shuffle another
 * fortress, which is what M2 and M3 were looked at with.
 */
export class MenuModel extends AbstractModel {

  constructor(app) {
    super(app);
    this.id = 'MenuModel';
    this.items = [
      {key: 'S', text: 'START GAME', model: 'MainModel'},
      {key: 'R', text: 'A ROOM OF THE FORTRESS', model: 'GameModel',
       options: {dev: true}},
      // ★ M6: jeden posuvník na jednu sběrnici `sid` — efekty i řeč jdou
      // přes týž registr, tak jako na stroji (R-024, `app/audioManager.js`)
      {key: 'V', text: 'SOUNDS', dialog: 'sounds'},
      {key: 'A', text: 'ABOUT THIS REMAKE', model: 'AboutModel'}
    ];
    /** where a dialog sits: the middle of the screen, in the machine's colours */
    this.dialogProperties = C64DialogProperties.merge({});
  } // constructor

  /**
   * The one dialog this menu has: the volume of the `sid` bus, with a
   * second of the lift to listen to (`AudioManager.audioData`).
   */
  openSounds() {
    var p = this.dialogProperties;
    this.desktopEntity.addModalEntity(new DialogEntity(this.desktopEntity,
      p.x, p.y, p.width, p.height, 'SOUNDS', p,
      (dialog) => new C64VolumeEntity(dialog, dialog.innerX, dialog.innerY,
        dialog.innerWidth, dialog.innerHeight, 'sid', 'audioBusSoundsLevel',
        'exampleSound', p)));
  } // openSounds

  newBorderEntity() {
    return new BorderEntity(false);
  } // newBorderEntity

  init() {
    super.init();
    this.screen = new C64TextModeEntity(this.desktopEntity, 0, 0,
      this.desktopWidth, this.desktopHeight, this.app.fonts.c64Fonts8x8);
    this.desktopEntity.addEntity(this.screen);
    var text = this.screen.textRAM;
    text.setBackground(6).showCursor(false);
    text.clear(14);
    this.desktopEntity.bkColor = C64Color.color(6);
    if (this.borderEntity != null) {
      this.borderEntity.bkColor = C64Color.color(14);
    }
    text.printAt(8, 3, 'IMPOSSIBLE MISSION', 1);
    text.printAt(8, 4, 'EPYX 1984  C64 REMAKE', 14);
    for (var i = 0; i < this.items.length; i++) {
      text.printAt(6, 8+i*2, this.items[i].key+'  '+this.items[i].text, 13);
    }
    // ★ **R-024: pod menu nezůstane otevřená žádná sběrnice.** Není to jen
    // ticho — `closeAllAudioBuses` handler **zruší** (a s posledním z nich
    // i `AudioContext`), takže se s ním zahodí i model čipu. Bez toho by si
    // SID nesl registry z rozehrané hry do další a první zvuk by zazněl
    // tím, co v něm zbylo. Menu je jediné místo, kde se zavírá; hra a
    // titulka jen zastavují (`stopAllAudioBuses`), aby se daly pustit dál.
    // ★ Pozor: otevřít sběrnici znovu **stojí nahrání workletu**, a tou
    // dobou už worker posílá snímky — proto nárazník `AudioChipHandler`
    // nesmí zahodit blok vzorků, jinak by úvodní věta zmizela.
    this.sendEvent(0, {id: 'closeAllAudioBuses'});
    text.printAt(6, 19, 'ARROWS AND SPACE ARE THE JOYSTICK.', 12);
    text.printAt(6, 20, 'ESC OR THE CROSS PAUSES THE GAME.', 12);
  } // init

  /**
   * A letter picks an item; a click or a tap takes the first one.
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
    var key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
    if (key === 'Mouse1' || key === 'Touch') {
      this.app.setModel(this.items[0].model, this.items[0].options);
      return true;
    }
    for (var i = 0; i < this.items.length; i++) {
      if (key !== this.items[i].key) {
        continue;
      }
      if (this.items[i].dialog === 'sounds') {
        this.openSounds();
      } else {
        this.app.setModel(this.items[i].model, this.items[i].options);
      }
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

} // MenuModel
