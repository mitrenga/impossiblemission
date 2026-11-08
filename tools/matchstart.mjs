#!/usr/bin/env node
/**
 * matchstart — rozběh hry v šachtě z přepisu proti originálu.
 *
 * ★ **Tohle je jediné měřidlo, které začíná tam, kde hra začíná.** Všechna
 * ostatní si berou výpis paměti z rozehrané hry, takže na `$3960`-`$3A15`
 * nedosáhnou — a právě tam se schovaly dvě vady, které nahlásil operátor
 * 2026-09-21: mapa pevnosti kreslená samými plnými čtverci (okno znakové
 * sady se nevyměnilo, `$B644`) a spodní panel, který se objevil dřív, než
 * domluvila úvodní řeč (`$72E5` je až na `$3A08`, §22).
 *
 * Vezme paměť originálu na každé zastávce `tools/tracestart.py`, pustí nad
 * ní **jednu rutinu přepisu** a srovná to, co ta rutina kreslí:
 *
 * | z čeho | co se pustí | proti čemu |
 * |---|---|---|
 * | `$39F1` | `shaftBuild.bottom` (`$731C`) | `$39F4` |
 * | `$39F4` | `shaftBuild.panel` (`$72E5`) | `$3A0B` |
 * | `$B644` | `pocketComputer.mapWindow` + `shaftBuild.map` + `mapMarker` | `$3A15` |
 *
 * ★ Prostřední dvojice přeskakuje řeč: mezi `$39F4` a `$3A0B` leží obě
 * věty, ale ty s obrazovkou nedělají nic, takže `$72E5` je jediné, co se
 * mezi nimi kreslí. A `$B644` je zvolené tak, aby mezi ním a `$3A15`
 * **nebylo čekání na snímek** — jinak by do srovnání mluvila obsluha
 * přerušení.
 *
 *     ./tools/matchstart.mjs [--dir build/start] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/start');
const verbose = args.includes('--verbose');

globalThis.self = globalThis;
for (const f of ['fortressGen.js', 'fortressMap.js', 'roomBuild.js', 'roomsLoader.js',
                 'collision.js', 'elevator.js', 'shaftBuild.js', 'pocketComputer.js',
                 'player.js']) {
  loadClassicScript(new URL('../app/' + f, import.meta.url).pathname);
}

const indexPath = `${dir}/start.json`;
if (!existsSync(indexPath)) {
  console.error(`chybí záznam originálu (${indexPath})\n  ./tools/tracestart.py`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const stops = {};
for (const s of index.stops) {
  stops[s.name] = {
    at: s.at,
    mem: new Uint8Array(readFileSync(s.ram)),
    color: new Uint8Array(readFileSync(s.color)).subarray(0, 0x400),
    vic: new Uint8Array(readFileSync(s.vic)).subarray(0, 0x2F)
  };
}

/**
 * Stroj z výpisu originálu — paměť, barvy i registry VIC tak, jak je hra
 * v té chvíli měla. Entropie je ta, se kterou záznam běžel.
 * @param {Object} stop - Zastávka.
 * @returns {Object} Stroj, jak ho čeká přepis.
 */
function machineOf(stop) {
  const m = {mem: Uint8Array.from(stop.mem), color: Uint8Array.from(stop.color),
             vic: Uint8Array.from(stop.vic)};
  const value = parseInt(index.entropy, 16);
  m.entropy = () => value;
  return m;
} // machineOf

/**
 * Co se po rutině srovnává: **obrazovka, barvy a to, na co ta rutina sahá**.
 * Čítače obsluhy přerušení v tom nejsou — ta běží i mezi zastávkami.
 */
const SCREEN = [0x4000, 0x43E7];
const AREAS = {
  bottom: [SCREEN, [0xEB, 0xEC]],
  panel: [SCREEN],
  map: [SCREEN, [0x43F8, 0x43FF], [0x4D80, 0x4DBF], [0x5C50, 0x5FAF],
        [0xC690, 0xC9EF], [0xFF30, 0xFF95]]
};
/** registry VIC, které ty rutiny sázejí (`$D011` rozsvěcí `$731C`) */
const VIC_REGS = {bottom: [0x11, 0x21, 0x22, 0x23], panel: [], map: [0x10, 0x1D, 0x0C, 0x0D, 0x2D]};

let checks = 0, diffs = 0;

/**
 * Jedno srovnání: z paměti `from` se pustí `run` a výsledek se měří proti `to`.
 * @param {string} what - Do hlášení.
 * @param {string} from - Jméno zastávky, ze které se vychází.
 * @param {string} to - Jméno zastávky, proti které se měří.
 * @param {string} kind - Klíč do `AREAS` a `VIC_REGS`.
 * @param {function(Object)} run - Přepis.
 */
function compare(what, from, to, kind, run) {
  const m = machineOf(stops[from]), want = stops[to];
  run(m);
  let bad = 0, count = 0;
  const say = (s) => { bad++; diffs++; if (verbose && bad <= 8) { console.log('  ' + s); } };
  for (const [lo, hi] of AREAS[kind]) {
    for (let a = lo; a <= hi; a++) {
      count++;
      if (m.mem[a] !== want.mem[a]) {
        say(`$${a.toString(16).toUpperCase()}: ${m.mem[a].toString(16)} != ${want.mem[a].toString(16)}`);
      }
    }
  }
  for (let i = 0; i < 1000; i++) {
    count++;
    if ((m.color[i] & 0x0F) !== (want.color[i] & 0x0F)) {
      say(`barva ${i}: ${m.color[i] & 15} != ${want.color[i] & 15}`);
    }
  }
  for (const r of VIC_REGS[kind]) {
    count++;
    // ★ nepoužité bity registrů VIC se čtou jako jedničky, takže se u barev
    // srovnává **půlbajt** — táž výhrada, kterou má `matchcomputer` (§34)
    const mask = r >= 0x20 ? 0x0F : 0xFF;
    if ((m.vic[r] & mask) !== (want.vic[r] & mask)) {
      say(`$D0${r.toString(16).padStart(2, '0')}: ${m.vic[r].toString(16)} != ${want.vic[r].toString(16)}`);
    }
  }
  checks += count;
  console.log(`${what}: ${count} kontrol, ${bad} rozdílů`);
} // compare

compare('$731C — šachta pod oknem', 'pre', 'bottom', 'bottom',
        (m) => globalThis.shaftBuild.bottom(m, m.entropy));
compare('$72E5 — spodní panel za řečí', 'bottom', 'panel', 'panel',
        (m) => globalThis.shaftBuild.panel(m));
compare('$B63B — okno sady, mapa a značka', 'window', 'map', 'map', (m) => {
  globalThis.pocketComputer.mapWindow(m);
  globalThis.shaftBuild.map(m);
  globalThis.pocketComputer.mapMarker(m);
});

console.log(`matchstart: ${index.stops.length} zastávek, ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
