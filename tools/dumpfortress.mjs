#!/usr/bin/env node
/**
 * dumpfortress — co všechno losování pevnosti **čte**, a tedy co z paměti
 * originálu musí aplikace dostat jako data.
 *
 * Oba generátory (`app/fortressMap.js` a `app/fortressGen.js`) pracují nad
 * pamětí stroje, protože jen tak se dají dokázat bajt po bajtu
 * (`matchfortressmap.mjs`, `matchfortressgen.mjs`). Aplikace ale nemá
 * 64 KB originálu nosit s sebou — potřebuje jen ta místa, která generátory
 * čtou dřív, než do nich samy zapíšou. To jsou jejich **vstupy**: tabulky
 * místností, šablony, hesla, vzory mřížky, ukazatele na nábytek a masky
 * obrázku mapy.
 *
 * Nástroj je najde tak, že generátory pustí nad pamětí originálu
 * s odposlechem každého přístupu, a vypíše je jako souvislé úseky do
 * `data/fortress.json`. Pak totéž zopakuje nad **prázdnou** pamětí, do
 * které nasype jen ty úseky, a musí z toho vyjít táž pevnost — jinak ve
 * výčtu něco chybí.
 *
 *     ./tools/dumpfortress.mjs [--mem build/fortress/s00_p0.bin] [-o data/fortress.json]
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const memPath = at('--mem', 'build/fortress/m42_p0.bin');
const outPath = at('-o', 'data/fortress.json');
const entropy = parseInt(at('--entropy', '42'), 16);

globalThis.self = globalThis;            // klasické skripty se najdou přes `self`
const fortressGen = loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
const fortressMap = loadClassicScript(new URL('../app/fortressMap.js', import.meta.url).pathname);

/**
 * Paměť, která si pamatuje, co se z ní přečetlo dřív, než se do toho psalo.
 * @param {Uint8Array} bytes - Paměť originálu.
 * @returns {{view: Uint8Array, inputs: Set<number>}}
 */
function listening(bytes) {
  const written = new Uint8Array(0x10000);
  const inputs = new Set();
  const view = new Proxy(bytes, {
    get(target, key) {
      const a = typeof key === 'string' ? Number(key) : NaN;
      if (Number.isInteger(a) && !written[a]) { inputs.add(a); }
      return target[key];
    },
    set(target, key, value) {
      const a = typeof key === 'string' ? Number(key) : NaN;
      if (Number.isInteger(a)) { written[a] = 1; }
      target[key] = value;
      return true;
    }
  });
  return {view, inputs};
} // listening

/** souvislé úseky adres; mezera do `gap` bajtů se slepí, ať jich není tisíc */
function ranges(addresses, gap = 8) {
  const out = [];
  for (const a of [...addresses].sort((p, q) => p - q)) {
    if (out.length && a - out[out.length - 1][1] <= gap) { out[out.length - 1][1] = a; }
    else { out.push([a, a]); }
  }
  return out;
} // ranges

const original = new Uint8Array(readFileSync(memPath));

/**
 * Jeden průlet obou generátorů s odposlechem.
 * @param {number} eb - Stav míchačky, nízký bajt.
 * @param {number} ec - Stav míchačky, vysoký bajt.
 * @param {number} input - Hodnota entropie.
 * @returns {Set<number>} Adresy přečtené dřív, než se do nich psalo.
 */
function sniff(eb, ec, input) {
  const bytes = new Uint8Array(original);
  bytes[0xEB] = eb; bytes[0xEC] = ec;     // stav míchačky patří k semínku, ne k datům
  const {view, inputs} = listening(bytes);
  fortressMap.generateFortressMap(view, input);
  fortressGen.generateFortress(view, input);
  return inputs;
} // sniff

// Jeden průlet přečte jen to, co zrovna potřebuje — jedno heslo z osmi,
// část vzorů mřížky. Aby data platila pro **každou** hru, sjednotí se
// vstupy ze stovek různých stavů míchačky.
const runs = Number(at('--runs', '512'));
const inputs = new Set();
for (let i = 0; i < runs; i++) {
  const eb = (i*73 + 11) & 255, ec = (i*151 + 29) & 255;
  for (const a of sniff(eb, ec, (i*37 + entropy) & 255)) { inputs.add(a); }
}

// Zeropage je pracovní plocha, ne data — až na to, co si z ní generátory
// čtou dřív, než tam píšou. To je **stav míchačky** (`$EB`/`$EC`), a ten
// aplikaci dodá semínko, ne datový soubor; vypisuje se proto zvlášť.
const state = [...inputs].filter((a) => a < 0x0200).sort((p, q) => p - q);
const segments = ranges([...inputs].filter((a) => a >= 0x0200));
const payload = {
  note: 'vstupy losování pevnosti z paměti originálu (tools/dumpfortress.mjs)',
  from: memPath,
  state: state.map((a) => ({at: a, byte: original[a]})),
  segments: segments.map(([lo, hi]) => ({
    at: lo, length: hi - lo + 1,
    bytes: Buffer.from(original.subarray(lo, hi + 1)).toString('base64')
  }))
};

// kontrola: táž pevnost z prázdné paměti, do které se nasypou jen ty úseky
// kontrola: táž pevnost z prázdné paměti, do které se nasypou jen ty úseky,
// a to pro každý ze stavů míchačky, na kterých se vstupy sbíraly
let differences = 0;
const compare = ranges([...inputs]);
for (let i = 0; i < runs; i++) {
  const eb = (i*73 + 11) & 255, ec = (i*151 + 29) & 255, input = (i*37 + entropy) & 255;
  const bare = new Uint8Array(0x10000);
  for (const s of payload.segments) { bare.set(Buffer.from(s.bytes, 'base64'), s.at); }
  const full = new Uint8Array(original);
  bare[0xEB] = eb; bare[0xEC] = ec; full[0xEB] = eb; full[0xEC] = ec;
  fortressMap.generateFortressMap(bare, input);
  fortressGen.generateFortress(bare, input);
  fortressMap.generateFortressMap(full, input);
  fortressGen.generateFortress(full, input);
  for (const [lo, hi] of compare) {
    for (let a = lo; a <= hi; a++) { if (bare[a] !== full[a]) { differences++; } }
  }
}

const bytes = segments.reduce((sum, [lo, hi]) => sum + hi - lo + 1, 0);
mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, JSON.stringify(payload, null, 1));
console.log(`dumpfortress: ${segments.length} úseků, ${bytes} B → ${outPath}`);
for (const [lo, hi] of segments.slice(0, 40)) {
  console.log(`  $${lo.toString(16).toUpperCase().padStart(4, '0')}-`
    + `$${hi.toString(16).toUpperCase().padStart(4, '0')}  ${hi - lo + 1} B`);
}
console.log(`  stav míchačky: ${state.map((a) => '$' + a.toString(16).toUpperCase()).join(', ')}`
  + ' — ten dodá semínko, ne data');
console.log(`kontrola „stejná pevnost jen z těch úseků", ${runs} stavů míchačky: `
  + `${differences} rozdílů`);
process.exit(differences ? 1 : 0);
