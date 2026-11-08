// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The black orb (`$92C1`, `sources/docs/disasm_notes.md` §24).
 *
 * ★ **The orb is a program too, and a different one from the robots'.** It
 * has its own little machine: a script of **byte pairs** at `$2232`, a
 * program counter in `$6E`, one register in `$6F` and a wait counter in
 * `$70`. The first byte of a pair is the instruction, the second its
 * operand, and the instruction is picked out by **counting the byte down**
 * (`$92E2`, seven `DEY`/`BMI` in a row), not by a table:
 *
 * | byte | what it does |
 * |---|---|
 * | 0 | wait — `$70` = operand, and the frame is over |
 * | 1 | **move** by two signed nibbles, x in the top and y in the bottom |
 * | 2 | **home in on the agent** at the operand's speed |
 * | 3 | jump — `$6E` = operand |
 * | 4 | jump if the register is zero — `$6E` += operand |
 * | 5 | `$6F` = operand |
 * | 6 | `$6F` += operand |
 * | 7 and up | `$6F` -= operand |
 *
 * ★ Everything but *wait*, *move* and *home in* runs **without costing a
 * frame** — the script loops straight back to `$92D6` — so a single frame
 * can walk through as many jumps and counters as the script likes before it
 * finally moves the orb.
 *
 * ★ And the orb is **sprite 0**, the one the robots borrow for their bolts
 * (§24), which is why the two have to be transcribed together: whichever
 * ran last in the frame owns `$D000`.
 */

/** the orb: whether the room has one, its program counter, register and wait */
var ORB_PRESENT = 0x6D, ORB_PC = 0x6E, ORB_REG = 0x6F, ORB_WAIT = 0x70;

/** the scratch the script works in */
var ORB_WORK = 0x71, ORB_Y = 0x72, ORB_X = 0x73;

/** the snooze: while it is not `$FF` nothing moves (`$92C6`) */
var ORB_SNOOZE = 0x47;

/** the script itself, pairs of bytes (`$92D8`) */
var ORB_SCRIPT = 0x2232;

/** sprite 0, which the orb is */
var ORB_SP0X = 0xD000, ORB_SP0Y = 0xD001, ORB_MSIGX = 0xD010;

function orbByte(v) { return v & 0xFF; }
function orbLoad(m, a) { return rbLoad(m, a); }
function orbStore(m, a, v) { rbStore(m, a, v); }

/** a nibble read as a signed number (`$9335`, `$934F`) */
function orbSigned(v) { return (v & 0x0F) >= 8 ? (v & 0x0F) | 0xF0 : (v & 0x0F); }

/** twice the pixel x of sprite 0, as the ninth bit and the register have it */
function orbHalfX(m) {
  return orbByte(((orbLoad(m, ORB_MSIGX) & 1) << 7) | (orbLoad(m, ORB_SP0X) >> 1));
} // orbHalfX

/**
 * `$933E` / `$93BB` — the half of x that was worked on goes back, and the
 * bit that fell off the top goes into `$D010`.
 * @param {Object} m - The machine.
 * @param {number} half - Twice the pixel x, or rather half of the sprite x.
 */
function orbSetHalfX(m, half) {
  orbStore(m, ORB_SP0X, orbByte(half << 1));
  var msb = (half & 0x80) ? 1 : 0;
  orbStore(m, ORB_MSIGX, (orbLoad(m, ORB_MSIGX) & 0xFE) | msb);
} // orbSetHalfX

/**
 * `$94DB` — where the agent is, as the orb wants him: the middle of his
 * three sprites vertically, and half of his x.
 * @param {Object} m - The machine.
 */
function orbAimAtAgent(m) {
  var top = plTopEdge(m);
  orbStore(m, ORB_Y, top);
  var sum = top + plBottomEdge(m);
  orbStore(m, ORB_Y, orbByte(((sum > 0xFF ? 0x80 : 0) | (orbByte(sum) >> 1))));
  var left = plLeftEdge(m);
  var a = orbByte((left.c ? 0x80 : 0) | (left.a >> 1));
  orbStore(m, ORB_X, a);
  var right = plRightEdge(m);
  var b = orbByte((right.c ? 0x80 : 0) | (right.a >> 1));
  var total = b + a;
  orbStore(m, ORB_X, orbByte(((total > 0xFF ? 0x80 : 0) | (orbByte(total) >> 1))));
} // orbAimAtAgent

/**
 * `$92C1` — the orb, once a frame, from the interrupt.
 * @param {Object} m - The machine.
 * @returns {boolean} True when the orb ran at all.
 */
function orbFrame(m) {
  if (orbLoad(m, ORB_PRESENT) & 0x80) { return false; }   // `$92C3`, místnost bez koule
  if (orbLoad(m, ORB_SNOOZE) !== 0xFF) { return false; }  // `$92C6`, snooze
  if (orbLoad(m, ORB_WAIT)) {                             // `$92CD`
    orbStore(m, ORB_WAIT, orbByte(orbLoad(m, ORB_WAIT) - 1));
    orbLand(m);
    return true;
  }
  for (var guard = 0; guard < 0x100; guard++) {
    var pc = orbLoad(m, ORB_PC);
    var op = orbLoad(m, (ORB_SCRIPT + pc) & 0xFFFF);
    var arg = orbLoad(m, (ORB_SCRIPT + 1 + pc) & 0xFFFF);
    orbStore(m, ORB_PC, orbByte(pc + 2));
    if (op === 0) { orbStore(m, ORB_WAIT, arg); orbLand(m); return true; }
    if (op === 1) { orbMove(m, arg); orbLand(m); return true; }
    if (op === 2) { orbHome(m, arg); return true; }
    if (op === 3) { orbStore(m, ORB_PC, arg); continue; }
    if (op === 4) {
      if (!orbLoad(m, ORB_REG)) {
        orbStore(m, ORB_PC, orbByte(orbLoad(m, ORB_PC) + arg));
      }
      continue;
    }
    if (op === 5) { orbStore(m, ORB_REG, arg); continue; }
    if (op === 6) { orbStore(m, ORB_REG, orbByte(orbLoad(m, ORB_REG) + arg)); continue; }
    // `$92F7` — všechno ostatní je odečtení
    orbStore(m, ORB_REG, orbByte(orbLoad(m, ORB_REG) - arg));
  }
} // orbFrame

/**
 * `$9324` — move by two signed nibbles: the top one is x (in half-pixels,
 * so the orb can sit between characters), the bottom one y.
 * @param {Object} m - The machine.
 * @param {number} arg - The operand.
 */
function orbMove(m, arg) {
  var half = orbHalfX(m);
  orbStore(m, ORB_WORK, half);
  orbSetHalfX(m, orbByte(half + orbSigned(arg >> 4)));
  orbStore(m, ORB_SP0Y, orbByte(orbLoad(m, ORB_SP0Y) + orbSigned(arg)));
} // orbMove

/**
 * `$935F` — home in on the agent at a given speed, first in y and then in x,
 * but ★ **only when it is worth moving**: closer than two raster lines and
 * the orb stays put (`$9374`), and in x it never overshoots (`$93A7`).
 * @param {Object} m - The machine.
 * @param {number} speed - How far it may move this frame.
 */
function orbHome(m, speed) {
  orbStore(m, ORB_WORK, speed);
  orbAimAtAgent(m);                                       // `$94DB`
  var dy = orbLoad(m, ORB_SP0Y) + 9 - orbLoad(m, ORB_Y);
  var down = dy >= 0;
  var far = orbByte(down ? dy : -dy);
  if (far >= 2 && far >= speed) {
    orbStore(m, ORB_SP0Y, orbByte(down ? orbLoad(m, ORB_SP0Y) - speed
                                       : orbLoad(m, ORB_SP0Y) + speed));
  }
  var half = orbHalfX(m);
  orbStore(m, ORB_Y, half);
  var dx = half + 6 - orbLoad(m, ORB_X);
  var right = dx >= 0;
  var apart = orbByte(right ? dx : -dx);
  if (apart >= speed) {
    orbSetHalfX(m, orbByte(right ? half - speed : half + speed));
  }
  orbLand(m);
} // orbHome

/**
 * `$93C9` — and wherever the orb has got to, it must not leave the screen
 * and must not sink into the floor: below `$FB` it wraps to the top, above
 * row `$33` it asks the picture what is under it and is pushed out of
 * anything solid.
 * @param {Object} m - The machine.
 */
function orbLand(m) {
  var y = orbLoad(m, ORB_SP0Y);
  if (y >= 0xFB) { y = 0x19; orbStore(m, ORB_SP0Y, y); }
  if (y < 0x33) { return; }
  var row = orbByte(y + 8);
  orbStore(m, ORB_WORK, row);
  // ★ Ptá se **dvakrát**: jednou na svém levém okraji a podruhé o `$18`
  // pixelů vpravo (`$940D`), tedy na obou koncích koule.
  var x = orbLoad(m, ORB_SP0X);
  if (orbSolid(m, x, row, orbLoad(m, ORB_MSIGX) & 1)) {
    var v = (x & 0xF8) + 8;                               // `$93F0`
    orbStore(m, ORB_SP0X, orbByte(v));
    if (v > 0xFF) { orbStore(m, ORB_MSIGX, orbLoad(m, ORB_MSIGX) | 0x01); }
  }
  // ★ **`X` se v `$93F0` nemění** (`TXA` jen kopíruje), takže druhá otázka
  // jde od **původního** `x`, ne od posunutého
  var right = x + 0x18;                                   // `$940D`
  var carry = right > 0xFF ? 1 : (orbLoad(m, ORB_MSIGX) & 1);
  if (orbSolid(m, orbByte(right), row, carry)) {
    orbStore(m, ORB_SP0X, orbLoad(m, ORB_SP0X) & 0xF8);   // `$9421`
  }
  orbStandOn(m);                                          // `$9431`
} // orbLand

/**
 * `$9431`-`$9481` — a **svisle** se koule vytlačuje taky, a to je to, co ji
 * drží nad plošinou.
 *
 * ★ Ptá se na **prostředek koule** (`SP0X + $0C`) dvakrát: na jejím horním
 * okraji (`SP0Y`) a na spodním (`SP0Y + $10`). Kde to drží, tam se zarovná
 * na znakový řádek — dolů `((y + 6) & $F8) + 2`, nahoru `((y - 2) & $F8) + 1`.
 *
 * ★★ A **nezkoumá `$4C`**: vodorovné vytlačení (`$93EC`) bere za pevné jen
 * znaky `$45`-`$4B`, svislé **všechno, co `$8CC3` ohlásí**, tedy `$45`-`$51`
 * — a v tom rozsahu leží **plošiny výtahu**. Bez téhle půlky se koule do
 * plošiny zanoří a vodorovné vytlačení ji pak snímek co snímek žene o osm
 * pixelů doprava, až vyjede z místnosti (nahlásil operátor 2026-09-21).
 *
 * @param {Object} m - The machine.
 */
function orbStandOn(m) {
  var middle = orbLoad(m, ORB_SP0X) + 0x0C;               // `$9431`
  var carry = middle > 0xFF ? 1 : (orbLoad(m, ORB_MSIGX) & 1);
  var x = orbByte(middle);
  if (orbBlocked(m, x, orbLoad(m, ORB_SP0Y), carry)) {    // `$9443`
    orbStore(m, ORB_SP0Y,                                 // `$9448`
             orbByte((orbByte(orbLoad(m, ORB_SP0Y) + 0x06) & 0xF8) + 0x02));
  }
  // ★ `$945E` — spodní okraj se ptá **i tehdy, když horní vytlačil**
  if (orbBlocked(m, x, orbByte(orbLoad(m, ORB_SP0Y) + 0x10), carry)) {
    orbStore(m, ORB_SP0Y,                                 // `$946D`
             orbByte((orbByte(orbLoad(m, ORB_SP0Y) - 0x02) & 0xF8) + 0x01));
  }
} // orbStandOn

/**
 * `$93E7` and `$9418` — is the cell under that point something the orb
 * cannot be in? ★ Solid characters below `$4C` are; and when the agent is
 * **searching**, `$9482` gives the furniture a say as well.
 *
 * ★ `$9482` is only half transcribed: the half that matters when the agent
 * is not searching, which is the only case any recording has so far. The
 * rest belongs with the search itself (M3).
 *
 * @param {Object} m - The machine.
 * @param {number} x - Twice the pixel x, low byte.
 * @param {number} row - The row to ask about.
 * @param {number} carry - The ninth bit.
 * @returns {boolean} True when the orb has to be pushed out.
 */
function orbSolid(m, x, row, carry) {
  var cell = plCell(m, x, row, carry);
  if (cell.c && cell.a < 0x4C) { return true; }
  return orbFurniture(m, cell.y);                         // `$9406` / `$942C`
} // orbSolid

/**
 * `$9443` a `$9468` — totéž pro **svislé** vytlačení, a je v tom rozdíl:
 * tady se **na `$4C` neptá** (`$9446 BCC` a nic víc), takže za pevné platí
 * všechno, co `$8CC3` ohlásí — znaky `$45`-`$51`, tedy **i plošiny výtahu**.
 * @param {Object} m - The machine.
 * @param {number} x - Twice the pixel x, low byte.
 * @param {number} row - The row to ask about.
 * @param {number} carry - The ninth bit.
 * @returns {boolean} True when the orb has to be pushed out.
 */
function orbBlocked(m, x, row, carry) {
  var cell = plCell(m, x, row, carry);
  if (cell.c) { return true; }
  return orbFurniture(m, cell.y);                         // `$9459` / `$947C`
} // orbBlocked

/**
 * `$9482` — ★ **co je pod oknem prohledávání**, a je to přesně naopak, než
 * to vypadá: okno kouli nezastaví, ale **nepustí ji ani skrz to, co pod ním
 * leží**.
 *
 * Dokud agent neprohledává (`$3F` ≠ `$0F`), rutina jen řekne „nic" a je to
 * ta půlka, kterou přepis do M5 uměl. Když prohledává, spočítá, jestli
 * dotazovaná buňka padla **do okna** — čtyři řádky po osmi znacích od
 * ukazatele `$10`/`$11` (`app/furniture.js`, §27) — a jestli ano, podívá se
 * místo obrazovky do **`$C100`**, tedy na místnost, jak vypadala, než ji
 * okno překrylo. Tím se koule chová, jako by bublina nebyla: zastaví ji
 * podlaha pod ní, ale samotné znaky okna ne.
 *
 * ★ Bez téhle půlky koule **bublinou i tím, co je pod ní, prolétne**
 * (nahlásil operátor 2026-09-21): znaky okna jsou `$00`-`$1F`, tedy mimo
 * pevný rozsah `$45`-`$51`, takže `$8CC3` řekne „prázdno" a nikdo se už
 * nezeptal.
 *
 * @param {Object} m - The machine.
 * @param {number} column - Sloupec, na který se `$8CC3` ptalo (nechává ho v `Y`).
 * @returns {boolean} True when the cell counts as solid.
 */
function orbFurniture(m, column) {
  if (orbLoad(m, 0x3F) !== 0x0F) { return false; }        // `$9486`
  // `$9488` — adresa buňky: řádek z `$7C`/`$7D` plus sloupec
  var lo = orbByte(column) + orbLoad(m, 0x7C);
  orbStore(m, 0x72, orbByte(lo));
  var hi = orbByte(orbLoad(m, 0x7D) + (lo > 0xFF ? 1 : 0));
  orbStore(m, 0x73, hi);
  // `$9494` — a od ní ukazatel okna; musí vyjít **ve stejné stránce**
  var dlo = orbLoad(m, 0x72) - orbLoad(m, 0x10);
  orbStore(m, 0x72, orbByte(dlo));
  if (orbByte(hi - orbLoad(m, 0x11) - (dlo < 0 ? 1 : 0)) !== 0) { return false; }
  var a = orbLoad(m, 0x72);
  if (a & 0x80) { return false; }                         // `$94A3`
  // `$94A7` — čtyři řádky okna po osmi znacích, a mezi nimi celý řádek
  // obrazovky; ★ ten čtvrtý se na šířku **už neptá** (`$94C3` propadá)
  var y = 0;
  if (a >= 8) {
    y = 0x08; a -= 0x28; if (a < 0) { return false; }
    if (a >= 8) {
      y = 0x10; a -= 0x28; if (a < 0) { return false; }
      if (a >= 8) {
        y = 0x18; a -= 0x28; if (a < 0) { return false; }
      }
    }
  }
  orbStore(m, 0x72, orbByte(a));                          // `$94C5`
  var ch = orbLoad(m, 0xC100 + orbByte(y + orbByte(a)));
  return ch >= 0x45 && ch < 0x52;                         // `$94CF`
} // orbFurniture

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var orb = {
  frame: orbFrame, move: orbMove, home: orbHome, land: orbLand, standOn: orbStandOn,
  // ★ `$9482` samotné: hlídá ho `tools/runworker.mjs`, protože žádný záznam
  // nemá kouli pod oknem prohledávání
  underWindow: orbFurniture,
  SCRIPT: ORB_SCRIPT, PRESENT: ORB_PRESENT
};
if (typeof self !== 'undefined') {
  self.orb = orb;
  self.orbFrame = orbFrame;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = orb; }
