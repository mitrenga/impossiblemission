#!/usr/bin/env node
/**
 * matchfortressgen — pevnost losovaná knihovnou proti losování originálu.
 *
 * Akceptace M2 (`MILNIKY.md`): generátor pevnosti není extrakce jedné hry,
 * je to **kód originálu přepsaný** (`app/fortressGen.js`,
 * `sources/docs/disasm_notes.md` §9). Důkaz je tenhle: vezme se paměť
 * stroje **ve chvíli vstupu do `$7236`**, pustí se nad ní přepis, a musí
 * z toho vyjít bajt po bajtu totéž, co měl originál na `$7248`.
 *
 * Záznamy dělá `tools/tracefortressgen.py --seeds` (jeden běh VICE na
 * hodnotu entropie, dump celé RAM před generátorem a po něm). Entropie je
 * ta, kterou dostal originál — míchačka se přepisuje doslova, nahrazuje se
 * jen její vstup (`ZADANI.md` §10.4).
 *
 *     ./tools/matchfortressgen.mjs [--index SOUBOR] [--index SOUBOR] [--verbose]
 *
 * Bez `--index` si vezme, co najde: `build/fortress/seeds.json`
 * a `build/fortress/seeds_rest.json` (dávky se dají dojíždět po částech).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const indexPaths = args.reduce((out, a, i) => (a === '--index' ? out.concat(args[i + 1]) : out), []);
if (!indexPaths.length) { indexPaths.push('build/fortress/seeds.json', 'build/fortress/seeds_rest.json'); }
const verbose = args.includes('--verbose');

const fortressGen = loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);

const records = [];
for (const path of indexPaths) {
  try {
    records.push(...JSON.parse(readFileSync(path, 'utf8')).seeds);
  } catch (e) {
    if (args.includes('--index')) {
      console.error(`chybí záznam originálu (${path})`);
      process.exit(2);
    }
  }
}
if (!records.length) {
  console.error('žádný záznam originálu\n  '
    + './tools/tracefortressgen.py --seeds 00-0f --jobs 6 --name s');
  process.exit(2);
}

/**
 * Dvě místa, která se do srovnání nepočítají, obě doložená:
 *
 * - **zásobník `$0100`-`$01FF`** — návratové adresy 6502. Přepis nemá `JSR`,
 *   takže tam nemá co psát, a nic z toho generátor nečte.
 * - **`$00E0`** — počitadlo snímků obsluhy přerušení. Jediný zápis do něj
 *   v celém programu je `INC $E0` na `$8361`, tedy uvnitř obsluhy
 *   (`disasm_notes.md` §5); generátor se ho nedotkne a roste s tím, jak
 *   dlouho losování trvá.
 */
function excluded(a) {
  return (a >= 0x0100 && a <= 0x01FF) || a === 0x00E0;
} // excluded

/** souvislé úseky adres, ať je v hlášení vidět, o kterou oblast jde */
function ranges(addresses, gap = 16) {
  const out = [];
  for (const a of addresses) {
    if (out.length && a - out[out.length - 1][1] <= gap) { out[out.length - 1][1] = a; }
    else { out.push([a, a]); }
  }
  return out;
} // ranges

const hex = (v, n = 4) => v.toString(16).toUpperCase().padStart(n, '0');

let checks = 0, differences = 0, seeds = 0, skipped = 0;
for (const record of records) {
  const before = readFileSync(record.before);
  const after = readFileSync(record.after);
  const mem = new Uint8Array(before);           // a copy: the generator writes into it
  const entropy = parseInt(record.entropy, 16);

  fortressGen.generateFortress(mem, entropy);

  const wrong = [];
  for (let a = 0; a < 0x10000; a++) {
    if (excluded(a)) { skipped++; continue; }
    checks++;
    if (mem[a] !== after[a]) { wrong.push(a); }
  }
  differences += wrong.length;
  seeds++;
  const where = ranges(wrong).slice(0, 6)
    .map(([lo, hi]) => `$${hex(lo)}-$${hex(hi)}`).join(', ');
  if (wrong.length || verbose) {
    console.log(`  entropie $${record.entropy}: ${wrong.length} rozdílů`
      + (wrong.length ? ` — ${where}${ranges(wrong).length > 6 ? ' …' : ''}` : ''));
    if (wrong.length && verbose) {
      for (const a of wrong.slice(0, 16)) {
        console.log(`      $${hex(a)}: knihovna $${hex(mem[a], 2)} != originál $${hex(after[a], 2)}`);
      }
    }
  }
}

console.log(`matchfortressgen: ${seeds} semínek, ${checks} kontrol, ${differences} rozdílů`
  + ` (mimo srovnání ${skipped} bajtů: zásobník $0100-$01FF a počitadlo přerušení $00E0)`);
process.exit(differences ? 1 : 0);
