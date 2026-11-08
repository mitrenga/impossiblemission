#!/usr/bin/env node
/**
 * matchrooms — místnost postavená knihovnou proti místnosti originálu.
 *
 * Akceptace M2 (`MILNIKY.md`): místnost se nekreslí z obrázku, staví ji
 * **kód originálu přepsaný** (`app/roomBuild.js`,
 * `sources/docs/disasm_notes.md` §12). Důkaz je stejný jako u pevnosti:
 * vezme se paměť stroje **ve chvíli vstupu do `$A39C`**, pustí se nad ní
 * přepis, a musí z toho vyjít bajt po bajtu totéž, co měl originál na
 * `$8BA1` — celá RAM, celá barevná paměť a všech 47 registrů VIC.
 *
 * Záznamy dělá `tools/tracerooms.py` (číslo místnosti se dosadí do `$7E`
 * a pustí se ten jeden `JSR $A39C`).
 *
 *     ./tools/matchrooms.mjs [--dir build/rooms] [--dir build/rooms_r] [--rooms 0-31]
 *     ./tools/matchrooms.mjs --data [--mem build/mem_unpacked.bin]
 *
 * Bez `--dir` si vezme obojí, co dělá `tracerooms.py`: `build/rooms` (vstup
 * zleva) a `build/rooms_r` (zprava) — vstupní strana mění, odkud stavitel
 * bere pozici agenta, takže obě patří do akceptace.
 *
 * `--data` měří druhou věc, kterou hra potřebuje: **že se místnost postaví
 * z `data/rooms.json`**, ne z obrazu paměti. Hra obraz paměti nenosí, nese
 * data — a tenhle běh ukazuje, že v nich je všechno, co stavitel čte:
 * postaví každou místnost dvakrát (z obrazu a z dat) a srovná obrazovku,
 * barevnou paměť i registry VIC. Loader je `app/roomsLoader.js`.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dirs = args.reduce((out, a, i) => (a === '--dir' ? out.concat(args[i + 1]) : out), []);
if (!dirs.length) { dirs.push('build/rooms', 'build/rooms_r'); }
const verbose = args.includes('--verbose');
const dataMode = args.includes('--data');
const [lo, hi] = at('--rooms', '0-31').split('-').map(Number);

globalThis.self = globalThis;
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const roomBuild = loadClassicScript(new URL('../app/roomBuild.js', import.meta.url).pathname);
const roomsLoader = loadClassicScript(new URL('../app/roomsLoader.js', import.meta.url).pathname);

if (dataMode) {
  const mem = new Uint8Array(readFileSync(at('--mem', 'build/mem_unpacked.bin')));
  const data = JSON.parse(readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));
  let checks = 0, diffs = 0;
  for (const side of [0, 1]) {
    for (let room = lo; room <= hi; room++) {
      const m = {mem: Uint8Array.from(mem), color: new Uint8Array(0x400),
                 vic: new Uint8Array(0x2F)};
      roomBuild.buildRoom(m, room, side);
      const out = roomsLoader.buildRoom(data, room, side);
      let bad = 0;
      for (let i = 0; i < roomsLoader.CELLS; i++) {
        checks += 2;
        if (m.mem[roomsLoader.SCREEN + i] !== out.screen[i]) { diffs++; bad++; }
        if ((m.color[i] & 0x0F) !== out.color[i]) { diffs++; bad++; }
      }
      for (let reg = 0; reg < m.vic.length; reg++) {
        checks++;
        if (m.vic[reg] !== out.vic[reg]) {
          diffs++; bad++;
          if (verbose) {
            console.log(`  místnost ${room}/${side}: VIC $${(0xD000+reg).toString(16)} `
              + `${m.vic[reg].toString(16)} != ${out.vic[reg].toString(16)}`);
          }
        }
      }
      if (bad && !verbose) { console.log(`  místnost ${room}, vstup ${side}: ${bad} rozdílů`); }
    }
  }
  console.log(`matchrooms --data: ${(hi-lo+1)*2} místností, ${checks} kontrol, ${diffs} rozdílů`);
  process.exit(diffs ? 1 : 0);
}

/**
 * Jediné místo mimo srovnání, doložené stejně jako u `matchfortressgen`:
 * **zásobník `$0100`–`$01FF`**. Přepis nemá `JSR`, takže tam nemá co psát,
 * a stavitel z něj nic nečte. Počitadlo `$00E0` tentokrát mimo není —
 * přerušení jsou po dobu měření vypnutá (`tools/tracerooms.py`).
 *
 * @param {number} a - Adresa.
 * @returns {boolean} Jestli se bajt do srovnání nepočítá.
 */
function excluded(a) { return a >= 0x0100 && a <= 0x01FF; }

/**
 * Registry VIC, které se nesrovnávají, a bity, které se z nich čtou jako 1.
 *
 * ★ `$D011` a `$D012` je rastr, `$D019` příznaky přerušení a `$D01E`/`$D01F`
 * kolize sprajtů, které se čtením nulují — všechno se mění mezi zastávkami
 * bez ohledu na stavitele. Zbytek se srovnává, ale s tím, že nepoužité bity
 * čte VIC jako jedničky: `$D016` horní dva, `$D018` spodní, `$D01A` horní
 * čtyři a všechny barvy `$D020`-`$D02E` horní čtyři.
 */
const vicSkip = new Set([0x11, 0x12, 0x19, 0x1E, 0x1F]);
function vicUnused(reg) {
  if (reg === 0x16) { return 0xC0; }
  if (reg === 0x18) { return 0x01; }
  if (reg === 0x1A || reg >= 0x20) { return 0xF0; }
  return 0x00;
}

let checks = 0, diffs = 0, rooms = 0;
for (const dir of dirs) {
for (let room = lo; room <= hi; room++) {
  const tag = `${dir}/r${String(room).padStart(2, '0')}`;
  if (!existsSync(`${tag}_post.bin`)) { continue; }
  rooms++;
  const m = {
    mem: new Uint8Array(readFileSync(`${tag}_pre.bin`)),
    color: new Uint8Array(readFileSync(`${tag}_pre_col.bin`)),
    vic: new Uint8Array(readFileSync(`${tag}_pre_vic.bin`)),
  };
  const want = {
    mem: new Uint8Array(readFileSync(`${tag}_post.bin`)),
    color: new Uint8Array(readFileSync(`${tag}_col.bin`)),
    vic: new Uint8Array(readFileSync(`${tag}_vic.bin`)),
  };
  const side = m.mem[0x7F];
  roomBuild.buildRoom(m, room, side);

  let bad = 0;
  for (let a = 0; a < 0x10000; a++) {
    if (excluded(a)) { continue; }
    checks++;
    if (m.mem[a] !== want.mem[a]) {
      diffs++; bad++;
      if (verbose && bad <= 12) {
        console.log(`  místnost ${room}: RAM $${a.toString(16).padStart(4, '0')} `
          + `${m.mem[a].toString(16)} != ${want.mem[a].toString(16)}`);
      }
    }
  }
  for (let a = 0; a < m.color.length; a++) {
    checks++;
    // ★ barevná paměť má jen spodní čtyři bity, horní čte VIC jako 1
    if (((m.color[a] ^ want.color[a]) & 0x0F) !== 0) {
      diffs++; bad++;
      if (verbose && bad <= 12) {
        console.log(`  místnost ${room}: barva $${(0xD800 + a).toString(16)} `
          + `${m.color[a] & 15} != ${want.color[a] & 15}`);
      }
    }
  }
  for (let a = 0; a < m.vic.length; a++) {
    if (vicSkip.has(a)) { continue; }
    checks++;
    if ((m.vic[a] | vicUnused(a)) !== (want.vic[a] | vicUnused(a))) {
      diffs++; bad++;
      if (verbose && bad <= 12) {
        console.log(`  místnost ${room}: VIC $${(0xD000 + a).toString(16)} `
          + `${m.vic[a].toString(16)} != ${want.vic[a].toString(16)}`);
      }
    }
  }
  if (bad && !verbose) { console.log(`  místnost ${room} (${dir}): ${bad} rozdílů`); }
}
}

if (!rooms) {
  console.error(`žádný záznam originálu v ${dirs.join(', ')}\n  ./tools/tracerooms.py`);
  process.exit(2);
}
console.log(`matchrooms: ${rooms} místností, ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
