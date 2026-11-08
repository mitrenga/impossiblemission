// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * `$94FA` — **kolize sprajtů**, a s ní jediné místo, kde agent umírá dotykem
 * (`sources/docs/disasm_notes.md` §30).
 *
 * ★ **Je to hardwarový test, ne obdélníky.** Rutina se neptá souřadnic, ptá
 * se registru **`$D01E`**, který VIC-II plní ze skutečně vykreslených bodů:
 * pixel po pixelu, bez ohledu na prioritu (`$D01B`) a bez ohledu na barvu.
 * Model ho počítá v knihovně — `svision/js/platform/canvas2D/c64/c64Collision.js`,
 * protože je to vlastnost stroje, ne téhle hry.
 *
 * ★ **A rámeček kolizi neořezává**, i když obraz ořezává. Vypadá to jako
 * detail knihovny, ale změřilo se to tady: agent dojde k pravému kraji
 * místnosti, jeho tři sprajty se posunou na X 334, kde je z nich vidět
 * devět sloupců — a originál o nich dál hlásí `$0E`. Ořezaný model v tom
 * místě nehlásí nic, a přesně tak se ten rozdíl našel (`collroom42`,
 * 2026-09-20). Kreslení a kolize jsou dvě různé jednotky čipu: sprajt se
 * do rámečku **nekreslí** (`C64SpriteEntity`), ale **koliduje** tam.
 *
 * ## Dvě vrstvy, a druhá jen pro jeden sprajt
 *
 * Nad registrem je druhá vrstva, a ta už souřadnice počítá — ale **jen pro
 * sprajt 0**. Důvod je ten, že sprajt 0 je sdílený: je to koule i blesk,
 * který si od ní roboti půjčují (§24). Když registr ohlásí kolizi se
 * sprajtem 0, `$9539` spočítá `2·dX + dY` od středu agenta (a ten střed je
 * průměr jeho **čtyř hran**, `$94DB` → `$8C46`/`$8C55`/`$8C5E`/`$8C95`) a
 * pak projde roboty. Je-li **kterýkoli robot blíž než agent**, koule zmizí
 * a agent žije. Roboti sami se řeší výhradně registrem, bez jediného
 * odčítání.
 *
 * ## Pořadí rozhodnutí
 *
 * | test | co se stane |
 * |---|---|
 * | `$DC` ≠ 0 | jen vyčistit latch, nic (? co `$DC` znamená, §30) |
 * | místnost `$7E` je `$11` nebo `$1B` (kódové) | totéž |
 * | `$1A` = 0 (šachta) | totéž |
 * | `$D015 & $F1` = 0 | konec, latch se **ani nečte** |
 * | `$47` ≠ `$FF` (roboti spí) | `AND #$01` — spící robot nezabíjí, koule ano |
 * | `$6D` bit 7 (koule není) | zbyde-li něco z `$F1`, smrt |
 * | bit 0 (sprajt 0) | vzdálenostní test `$9539` |
 * | jinak `AND #$78` (roboti, sprajty 4-7) | smrt rovnou |
 * | `$85` (jízda výtahem dolů) | nesmrtelnost, ale **až za** vzdálenostním testem |
 *
 * ## Latch a kdy se plní
 *
 * ★ `$D01E` je **latch**: bity se hromadí, jak rastr kreslí obraz, a
 * **čtení ho nuluje**. Hra ho proto na třech místech přečte a hodnotu
 * zahodí — to není mrtvý kód, to je úklid. Čte se **na dvou místech**:
 * `$833D` v obsluze přerušení (jen v místnosti, `$82F8` ten úsek v šachtě
 * přeskočí) a `$8727` v kroku agenta — a ten je **za bránou `$3E`/`$40`**,
 * takže jen **každý třetí průchod**.
 *
 * ★ Z toho plyne, kam v přepisu patří **zameten rastru**: na **začátek
 * průchodu smyčkou**. Změřeno `traceplayer.py --collision`, které obě
 * `LDA $D01E` uvnitř `$94FA` přepíše na stub a zapíše, co četly (§30):
 * v místnosti `$833D` na dvou průchodech ze tří vidí `$0E` (agentovy tři
 * sprajty přes sebe) a na tom třetím **nulu**, protože mu ji `$8727` sebral
 * dřív. Kdyby se zametalo jinde, vyjde to obráceně.
 *
 * Měří `tools/matchcollision.mjs`.
 */

/** kde má hra latch — model ho drží tam, kde je na stroji */
var CO_SPSPCL = 0xD01E;
/** registry sprajtů */
var CO_SPENA = 0xD015, CO_MSIGX = 0xD010, CO_SP0X = 0xD000, CO_SP0Y = 0xD001;
var CO_MULTICOLOR = 0xD01C, CO_EXPAND_X = 0xD01D, CO_EXPAND_Y = 0xD017;
/** ukazatele sprajtů na konci obrazovky banky 1 (§13) */
var CO_POINTERS = 0x43F8, CO_BANK = 0x4000;
/** nultá stránka, na kterou se `$94FA` ptá */
var CO_GUARD = 0xDC, CO_ROOM = 0x7E, CO_PLACE = 0x1A, CO_SNOOZE = 0x47,
    CO_ORB = 0x6D, CO_DEATH = 0x43, CO_DOWN_LATCH = 0x85, CO_LAST_ROBOT = 0x54;
/** mezivýsledky, které si rutina odkládá — tytéž bajty jako originál */
var CO_MID_Y = 0x72, CO_MID_X = 0x73, CO_ORB_Y = 0x7A, CO_ORB_X = 0x7B,
    CO_ROBOT_DY = 0x71;
/** tabulka devátých bitů robotů, `$0E6C` (bit sprajtu 4 až 7) */
var CO_NINTH_TABLE = 0x0E6C;
/** dvě kódové místnosti, ve kterých se nekoliduje (§30) */
var CO_CODE_ROOMS = [0x11, 0x1B];
/** dosah koule: `2·dX + dY` pod `$40` (`$956C`) */
var CO_ORB_REACH = 0x40;

function coLoad(m, a) { return rbLoad(m, a); }
function coStore(m, a, v) { rbStore(m, a, v); }
function coByte(v) { return v & 0xFF; }

/** `A` po `ROR` s daným přenosem — zápis, který originál dělá pořád */
function coRor(a, carry) { return coByte((carry ? 0x80 : 0) | (a >> 1)); }

/** absolutní hodnota rozdílu tak, jak ji dělá `SEC SBC` + `EOR #$FF ADC #$01` */
function coDistance(a, b) {
  var d = a - b;
  return d < 0 ? coByte(-d) : coByte(d);
}

/**
 * Osm sprajtů tak, jak je vidí čip: tvar z bloku, na který míří ukazatel,
 * poloha z registrů, režim z `$D01C`/`$D01D`/`$D017` a svícení z `$D015`.
 * @param {Object} m - Stroj.
 * @returns {Array} Osm položek pro `C64Collision.spriteSprite`.
 */
function coSprites(m) {
  var spena = coLoad(m, CO_SPENA), msigx = coLoad(m, CO_MSIGX),
      mc = coLoad(m, CO_MULTICOLOR), ex = coLoad(m, CO_EXPAND_X),
      ey = coLoad(m, CO_EXPAND_Y), out = [], i, j;
  for (i = 0; i < 8; i++) {
    if (!((spena >> i) & 1)) { out.push(null); continue; }
    var at = CO_BANK + coLoad(m, CO_POINTERS + i)*64, bytes = [];
    for (j = 0; j < 63; j++) { bytes.push(coLoad(m, at + j)); }
    out.push({
      x: coLoad(m, CO_SP0X + i*2) | (((msigx >> i) & 1) << 8),
      y: coLoad(m, CO_SP0Y + i*2),
      bytes: bytes, enabled: true,
      multicolor: !!((mc >> i) & 1),
      expandX: !!((ex >> i) & 1),
      expandY: !!((ey >> i) & 1),
    });
  }
  return out;
}

/**
 * ★ **Zameten rastru**: co se za jeden obraz vykreslilo, to se přičte do
 * latche. Volá se **jednou na začátku průchodu smyčkou**, protože průchod
 * začíná hned za obsluhou přerušení, tedy na začátku obrazu, a kreslí se
 * přesně to, co do registrů zapsal průchod minulý (§30).
 * @param {Object} m - Stroj.
 * @returns {number} Co v latchi je po zametení.
 */
function coSweep(m) {
  var bits = C64Collision.spriteSprite(coSprites(m));
  var now = coByte(coLoad(m, CO_SPSPCL) | bits);
  coStore(m, CO_SPSPCL, now);
  return now;
}

/**
 * ★ `LDA $D01E` — dá, co v něm je, **a vynuluje ho**.
 *
 * ★ Kdo se ptá, se zapisuje do `m.co`, je-li tam okénko. Není to pro hru,
 * je to pro měřidlo: latch po čtení nic nezanechá, takže „co rutina
 * přečetla" se z paměti zpětně zjistit nedá — ani na stroji (proto má
 * `traceplayer --collision` stub na obou `LDA $D01E`, §30), ani tady.
 *
 * @param {Object} m - Stroj.
 * @param {number} site - Adresa toho `LDA`: `$9508`, nebo `$9517`.
 * @returns {number} Bity kolizí.
 */
function coRead(m, site) {
  var was = coLoad(m, CO_SPSPCL);
  coStore(m, CO_SPSPCL, 0);
  if (m.co) { m.co.value = was; m.co.count++; m.co.sites.push(site); }
  return was;
}

/**
 * ★ **Latch na začátku běhu**, a je to vlastní pravidlo, ne detail.
 *
 * `$D01E` se **čtením nuluje**, takže hodnota, kterou má ve výpisu paměti,
 * neříká nic o tom, co hra viděla: je to zbytek, který se do registru
 * nasbíral od posledního čtení — u záznamu od okamžiku, kdy si ho monitor
 * VICE naposledy „ohmatal". Kdo takový zbytek zdědí, dostane při prvním
 * `$94FA` kolizi, která se nestala; v prohledávacím záznamu to agenta
 * zabilo na prvním snímku (2026-09-20). Model proto latch při rozběhu
 * **vynuluje** — a to platí i pro `player.seedMemory` v prohlížeči.
 *
 * @param {Object} m - Stroj.
 */
function coReset(m) {
  coStore(m, CO_SPSPCL, 0);
}

/**
 * `$95C0` — smrt dotykem: `$43 = 1`, roboti zase usnou a koule zhasne.
 * @param {Object} m - Stroj.
 * @returns {number} `$43`.
 */
function coKill(m) {
  coStore(m, CO_DEATH, 1);
  coStore(m, CO_SNOOZE, 0);
  coStore(m, CO_ORB, 0xFF);
  return 1;
}

/**
 * `$95CD` — koule trefila něco jiného než agenta: zmizí, a sprajt 0 zhasne.
 * @param {Object} m - Stroj.
 */
function coOrbGone(m) {
  coStore(m, CO_ORB, 0xFF);
  coStore(m, CO_SPENA, coByte(coLoad(m, CO_SPENA) & 0xFE));
}

/**
 * `$94DB` — **střed agenta z jeho čtyř hran**, tak jak ho počítá originál
 * i s přenosy: `$72` je průměr horní a dolní, `$73` průměr levé a pravé.
 * ★ Jsou to tytéž čtyři rutiny, kterými se agent pohybuje (§19) — kolize
 * si nevede vlastní obdélník.
 * @param {Object} m - Stroj.
 */
function coAgentMiddle(m) {
  var top = plTopEdge(m);                        // `$8C46`
  var sum = plBottomEdge(m) + top;               // `$8C55`, CLC ADC $72
  coStore(m, CO_MID_Y, coRor(coByte(sum), sum > 0xFF));
  var left = plLeftEdge(m);                      // `$8C5E`
  var half = coRor(left.a, left.c);
  var right = plRightEdge(m);                    // `$8C95`
  var sum2 = coRor(right.a, right.c) + half;
  coStore(m, CO_MID_X, coRor(coByte(sum2), sum2 > 0xFF));
}

/**
 * `$9539` — koule (nebo blesk) se sprajtem 0 dotkla něčeho. Komu je blíž?
 *
 * Vzdálenost je `2·dX + dY` a měří se od středu agenta; pak se týmž měřítkem
 * projdou roboti (sprajty 4-7) a ★ **je-li kterýkoli blíž, koule zmizí a
 * agent přežije**. To je celý smysl toho dopočtu: sprajt 0 je sdílený mezi
 * koulí a bleskem robota, takže registr sám o sobě neříká, komu patří.
 *
 * @param {Object} m - Stroj.
 * @returns {number} `$43`, tedy 0, když se nic nestalo.
 */
function coOrbTouch(m) {
  coAgentMiddle(m);                              // `$9539 JSR $94DB`
  var orbY = coByte(coLoad(m, CO_SP0Y) + 8);
  coStore(m, CO_ORB_Y, orbY);
  coStore(m, CO_MID_Y, coDistance(orbY, coLoad(m, CO_MID_Y)));
  // `$954F`: devátý bit sprajtu 0 jde do přenosu a pak se s ním `ROR`ne X
  var ninth = coLoad(m, CO_MSIGX) & 1;
  var orbX = coByte(coRor(coLoad(m, CO_SP0X), ninth) + 6);
  coStore(m, CO_ORB_X, orbX);
  var dx = coDistance(orbX, coLoad(m, CO_MID_X));
  // `$9565 ASL A / BCS` — dvojnásobek X, a přeteče-li, je to daleko
  if (dx & 0x80) { coOrbGone(m); return 0; }
  var reach = (dx << 1) + coLoad(m, CO_MID_Y);
  if (reach > 0xFF || reach >= CO_ORB_REACH) { coOrbGone(m); return 0; }
  coStore(m, CO_MID_Y, reach);

  // `$9572`: kolik je robotů — `$54` je poslední z nich, po šesti bajtech
  var last = coLoad(m, CO_LAST_ROBOT);
  if (!(last & 0x80)) {
    var x = -1, a = last;                        // `$9576 LDX #$FF / SEC`
    do { a -= 6; x++; } while (a >= 0);
    for (; x >= 0; x--) {
      var y = x*2;
      var dyR = coDistance(coByte(coLoad(m, 0xD009 + y) + 9), coLoad(m, CO_ORB_Y));
      coStore(m, CO_ROBOT_DY, dyR);
      var carry = (coLoad(m, CO_MSIGX) & coLoad(m, CO_NINTH_TABLE + x)) ? 1 : 0;
      var dxR = coDistance(coByte(coRor(coLoad(m, 0xD008 + y), carry) + 6),
                           coLoad(m, CO_ORB_X));
      if (dxR & 0x80) { continue; }              // `$95AD BCS $95B7`
      var reachR = (dxR << 1) + dyR;
      if (reachR > 0xFF) { continue; }           // `$95B1 BCS $95B7`
      // ★ `$95B3 CMP $72 / BCC $95CD` — robot je blíž než agent
      if (reachR < coLoad(m, CO_MID_Y)) { coOrbGone(m); return 0; }
    }
  }
  // `$95BC`: ★ při jízdě výtahem dolů je agent nesmrtelný (§25)
  if (coLoad(m, CO_DOWN_LATCH)) { return 0; }
  return coKill(m);
}

/**
 * `$94FA` — celá rutina. Volá se **dvakrát za snímek**: z obsluhy přerušení
 * (`$833D`, jen v místnosti) a z kroku agenta (`$8727`, každý třetí
 * průchod).
 * @param {Object} m - Stroj.
 * @returns {number} `$43` — 0, dokud agent žije.
 */
function coFrame(m) {
  // `$94FA`: tři důvody, proč se dnes nekoliduje — a u všech se latch
  // přesto přečte, tedy vyčistí
  var room = coLoad(m, CO_ROOM);
  if (coLoad(m, CO_GUARD) || CO_CODE_ROOMS.indexOf(room) >= 0
      || !coLoad(m, CO_PLACE)) {
    coRead(m, 0x9508);                           // `$9508`
    return 0;
  }
  // ★ `$9510`: nesvítí-li nic než agent, latch se **ani nečte** a zůstane
  if ((coLoad(m, CO_SPENA) & 0xF1) === 0) { return 0; }
  var a = coRead(m, 0x9517);                     // `$9517`
  // `$951A`: spící roboti nezabíjejí, koule ano
  if (coLoad(m, CO_SNOOZE) !== 0xFF) { a &= 0x01; }
  // `$9522 BIT $6D` — sedmý bit říká, že koule v místnosti není
  if (coLoad(m, CO_ORB) & 0x80) {
    a &= 0xF1;
    return a ? coKill(m) : 0;
  }
  // `$952E LSR A`: bit 0 je sprajt 0, tedy koule nebo blesk
  var carry = a & 1;
  a >>= 1;
  if (carry) { return coOrbTouch(m); }
  // `$9531 AND #$78` — po posunu jsou to sprajty 4 až 7, tedy roboti
  return (a & 0x78) ? coKill(m) : 0;
}

var collision = {
  frame: coFrame, sweep: coSweep, read: coRead, reset: coReset, sprites: coSprites,
  middle: coAgentMiddle, kill: coKill,
  SPSPCL: CO_SPSPCL
};
// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
if (typeof self !== 'undefined') {
  self.collision = collision;
  // `app/player.js` je volá z obou míst, ze kterých je volá originál
  self.coFrame = coFrame;
  self.coSweep = coSweep;
  self.coReset = coReset;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = collision; }
