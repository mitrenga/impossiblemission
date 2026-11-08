const { AbstractEntity } = await import('./svision/js/abstractEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { MenuEntity } = await import('./svision/js/platform/canvas2D/menuEntity.js?ver='+window.srcVersion);
const { C64Color } = await import('./svision/js/platform/canvas2D/c64/c64Color.js?ver='+window.srcVersion);
// begin code

/**
 * The pause panel, the shape the sibling remakes have
 * (`manicminer/app/pauseGameEntity.js`, `boulderdash/app/pauseGameEntity.js`)
 * in the colours of this machine.
 *
 * ★ **The original has no pause at all**: Impossible Mission runs its clock
 * from twelve to six and the only way out of the game is to run out of time
 * (`ZADANI.md` §10). RESUME / EXIT under a panel, Escape opening it and the
 * cross in the border are the remake's — a browser tab that loses focus has
 * to stop somewhere, and a touchscreen has no Escape key.
 *
 * ★ It is a **modal entity**, so while it is up the model gets no events
 * and the world does not move; whoever opens it stops the worker as well,
 * because the worker's clock is its own (`GameModel.pauseGame`).
 */
export class PauseGameEntity extends AbstractEntity {

  /**
   * @param {AbstractEntity} parentEntity - The desktop.
   * @param {number} x - Where it sits, in the picture's pixels.
   * @param {number} y - Where it sits.
   * @param {number} width - How wide.
   * @param {number} height - How tall.
   * @param {string} title - What is written over it.
   * @param {string} exitModel - Which model EXIT goes to.
   */
  constructor(parentEntity, x, y, width, height, title, exitModel) {
    super(parentEntity, x, y, width, height, false, false);
    this.id = 'PauseGameEntity';

    this.title = title;
    this.exitModel = exitModel;
    this.menuItems = [
      {t1: 'RESUME', event: {id: 'closePauseGame'}},
      {t1: 'EXIT TO MENU', event: {id: 'exitGame'}}
    ];
    this.menuOptions = {
      fonts: this.app.fonts.c64Fonts8x8,
      leftMargin: 9,
      rightMargin: 9,
      topMargin: 8,
      itemHeight: 12,
      t1LeftMargin: 3,
      t1TopMargin: 2,
      t2Width: 40,
      t2RightMargin: 3,
      t2TopMargin: 2,
      textColor: C64Color.color(0),
      selectionTextColor: C64Color.color(0),
      selectionBarColor: C64Color.color(1),
      hoverColor: '#0000001e',
      selectionHoverColor: C64Color.color(1),
      clickColor: '#0000002e',
      selectionClickColor: '#ffffffff'
    };
  } // constructor

  init() {
    super.init();
    this.addEntity(new AbstractEntity(this, 0, 0, this.width, this.height, false, C64Color.color(15)));
    this.addEntity(new TextEntity(this, this.app.fonts.fonts5x5, 0, 0, this.width, 9, this.title, C64Color.color(0), false, {align: 'center', margin: 2}));
    this.addEntity(new MenuEntity(this, 1, 8, this.width-2, this.height-9, C64Color.color(14), this.menuOptions, this, this.getMenuData));
  } // init

  /**
   * What the menu asks about its rows.
   * @param {PauseGameEntity} self - The panel.
   * @param {string} key - What is asked.
   * @param {number} row - Which row.
   * @returns {*} The answer.
   */
  getMenuData(self, key, row) {
    switch (key) {
      case 'numberOfItems':
        return self.menuItems.length;
      default:
        if (key in self.menuItems[row]) {
          return self.menuItems[row][key];
        }
        break;
    }
    return '';
  } // getMenuData

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }
    switch (event.id) {
      case 'keyPress':
        switch (event.key) {
          case 'Escape':
            // ★ Escape opened it, so Escape closes it: the cross in the
            // border sends the same key, and a touchscreen has no other way
            this.sendEvent(-1, 1, {id: 'continueGame'});
            this.destroy();
            return true;
        }
        break;
      case 'closePauseGame':
        this.sendEvent(-1, 1, {id: 'continueGame'});
        this.destroy();
        return true;
      case 'exitGame':
        this.app.setModel(this.exitModel);
        return true;
    }
    return false;
  } // handleEvent

} // PauseGameEntity
