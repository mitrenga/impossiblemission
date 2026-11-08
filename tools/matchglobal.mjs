#!/usr/bin/env node
/**
 * matchglobal — globální tabulky z dat proti paměti běžícího originálu.
 *
 * `data/global.json` vzniká staticky z rozbaleného obrazu
 * (`tools/dumpglobal.py`; každá tabulka má v kódu svého čtenáře,
 * `sources/docs/disasm_notes.md` §17). Nástroj ukazuje tři věci:
 *
 * 1. **tabulky** salta a stavu agenta proti paměti stroje ve výtahu
 *    i v místnosti — je to statický pás `$8D05`–`$8E20`;
 * 2. **konstanty na svém místě v kódu**: hodiny (start ve 12, konec v 6,
 *    smrt −10 minut, telefon −2), krok chůze ±5, natočení `$01`/`$80`
 *    a geometrie sprajtu robota. Kdyby se některá z nich přečetla
 *    špatně, tenhle nástroj to řekne, ne až hra;
 * 3. ★ **programy robotů se losují**: v paměti stroje **před** generátorem
 *    má všech 93 robotů v záznamu místnosti nulu, **po první fázi**
 *    (`$B07E`) mají platný ukazatel do proudu `$2112`, a nic jiného se
 *    v záznamech nezměnilo. Tím je zodpovězená otevřená otázka §9.
 *
 *     ./tools/matchglobal.mjs [--dir build/screen] [--fortress build/fortress] [--verbose]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/screen');
const fortressDir = at('--fortress', 'build/fortress');
const verbose = args.includes('--verbose');

const data = JSON.parse(readFileSync('data/global.json', 'utf8'));
const addr = (key) => parseInt(key.slice(1), 16);
const RECORDS_FROM = 0x0EB0, RECORDS_TO = 0x1D63;   // záznamy místností (§12)

let checks = 0, diffs = 0;

const tables = [...data.somersault.tables, ...data.agent.tables];
// ★ A **proud programů robotů** `$2112`-`$232B`, ve kterém leží i skript
// koule (§24). Vozí se v `global.json` od 2026-09-20 a srovnává se tady,
// protože jinak by na jeho chybějící půlku nepřišlo nic: každé ostatní
// měřidlo začíná z výpisu paměti originálu, kde ten proud je.
if (data.robots.programs.values) {
  tables.push({addr: data.robots.programs.addr.split('-')[0],
               values: data.robots.programs.values});
}

/** Bajt tabulky zpátky, jak leží v paměti (záporné hodnoty jsou doplňkové). */
const raw = (v) => (v < 0 ? v + 256 : v);

const dumps = [['výtah', `${dir}/elevator_ram.bin`], ['místnost', `${dir}/room_ram.bin`]];
for (const [, path] of dumps) {
  if (!existsSync(path)) {
    console.error(`chybí paměť originálu v ${dir}\n  ./tools/mkscreen.py --name elevator`);
    process.exit(2);
  }
}

// --- 1. a 2. tabulky a konstanty proti paměti stroje ----------------------
for (const [what, path] of dumps) {
  const ram = new Uint8Array(readFileSync(path));
  let bad = 0, count = 0;
  for (const table of tables) {
    const from = addr(table.addr);
    for (let i = 0; i < table.values.length; i++) {
      checks++; count++;
      if (raw(table.values[i]) !== ram[from + i]) {
        bad++; diffs++;
        if (verbose && bad <= 8) {
          console.log(`  ${what}: $${(from + i).toString(16)} `
            + `${raw(table.values[i]).toString(16)} != ${ram[from + i].toString(16)}`);
        }
      }
    }
  }
  let constBad = 0;
  for (const c of data.constants) {
    checks++;
    if (ram[addr(c.addr)] !== addr(c.value)) {
      constBad++; diffs++;
      console.log(`  ${what}: ${c.what} — na ${c.addr} je `
        + `$${ram[addr(c.addr)].toString(16)}, ne ${c.value}`);
    }
  }
  console.log(`tabulky pohybu (${what}): ${count} bajtů, ${bad} rozdílů; `
    + `${data.constants.length} konstant, ${constBad} rozdílů`);
}

// --- 3. programy robotů se losují -----------------------------------------
// ★ `tools/tracefortressgen.py` ukládá stav po každé z šesti fází; `_p0` je
// stav při vstupu do `$7236`, `_p1` po první fázi ($B07E).
const spots = data.robots.spots.map(addr);
const programBytes = parseInt(data.robots.programs.bytes, 10);
let pairs = 0, robotBad = 0, elseBad = 0, zeroBefore = 0, drawn = 0;
if (existsSync(fortressDir)) {
  const seeds = readdirSync(fortressDir)
    .filter((f) => f.endsWith('_p1.bin'))
    .map((f) => f.slice(0, -7))
    .filter((seed) => existsSync(`${fortressDir}/${seed}_p0.bin`));
  for (const seed of seeds) {
    const before = new Uint8Array(readFileSync(`${fortressDir}/${seed}_p0.bin`));
    const after = new Uint8Array(readFileSync(`${fortressDir}/${seed}_p1.bin`));
    if (before.length < 0x2000 || after.length < 0x2000) { continue; }
    // ★ `m*` jsou průchody losováním mapy, ne generátorem — ty fázi 1 nemají
    if (spots.every((s) => after[s] === 0)) { continue; }
    pairs++;
    for (const spot of spots) {
      checks += 2;
      if (before[spot] !== 0) { zeroBefore++; diffs++; }
      if (after[spot] >= programBytes) {
        robotBad++; diffs++;
        if (verbose && robotBad <= 8) {
          console.log(`  $${spot.toString(16)}: program $${after[spot].toString(16)} `
            + 'míří mimo proud $2112');
        }
      }
      if (after[spot] !== 0) { drawn++; }
    }
    const inRecords = new Set(spots);
    for (let a = RECORDS_FROM; a <= RECORDS_TO; a++) {
      checks++;
      if (before[a] !== after[a] && !inRecords.has(a)) {
        elseBad++; diffs++;
        if (verbose && elseBad <= 8) {
          console.log(`  fáze 1 změnila $${a.toString(16)}, a to není „druh" robota`);
        }
      }
    }
  }
}
if (!pairs) {
  console.error(`chybí záznamy generátoru v ${fortressDir}\n  ./tools/tracefortressgen.py`);
  process.exit(2);
}
console.log(`programy robotů (${pairs} semínek): před generátorem samé nuly `
  + `(${zeroBefore} výjimek), po fázi 1 ${drawn} vylosovaných programů, `
  + `${robotBad} mimo proud, ${elseBad} zásahů mimo „druh"`);

console.log(`matchglobal: ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
