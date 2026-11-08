#!/usr/bin/env node
/**
 * matchfortressmap — mapa pevnosti z knihovny proti losování originálu.
 *
 * Sourozenec `matchfortressgen.mjs` pro **druhé losování**: `$B2B3`, volané
 * z `$398F` ještě před generátorem pevnosti (`disasm_notes.md` §11). Vezme
 * paměť stroje při vstupu do `$398F`, pustí nad ní `app/fortressMap.js`
 * a srovná celou RAM s tím, co měl originál na `$3992`.
 *
 * Záznamy dělá `tools/tracefortressgen.py --gen map --seeds …`.
 *
 *     ./tools/matchfortressmap.mjs [--index SOUBOR] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const indexAt = args.indexOf('--index');
const indexPath = indexAt >= 0 ? args[indexAt + 1] : 'build/fortress/map_seeds.json';
const verbose = args.includes('--verbose');

// Ve workeru si oba soubory natáhne `importScripts` do jednoho globálu, takže
// `fortressMap.js` vidí míchačku z `fortressGen.js` rovnou. Pod Node je každý
// klasický skript ve vlastní obálce — `self` je to, přes co se sourozenci
// najdou, tak se tu udělá takový, jaký má worker.
globalThis.self = globalThis;
loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
const fortressMap = loadClassicScript(new URL('../app/fortressMap.js', import.meta.url).pathname);

/**
 * Totéž, co u `matchfortressgen.mjs`: zásobník a počitadlo přerušení nejsou
 * výstup losování (`INC $E0` na `$8361` je jediný zápis do `$E0` v programu).
 */
function excluded(a) {
  return (a >= 0x0100 && a <= 0x01FF) || a === 0x00E0;
} // excluded

function ranges(addresses, gap = 16) {
  const out = [];
  for (const a of addresses) {
    if (out.length && a - out[out.length - 1][1] <= gap) { out[out.length - 1][1] = a; }
    else { out.push([a, a]); }
  }
  return out;
} // ranges

const hex = (v, n = 4) => v.toString(16).toUpperCase().padStart(n, '0');

let index;
try {
  index = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch (e) {
  console.error(`chybí záznam originálu (${indexPath})\n  `
    + './tools/tracefortressgen.py --gen map --seeds 40-4f --jobs 6 --name m'
    + ' --out build/fortress/map_seeds.json');
  process.exit(2);
}

let checks = 0, differences = 0, seeds = 0, skipped = 0;
for (const record of index.seeds) {
  const before = readFileSync(record.before);
  const after = readFileSync(record.after);
  const mem = new Uint8Array(before);
  fortressMap.generateFortressMap(mem, parseInt(record.entropy, 16));

  const wrong = [];
  for (let a = 0; a < 0x10000; a++) {
    if (excluded(a)) { skipped++; continue; }
    checks++;
    if (mem[a] !== after[a]) { wrong.push(a); }
  }
  differences += wrong.length;
  seeds++;
  if (wrong.length || verbose) {
    const where = ranges(wrong).slice(0, 6).map(([lo, hi]) => `$${hex(lo)}-$${hex(hi)}`).join(', ');
    console.log(`  entropie $${record.entropy}: ${wrong.length} rozdílů`
      + (wrong.length ? ` — ${where}${ranges(wrong).length > 6 ? ' …' : ''}` : ''));
    if (wrong.length && verbose) {
      for (const a of wrong.slice(0, 16)) {
        console.log(`      $${hex(a)}: knihovna $${hex(mem[a], 2)} != originál $${hex(after[a], 2)}`);
      }
    }
  }
}

console.log(`matchfortressmap: ${seeds} semínek, ${checks} kontrol, ${differences} rozdílů`
  + ` (mimo srovnání ${skipped} bajtů: zásobník $0100-$01FF a počitadlo přerušení $00E0)`);
process.exit(differences ? 1 : 0);
