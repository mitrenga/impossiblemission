// begin code

/**
 * A screen of the original, as `tools/mkscreen.py` took it out of the
 * machine's memory, put into the library's model of the machine. Nothing
 * here is drawn or made up: the screen codes, the colour RAM, the character
 * set and the colour registers all come from the original.
 *
 * ## Deliberately free of DOM
 *
 * The loader takes the parsed JSON, not a URL, so a tool under Node can build
 * the same screen the browser builds (R-001). Fetching is the caller's job.
 */
export class ScreenLoader {

  /**
   * @param {Object} data - The parsed `data/*.json` of `tools/mkscreen.py`.
   */
  constructor(data) {
    this.id = 'ScreenLoader';
    this.data = data;
  } // constructor

  /** @returns {Uint8Array} The 1000 screen codes. */
  screen() {
    return Uint8Array.from(this.data.screen);
  } // screen

  /** @returns {Uint8Array} The 1000 colour nibbles. */
  colorRAM() {
    return Uint8Array.from(this.data.colorRAM);
  } // colorRAM

  /** @returns {Uint8Array} The 2 KB character set the VIC-II reads. */
  charsetBytes() {
    return Uint8Array.from(this.data.charset);
  } // charsetBytes

  /**
   * Puts the registers of the original into a text RAM: $D021 and the two
   * shared colours, and multicolour mode.
   * @param {Object} textRAM - A {@link C64TextRAM}.
   * @returns {Object} The same text RAM.
   */
  applyTo(textRAM) {
    var colors = this.data.colors;
    textRAM.setBackground(colors.background0);
    textRAM.setSharedColors(colors.background1, colors.background2);
    textRAM.setMulticolor(!!this.data.multicolor);
    textRAM.showCursor(false);
    return textRAM;
  } // applyTo

  /** @returns {number} $D020 of the original. */
  border() {
    return this.data.colors.border;
  } // border

} // ScreenLoader
