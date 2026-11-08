const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { ButtonEntity } = await import('./svision/js/platform/canvas2D/buttonEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
// begin code

/**
 * The border of the television around the 320x200 picture: the cross that
 * opens the pause panel and the developer-mode banner. Its colour is
 * `$D020`, which the models set — ★ and `$D020` is **not** `$D021`: the
 * game keeps the border black the whole game (`$3967`) while the background
 * changes from room to room, so the two are set apart
 * (`sources/docs/disasm_notes.md` §12, `CLAUDE.md`).
 *
 * The shape is the sibling remakes' (`manicminer/app/borderEntity.js`,
 * `boulderdash/app/borderEntity.js`) without the tape stripes and without
 * the touch halves: a C64 boots from disk in silence, and the agent is
 * driven by one joystick byte the model makes itself.
 *
 * ★ The cross is not a model of its own and knows nothing about pausing:
 * it sends `{id: 'keyPress', key: 'Escape'}`, exactly what the keyboard
 * sends, so the model has **one** way in and the touchscreen has the key a
 * keyboard has not got.
 */
export class BorderEntity extends AbstractEntity {

  /**
   * @param {boolean} enableExit - Whether the cross is in the border.
   */
  constructor(enableExit) {
    super(null, 0, 0, 0, 0, false, false);
    this.id = 'BorderEntity';

    this.enableExit = enableExit;
    this.escapeEntity = null;
    this.escapeScale = 2;
    this.devModeNameEntity = null;
  } // constructor

  init() {
    super.init();

    if (this.enableExit) {
      if (this.app.layout.ratio > 2) {
        this.escapeScale = 1;
      }
      this.escapeEntity = new ButtonEntity(this, this.app.fonts.c64Fonts8x8,
        0, 0, this.escapeScale*8, this.escapeScale*8, 'X',
        {id: 'keyPress', key: 'Escape'}, [], false, false,
        {scale: this.escapeScale, clickColor: '#7a7a7aff'});
      this.addEntity(this.escapeEntity);
    }

    // ★ **Počitadlo snímků patří do rámečku, ne do obrazu.** Sourozenci ho
    // kreslí na plochu (`boulderdash/app/gameModel.js`), jenže tady je
    // plocha **pixel po pixelu shodná se strojem** a operátor ji srovnává
    // s originálem (`matchscreen`, `renderroom`). Text přes ni by to
    // znemožnil, a v rámečku je stejně dobře vidět.
    if (typeof this.app.devModeName === 'string') {
      this.fpsEntity = new TextEntity(this, this.app.fonts.fonts5x5, 0, 0, 80, 7,
                                      '', C64Color.color(7), false, {margin: 1});
      this.addEntity(this.fpsEntity);
    }

    // ★ `devModeName` je **řetězec, nebo nic**: tenhle projekt ho na rozdíl
    // od sourozenců nemusí dostat (`app/main.js` ho předává, jen když ho
    // `window` má), a `undefined !== false` je pravda — na to se dá naletět
    if (typeof this.app.devModeName === 'string') {
      this.devModeNameEntity = new TextEntity(this, this.app.fonts.fonts5x5, 0, -7, 100, 7, '', false, false, {margin: 1});
      var cfgLen = this.app.devModeName.indexOf('}');
      this.devModeNameEntity.setText(this.app.devModeName.substring(cfgLen+1));
      var cfg = null;
      try {
        cfg = JSON.parse(this.app.devModeName.substring(1, cfgLen+1));
        Object.keys(cfg).forEach((item) => {
          this.devModeNameEntity[item] = cfg[item];
        });
      } catch (error) {
        console.error(error.message);
      }
      if (!cfg || !('width' in cfg)) {
        this.devModeNameEntity.width = this.devModeNameEntity.lineWidth(this.devModeNameEntity.text)+2;
      }
      this.addEntity(this.devModeNameEntity);
    }
  } // init

  drawEntity() {
    super.drawEntity();
    if (this.escapeEntity) {
      // ★ The cross has to be legible on whatever `$D020` is: white on a
      // dark border, black on a light one. The game's own border is black
      // (`$3967`), the menu's is light grey — both happen, and the colour
      // is read off the border itself rather than told to it, because every
      // model sets `bkColor` already and none of them knows about crosses.
      var penColor = C64Color.color(this.lightBorder() ? 0 : 1);
      if (this.escapeEntity.penColor !== penColor) {
        this.escapeEntity.setPenColor(penColor);
      }
    }
    this.drawSubEntities();
  } // drawEntity

  /**
   * What the dev-mode indicator says: how many frames a second the model
   * **draws**, and how many `frame` messages a second come from the worker.
   * ★ Bez toho se nepozná, jestli obraz drží krok se světem, nebo jestli se
   * překresluje nadarmo (R-037).
   * @param {string} text - For instance `60/50 FPS`.
   */
  setFps(text) {
    // `setText` si sám pozná, že se nic nezměnilo, a cache nezahodí
    if (this.fpsEntity) { this.fpsEntity.setText(text); }
  } // setFps

  /**
   * Whether `$D020` is one of the light sixteen, out of the hex the
   * library paints the border with.
   * @returns {boolean} True when black is the legible pen on it.
   */
  lightBorder() {
    var hex = typeof this.bkColor === 'string' ? this.bkColor.replace('#', '') : '';
    if (hex.length < 6) { return false; }
    var r = parseInt(hex.substring(0, 2), 16),
        g = parseInt(hex.substring(2, 4), 16),
        b = parseInt(hex.substring(4, 6), 16);
    return (0.299*r + 0.587*g + 0.114*b) >= 128;
  } // lightBorder

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'resizeModel':
        if (this.escapeEntity) {
          // in the bottom border when there is one, otherwise just outside
          // the picture's top right corner
          if (this.model.borderHeight < this.escapeScale*8) {
            this.escapeEntity.x = this.model.borderWidth+this.model.desktopEntity.width;
            this.escapeEntity.y = this.model.borderHeight;
          } else {
            this.escapeEntity.x = this.model.borderWidth+this.model.desktopEntity.width-this.escapeScale*8;
            this.escapeEntity.y = this.model.borderHeight-this.escapeScale*8;
          }
        }
        if (this.fpsEntity) {
          // vlevo dole v rámečku, pod obrazem; když dole místo není, nahoře
          this.fpsEntity.x = 1;
          this.fpsEntity.y = this.model.borderHeight >= 7
            ? this.height-this.model.borderHeight : 0;
        }
        if (this.devModeNameEntity) {
          this.devModeNameEntity.x = Math.floor((this.width-this.devModeNameEntity.width)/2);
          this.devModeNameEntity.y = Math.max(Math.floor((this.app.model.borderHeight-this.devModeNameEntity.height)/2), 0);
        }
        break;
    }
    return false;
  } // handleEvent

} // BorderEntity
