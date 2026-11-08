#!/usr/bin/env node
/**
 * scancoverage — co záznamy doopravdy pokrývají.
 *
 * ★ **Nula rozdílů dokazuje jen to, co se v záznamu stalo.** U agenta to
 * ještě jde přehlédnout — stavů je osmadvacet a chodí se jimi pořád — ale
 * u robotů je program **losovaný** a v jedné místnosti se nikdy neprovedou
 * všechny instrukce. Tenhle nástroj proto neměří shodu; měří **pokrytí**:
 * projde záznamy, pustí přes ně přepis a počítá, která instrukce robota
 * a který stav agenta se aspoň jednou provedl.
 *
 *     ./tools/scancoverage.mjs [--dir build/robots] [--nocollision]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
// ★ Od 2026-09-20 se čte i `build/collision`: kolize v záznamech robotů
// některé běhy ukončí dřív (agent umře), takže by se bez těch delších
// nepokryla instrukce „otočka".
const dirs = [at('--dir', 'build/robots'), at('--also', 'build/player'), 'build/collision'];

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const f of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild', 'transition',
                 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom', 'robots', 'orb', 'collision',
                 'death']) {
  loadClassicScript(new URL(`../app/${f}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

/** jak se instrukce robota jmenuje podle svých bitů (§24) */
function opName(a) {
  if (!(a & 0x80)) { return 'pohyb'; }
  if (a & 0x40) { return 'skok'; }
  if (a & 0x20) { return 'čekání na kouli'; }
  if (!(a & 0x10)) { return 'otočka'; }
  if (a & 0x08) { return 'hledání'; }
  if (!(a & 0x04)) { return 'rychlost'; }
  return 'výstřel';
}

const ops = new Map(), states = new Set(), places = new Set();
let records = 0, frames = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) { continue; }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    if (!rec.frames || rec.frames.length < 2) { continue; }
    const name = file.replace(/\.json$/, '');
    records++;
    const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
               color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
               vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
    m.entropy = () => parseInt(rec.entropy, 16);
    m.noRobots = !rec.robots;
    // ★ `--nocollision` je **měřicí přepínač, ne záplata**: instrukce robota
    // „otočka" se v záznamech provede jen dvakrát na 7 500 snímků, a pokaždé
    // později, než kde agent umře na kolizi. Dokud není přepsané `$95DA`
    // (po kterém hra pokračuje), dá se ta jedna instrukce ukázat jen takhle
    // — s ním je pokrytí 7 ze 7, bez něj 6 (`ZADANI.md` §10.11).
    if (process.argv.includes('--nocollision')) { m.noCollision = true; }
    const zp = bytes(rec.frames[0].zp);
    for (let i = 0; i < 0x100; i++) { m.mem[i] = zp[i]; }
    // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
    for (const seg of rec.segments) {
      for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
    }
    const lastPc = {};
    for (let f = 0; f + 1 < rec.frames.length; f++) {
      const passes = bytes(rec.frames[f + 1].harness)[0x13];
      const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
      if (passes !== 1 && !out.moving) { break; }
      if ((out.transition && !out.moving) || out.searched || out.computer || out.lift) { break; }
      frames++;
      states.add(m.mem[0x3F]);
      places.add(m.mem[0x1A]);
      // ★ Počítat, co je **rozdělané** v `$57,X`, by nestačilo: skok, otočka
      // ani rychlost tam nezůstanou ani snímek (§24). Sleduje se proto, jak
      // se posunul čítač programu `$55,X` — každý bajt, přes který přešel,
      // se provedl.
      if (!m.noRobots && m.mem[0x1A]) {
        for (let r = 0; r <= (m.mem[0x54] & 0x7F); r += 6) {
          const pc = m.mem[0x55 + r], was = lastPc[r];
          if (was !== undefined && pc !== was) {
            let step = (pc - was) & 0xFF;
            if (step > 8) { step = 1; }               // skok dozadu: jen ten jeden
            for (let i = 0; i < step; i++) {
              const op = m.mem[0x2112 + ((was + i) & 0xFF)];
              ops.set(opName(op), (ops.get(opName(op)) || 0) + 1);
            }
          }
          lastPc[r] = pc;
          // ★ a instrukce, která se **drží** (čekání na kouli), se přes čítač
          // nepozná — ta se počítá z `$57,X`
          const held = m.mem[0x57 + r];
          if (held !== 0xFF) { ops.set(opName(held), (ops.get(opName(held)) || 0) + 1); }
        }
      }
    }
  }
}

const ALL_OPS = ['pohyb', 'skok', 'čekání na kouli', 'otočka', 'hledání',
                 'rychlost', 'výstřel'];
console.log(`scancoverage: ${records} záznamů, ${frames} snímků`);
console.log(`  místa (\$1A): ${[...places].sort().map((p) => '$' + p.toString(16)).join(' ')}`);
console.log(`  stavy agenta (\$3F): ${states.size} z 28`);
let missing = 0;
for (const op of ALL_OPS) {
  const n = ops.get(op) || 0;
  if (!n) { missing++; }
  console.log(`  instrukce robota „${op}": ${n ? n + '×' : '**nikdy**'}`);
}
console.log(`scancoverage: ${ALL_OPS.length - missing} ze ${ALL_OPS.length} instrukcí robota `
  + `pokryto, ${states.size} z 28 stavů agenta`);
