// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The shaft's screen, built the way the original builds it (`$AF3F`,
 * `sources/docs/disasm_notes.md` §22).
 *
 * ★ **The shaft is not a picture either.** Walking out of a room does not
 * restore a saved screen — the game draws the whole thing again, and the
 * biggest part of it is drawn by **the lift**: `$72CE` runs seventeen steps
 * of `$744B` + `$7631` + `$73CA`, the same three routines a ride down uses
 * (§20), so the walls and the doorways of the shaft come out of the same
 * shuffle as a ride does. That is why this file is so short: the work is in
 * `app/elevator.js` already.
 *
 * What is left is four pieces of drawing:
 *
 * | routine | what it puts on the screen |
 * |---|---|
 * | `$72A2` | the **shaft itself**, 15 rows of 6 characters from `$0D00`/`$0D5A`, and then the seventeen lift steps that fill the walls either side |
 * | `$72E5` | the **panel** below it, 400 characters and 400 colours from `$3313`/`$34A3` |
 * | `$7218` | the window in the panel, wiped to blanks |
 * | `$B68F` | the **map of the fortress** into that window, out of `$FF30` — the trail the cabin has left (§20) |
 *
 * ★ And then `$AFA7` **moves the whole thing to `$C100`** and blanks
 * `$4000`, because what actually puts it on the screen is the same curtain
 * that brings a room in (`$A2ED`, §21).
 */

/** where the agent is, the cabin in the fortress, and the sub-row of a step */
var SB_PLACE = 0x1A, SB_SUB = 0x1C, SB_AT_TOP = 0x1D, SB_AT_BOTTOM = 0x1E;
var SB_DOOR = 0x1F, SB_CAB_X = 0x27, SB_CAB_Y = 0x28;

/** the colours the cabin is drawn in, picked by which column of the fortress */
var SB_CAB_COLOUR = 0x21, SB_CAB_MULTI = 0x22;

/** the pair of pointers every one of these routines draws through */
var SB_DST = 0x10, SB_CDST = 0x14;

/** the screen, the copy the curtain uncovers from, and a blank */
var SB_SCREEN = 0x4000, SB_COPY = 0xC100, SB_BLANK = 0x53;

/** the static tables `data/shaft.json` carries (`tools/dumpshaft.py`) */
var SB_COLUMN = 0x0D00, SB_COLUMN_COLOUR = 0x0D5A;
var SB_PANEL = 0x3313, SB_PANEL_COLOUR = 0x34A3;
var SB_CAB_COLOURS = 0xB02B, SB_CAB_MULTIS = 0xB033;
/** ★ deset znaků stěny šachty pod oknem (`$73C0`, `$731C`) */
var SB_BOTTOM_WALL = 0x73C0;

/** the trail of the cabin on the map (§20) and the frame it is drawn in */
var SB_MARKS = 0xFF30, SB_MAP_ROWS = 6, SB_MAP_COLS = 0x13;

/**
 * How many steps of the lift fill the shaft when it is drawn (`$72CC`).
 * ★ `LDA #$10` a `SBC #$01`/`BCS` znamená `$10` **až včetně nuly**, tedy
 * **sedmnáct** průchodů, ne šestnáct — a o jeden navíc posune `$28`.
 */
var SB_FILL_STEPS = 0x10;

function sbByte(v) { return v & 0xFF; }
function sbLoad(m, a) { return rbLoad(m, a); }
function sbStore(m, a, v) { rbStore(m, a, v); }
function sbWord(m, a) { return sbLoad(m, a) | (sbLoad(m, a + 1) << 8); }
function sbSetWord(m, a, v) {
  sbStore(m, a, v & 0xFF); sbStore(m, a + 1, (v >> 8) & 0xFF);
}

/**
 * `$AF2F` / `$AF17` — the pointer pair walks one row down or one row up.
 * ★ Both pointers get the **same low byte** and only the high bytes carry
 * separately, which is why the screen and the colour stay in step.
 * @param {Object} m - The machine.
 * @param {number} delta - `$28` down a row, `-$28` up one.
 */
function sbNextRow(m, delta) {
  var lo = sbLoad(m, SB_DST) + delta;
  sbStore(m, SB_DST, lo); sbStore(m, SB_CDST, lo);
  if (lo > 0xFF) {
    sbStore(m, SB_DST + 1, sbByte(sbLoad(m, SB_DST + 1) + 1));
    sbStore(m, SB_CDST + 1, sbByte(sbLoad(m, SB_CDST + 1) + 1));
  } else if (lo < 0) {
    sbStore(m, SB_DST + 1, sbByte(sbLoad(m, SB_DST + 1) - 1));
    sbStore(m, SB_CDST + 1, sbByte(sbLoad(m, SB_CDST + 1) - 1));
  }
} // sbNextRow

/**
 * `$72A2` — the shaft proper: fifteen rows of six characters laid from the
 * bottom up, and then **seventeen steps of the lift** to fill the walls and
 * whatever doorways the fortress has either side of it.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function sbColumn(m, entropy) {
  var x, y, i;
  sbSetWord(m, SB_DST, 0x4241);                          // řádek 14, sloupec 17
  sbSetWord(m, SB_CDST, 0xDA41);
  for (x = 0x59; x >= 0;) {
    for (y = 5; y >= 0; y--, x--) {
      sbStore(m, sbWord(m, SB_DST) + y, sbLoad(m, SB_COLUMN + x));
      sbStore(m, sbWord(m, SB_CDST) + y, sbLoad(m, SB_COLUMN_COLOUR + x));
    }
    sbNextRow(m, -0x28);                                 // `$AF17`
  }
  // ★ `$72CC` — sedmnáct kroků výtahu dolů; zdi a dveře šachty tedy kreslí
  // tentýž kód jako jízda (§20), jen se u toho nečeká na snímky
  sbStore(m, SB_AT_BOTTOM, 0);
  for (i = SB_FILL_STEPS; i >= 0; i--) {
    elScrollUp(m);
    elNewRowDown(m, entropy);
    elAdvance(m);
  }
  if (sbLoad(m, SB_AT_TOP)) { sbCeiling(m); }            // `$72E2` → `$7857`
} // sbColumn

/**
 * `$7857` — the ceiling gets drawn and `$1D` goes up. ★ `INC $1D` is part of
 * this routine, so the `$72DE` path, which only calls it when `$1D` is
 * already set, leaves it at **2**; nothing tests it for anything but zero.
 * @param {Object} m - The machine.
 */
function sbCeiling(m) {
  for (var i = 7; i >= 0; i--) {
    sbStore(m, 0x4010 + i, sbLoad(m, 0x0DC0 + i));
  }
  sbStore(m, 0xD813, 0x0F); sbStore(m, 0xD814, 0x0F);
  sbStore(m, SB_AT_TOP, sbByte(sbLoad(m, SB_AT_TOP) + 1));
} // sbCeiling

/**
 * `$7850` — is there any shaft left above the cabin? ★ `$AF9E` calls this on
 * its own, right after the shaft is drawn, and it is the **last** thing to
 * ask the picture of the fortress — which is how it shows in `$18`/`$19`.
 * @param {Object} m - The machine.
 */
function sbTopCheck(m) {
  var a = sbLoad(m, SB_CAB_Y) - 0xBB;                    // `$786D`
  if (elPictureByte(m, sbByte(a), a >= 0 ? 1 : 0, 0) !== 0xFF) { return; }
  sbCeiling(m);
} // sbTopCheck

/**
 * `$731C` — ★ **the shaft goes on below the window**, and that is what is on
 * screen while the opening words are spoken.
 *
 * Dlouho tu stálo, že `$731C` je spodní panel; není. Panel kreslí `$72E5`
 * na `$3A08`, tedy **až za řečí** — `$731C` na `$39F1` zaplní řádky 15-24
 * **zdí z míchačky** (dvacet dvojic na řádek, pět řádků, a dalších pět
 * řádků je ten nad ním s jedničkou navíc, což je ta cihlová vazba) a pod
 * oknem dotáhne **sloupec šachty** (deset řádků znaku `$28` a k nim stěny
 * z `$73C0`). Teprve pak rozsvítí obraz (`$D011` = `$1B`). Změřeno na
 * originálu zastávkou na `$39F4` (nahlásil operátor 2026-09-21).
 *
 * ★ Je to **sto tahů z míchačky**, takže to není jen obrázek: kdo to
 * vynechá, má od začátku hry jiný stav `$EB`/`$EC` než originál.
 *
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function sbBottom(m, entropy) {
  var x, y, a, at;
  sbSetWord(m, SB_DST, 0x4258);                          // `$731C`
  sbSetWord(m, SB_CDST, 0xDA58);
  sbStore(m, 0xD021, 0x0C);                              // `$732A`
  sbStore(m, 0xD022, sbLoad(m, SB_CAB_COLOUR));
  sbStore(m, 0xD023, sbLoad(m, SB_CAB_MULTI));
  for (x = 4; x >= 0; x--) {                             // `$733B`
    for (y = 0x4F; y >= 0; y--) { sbStore(m, sbWord(m, SB_CDST) + y, 0x01); }
    // ★ `$7346` sahá do míchačky **jednou** na dvojici, ne dvakrát jako
    // zeď mezi dveřmi (`$76E9`) — a druhý znak je ten první plus dva
    for (y = 0x26; y >= 0; y -= 2) {
      a = fgRandom(m.mem, entropy()) & 0x1C;
      sbStore(m, sbWord(m, SB_DST) + y, a);
      sbStore(m, sbWord(m, SB_DST) + y + 1, sbByte(a + 2));
    }
    sbNextRow(m, 0x50);                                  // `$AF37`, dva řádky
  }
  sbNextRow(m, -0xF0);                                   // `$735E` → `$AEEB`
  sbNextRow(m, -0xA0);                                   // `$7361` → `$AF0F`
  for (x = 4; x >= 0; x--) {                             // `$7366`
    at = sbWord(m, SB_DST);
    for (y = 0x27; y >= 0; y--) {
      sbStore(m, at + 0x28 + y, sbByte(sbLoad(m, at + y) + 1));
    }
    sbNextRow(m, 0x50);
  }
  // ★ `$7385`: na dně šachty se sloupec nedokresluje — a **obraz se pak
  // nerozsvítí**, protože `$73BA` leží až za touhle větví
  if (sbLoad(m, SB_AT_BOTTOM)) { return; }
  sbSetWord(m, SB_DST, 0x4268);                          // `$7389`
  sbSetWord(m, SB_CDST, 0xDA68);
  for (x = 9; x >= 0; x--) {                             // `$7399`
    at = sbWord(m, SB_DST);
    for (y = 7; y >= 0; y--) {
      sbStore(m, at + y, 0x28);
      sbStore(m, sbWord(m, SB_CDST) + y, 0x08);
    }
    a = sbLoad(m, SB_BOTTOM_WALL + x);                   // `$73A6`
    sbStore(m, at, a); sbStore(m, at + 7, a);
    sbNextRow(m, 0x28);                                  // `$AF2F`
  }
  sbStore(m, 0xD011, 0x1B);                              // `$73BA`, a svítí
} // sbBottom

/**
 * `$72E5` — the panel under the shaft: four hundred characters and four
 * hundred colours, straight out of the program's own data.
 * @param {Object} m - The machine.
 */
function sbPanel(m) {
  var y;
  sbSetWord(m, SB_DST, 0x4258);
  sbSetWord(m, SB_CDST, 0xDA58);
  for (y = 0; y < 0x100; y++) {
    sbStore(m, 0x4258 + y, sbLoad(m, SB_PANEL + y));
    sbStore(m, 0xDA58 + y, sbLoad(m, SB_PANEL_COLOUR + y));
  }
  sbStore(m, SB_DST + 1, sbByte(sbLoad(m, SB_DST + 1) + 1));
  sbStore(m, SB_CDST + 1, sbByte(sbLoad(m, SB_CDST + 1) + 1));
  for (y = 0x8F; y >= 0; y--) {
    sbStore(m, 0x4358 + y, sbLoad(m, SB_PANEL + 0x100 + y));
    sbStore(m, 0xDB58 + y, sbLoad(m, SB_PANEL_COLOUR + 0x100 + y));
  }
  sbStore(m, 0x8F, 0xFF); sbStore(m, 0x91, 0xFF);
} // sbPanel

/**
 * `$7218` — the window the map goes in, wiped to blanks: eight rows of
 * twenty-two from `$4286`.
 * @param {Object} m - The machine.
 */
function sbClearMap(m) {
  var x, y;
  sbSetWord(m, SB_DST, 0x4286);
  for (x = 7; x >= 0; x--) {
    for (y = 0x15; y >= 0; y--) { sbStore(m, sbWord(m, SB_DST) + y, SB_BLANK); }
    sbNextRow(m, 0x28);                                  // `$AF2F`
  }
  sbStore(m, 0x91, 0xFF);
} // sbClearMap

/**
 * `$B68F` — the map of the fortress, with its frame, and in it **the trail
 * the cabin has left**: `$FF30` holds one character a square, written by
 * `$B757` every time the lift passes one (§20), so the map fills in as the
 * agent explores.
 * @param {Object} m - The machine.
 */
function sbMap(m) {
  var x = 0, y, row;
  sbSetWord(m, SB_DST, 0x4287);
  sbSetWord(m, SB_CDST, 0xDA87);
  for (y = 0x14; y >= 0; y--) {                          // horní lišta rámu
    sbStore(m, sbWord(m, SB_DST) + y, 0xF4);
    sbStore(m, sbWord(m, SB_CDST) + y, 0x07);
  }
  sbStore(m, sbWord(m, SB_DST), 0xF0);                   // rohy
  sbStore(m, sbWord(m, SB_DST) + 0x14, 0xF1);
  sbNextRow(m, 0x28);

  // ★ počitadlo řádků mapy si originál vede v `$E4` a nechá ho na `$FF`
  sbStore(m, 0xE4, SB_MAP_ROWS - 1);
  for (row = SB_MAP_ROWS - 1; row >= 0; row--, sbStore(m, 0xE4, sbByte(row))) {
    var at = sbWord(m, SB_DST), cat = sbWord(m, SB_CDST);
    sbStore(m, at, 0xF5); sbStore(m, cat, 0x07);         // levý sloupek
    sbStore(m, at + 1, 0xFC); sbStore(m, cat + 1, 0x05);
    for (y = 2; y < SB_MAP_COLS; y++, x++) {
      sbStore(m, at + y, sbLoad(m, (SB_MARKS + x) & 0xFFFF));
      sbStore(m, cat + y, 0x05);
    }
    sbStore(m, at + SB_MAP_COLS, 0xFC);
    sbStore(m, cat + SB_MAP_COLS, 0x05);
    sbStore(m, at + SB_MAP_COLS + 1, 0xF5);              // pravý sloupek
    sbStore(m, cat + SB_MAP_COLS + 1, 0x07);
    sbNextRow(m, 0x28);
  }

  for (y = 0x14; y >= 0; y--) {                          // spodní lišta rámu
    sbStore(m, sbWord(m, SB_DST) + y, 0xF4);
    sbStore(m, sbWord(m, SB_CDST) + y, 0x07);
  }
  sbStore(m, sbWord(m, SB_DST), 0xF2);
  sbStore(m, sbWord(m, SB_DST) + 0x14, 0xF3);
  // ★ **A za mapou se staví blok značky kabiny** (`$B712`-`$B724`): 64
  // vynulovaných bajtů a `$C0` do **tří** z nich — `$4D80`, `$4D83`
  // a `$4D86`, tedy dva body ve třech řádcích za sebou. ★ Tohle je konec
  // `$B6FE`, ne `$B68F`, ale leží to v jednom pásu za sebou, takže se to
  // udělá pokaždé, když se mapa kreslí. Do 2026-09-21 tu byl **jen ten
  // první bajt**: po startu značku postavila `pocketComputer.mapMarker`
  // celou, ale při návratu z místnosti (`$AF3F` → `$B68F` → `$B746`, který
  // sází **jen ukazatel**) z ní zbyl jediný řádek a značka byla **nízká
  // a zploštělá** (nahlásil operátor 2026-09-21).
  for (y = 0x3F; y >= 0; y--) { sbStore(m, 0x4D80 + y, 0); }
  sbStore(m, 0x4D80, 0xC0);                              // `$B71E`
  sbStore(m, 0x4D83, 0xC0);                              // `$B721`
  sbStore(m, 0x4D86, 0xC0);                              // `$B724`
} // sbMap

/**
 * `$AF3F` — the whole shaft screen, from the sprites to the map, and then
 * ★ **moved to `$C100`** so the curtain of `$A2ED` can uncover it (§21).
 *
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function sbBuildHead(m) {
  sbStore(m, 0xD000, 0xCA);                              // kabina
  sbStore(m, 0xD003, 0x6A); sbStore(m, 0x2D, 0x6A);      // agent, tři sprajty
  sbStore(m, 0xD005, 0x5E); sbStore(m, 0x2F, 0x5E);
  sbStore(m, 0xD007, 0x73); sbStore(m, 0x31, 0x73);
  sbStore(m, 0x8E, 0xCF);                                // co se v šachtě svítí
  sbStore(m, 0x8D, 0x0C);
  var col = sbByte(sbLoad(m, SB_CAB_X) - 0x6B) >> 4;
  sbStore(m, SB_CAB_COLOUR, sbLoad(m, SB_CAB_COLOURS + col));
  sbStore(m, SB_CAB_MULTI, sbLoad(m, SB_CAB_MULTIS + col));
} // sbBuildHead

/**
 * `$AF78` to the end — the rest of `$AF3F`, which the original reaches a
 * frame later because `$AF75` waits for one.
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function sbBuildShaft(m, entropy) {
  var i;
  sbStore(m, 0xD011, sbLoad(m, 0xD011) & 0xEF);          // obraz na chvíli zhasne
  sbStore(m, 0xD018, (sbLoad(m, 0xD018) & 0xF0) | 0x02); // sada šachty (§6)
  sbStore(m, SB_DOOR, 0xFF); sbStore(m, SB_DOOR + 1, 0xFF);
  sbStore(m, SB_CAB_Y, sbByte(sbLoad(m, SB_CAB_Y) - 2));
  sbStore(m, SB_SUB, 0);

  sbColumn(m, entropy);
  sbTopCheck(m);                                         // `$AF9E` → `$7850`
  sbPanel(m);
  sbClearMap(m);
  sbMap(m);

  // `$AFA7` — hotová šachta se odloží na `$C100` a obrazovka se vyprázdní
  for (i = 0; i < 0x400; i++) {
    sbStore(m, SB_COPY + i, sbLoad(m, SB_SCREEN + i));
    sbStore(m, SB_SCREEN + i, SB_BLANK);
  }
  sbStore(m, 0x43FE, 0x36);                              // `$B746`
  sbSprites(m);                                          // `$AFE5`
  sbStore(m, 0xD011, sbLoad(m, 0xD011) | 0x10);          // a obraz se rozsvítí
} // sbBuildShaft

/**
 * `$AFE5` — the sprites the shaft has that a room does not: the cabin
 * (sprite 0, stretched) and the marker of the pocket computer (sprite 7).
 * @param {Object} m - The machine.
 */
function sbSprites(m) {
  sbStore(m, 0xD00E, 0xAC); sbStore(m, 0xD00F, 0x4D);
  sbStore(m, 0x43FF, 0x11);
  sbStore(m, 0xD010, sbLoad(m, 0xD010) & 0x7E);
  sbStore(m, 0xD02E, 0x01);
  sbStore(m, 0xD027, sbLoad(m, SB_CAB_COLOUR));
  sbStore(m, 0xD025, sbLoad(m, SB_CAB_MULTI));
  sbStore(m, 0xD000, 0xA0); sbStore(m, 0xD001, 0x5E);
  sbStore(m, 0xD01D, 0);
  sbStore(m, 0xD017, 0x01);                              // kabina je natažená
  sbStore(m, 0xD01C, 0x01);                              // a multicolor (§13)
  sbStore(m, 0x43F8, 0x12);
} // sbSprites

/**
 * The tables the shaft screen needs, put where the original has them.
 * @param {Uint8Array} mem - The machine's memory.
 * @param {Object} shaft - The parsed `data/shaft.json`.
 */
function sbSeedMemory(mem, shaft) {
  elSeedMemory(mem, shaft);
} // sbSeedMemory

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var shaftBuild = {
  head: sbBuildHead, build: sbBuildShaft, column: sbColumn, topCheck: sbTopCheck,
  // ★ `$731C`: šachta pod oknem, kterou vidí hráč po celou úvodní řeč
  bottom: sbBottom,
  // ★ `$7857` samotné, bez otázky `$7850`: **start hry ho volá natvrdo**
  // (`$3998`), protože na začátku kabina pod stropem pevnosti opravdu je
  ceiling: sbCeiling, panel: sbPanel, map: sbMap,
  clearMap: sbClearMap, sprites: sbSprites, seedMemory: sbSeedMemory,
  FILL_STEPS: SB_FILL_STEPS
};
if (typeof self !== 'undefined') {
  self.shaftBuild = shaftBuild;
  self.sbBuildShaft = sbBuildShaft;
  self.sbBuildHead = sbBuildHead;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = shaftBuild; }
