#!/usr/bin/env node
/**
 * matchrobots — roboti přepsaní proti robotům originálu.
 *
 * Akceptace M4 (`MILNIKY.md`): robot se nechová „podobně", běží **programem
 * z originálu** (`app/robots.js`, `sources/docs/disasm_notes.md` §24). Tvar
 * důkazu je týž jako u agenta, jen se srovnává víc: robot totiž **nemá stav
 * v nulté stránce celý** — jeho poloha leží rovnou v registrech VIC a jeho
 * vzhled v ukazatelích sprajtů `$43FC`–`$43FF`.
 *
 * Záznam proto vzniká `traceplayer.py --robots`, který navíc vypisuje VIC
 * a širší pásmo ukazatelů; a protože v něm běží i agent, pouští se tady
 * **celý `player.frame`** — roboti jsou v něm, protože v originálu je pouští
 * obsluha přerušení (`$832A`), ne smyčka.
 *
 *     ./tools/matchrobots.mjs [--dir build/robots] [--name robidle42] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/robots');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

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

/** co si robot vede v nulté stránce (§24) */
const WATCHED = [
  [0x44, 'tik robotů'], [0x47, 'snooze'], [0x48, 'pořadí'], [0x49, 'dvojnásobek'],
  [0x4A, 'hlas 2'], [0x4D, 'scratch'], [0x4E, 'zvuk'], [0x4F, 'hlas 3'],
  [0x54, 'poslední robot'],
  // ★ a **koule**, která je druhý program a jiný (§24): jestli ji místnost má
  // (`$6D`), kde je ve skriptu `$2232` (`$6E`), kolik jí zbývá do cíle
  // (`$6F`), jak dlouho ještě čeká (`$70`) a spodní hrana (`$71`)
  [0x6D, 'koule je'], [0x6E, 'koule skript'], [0x6F, 'koule zbývá'],
  [0x70, 'koule čeká'], [0x71, 'koule hrana'],
];
/** a šest bajtů na každého ze čtyř robotů, od `$55` po šesti */
for (let r = 0; r < 4; r++) {
  const b = 0x55 + r*6;
  WATCHED.push([b, `robot ${r} program`], [b + 1, `robot ${r} příznaky`],
               [b + 2, `robot ${r} instrukce`], [b + 3, `robot ${r} adresa lo`],
               [b + 4, `robot ${r} adresa hi`], [b + 5, `robot ${r} podsloupec`]);
}
/** registry VIC, ve kterých robot doopravdy je */
const VIC = [[0x10, 'devátý bit x'], [0x15, 'svítí'], [0x1C, 'multicolor'],
             [0x1D, 'široké'], [0x17, 'vysoké']];
for (let i = 4; i < 8; i++) {
  VIC.push([i*2, `robot ${i - 4} x`], [i*2 + 1, `robot ${i - 4} y`],
           [0x27 + i, `robot ${i - 4} barva`]);
}
/** a sprajt 0, který si robot půjčuje na blesk (`$8F89`) */
VIC.push([0x00, 'blesk x'], [0x01, 'blesk y'], [0x27, 'blesk barva']);

const POINTERS = 0x43F8;
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, frames = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.frames || rec.frames.length < 2) { console.log(`${name}: prázdný záznam`); continue; }
  if (!rec.frames[0].vic) { console.log(`${name}: záznam nemá VIC — natoč ho s --robots`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;

  let begin = 0;
  while (begin + 1 < rec.frames.length
         && bytes(rec.frames[begin].harness)[0x13] !== 1) { begin++; }
  const first = bytes(rec.frames[begin].zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
  const firstPtr = bytes(rec.frames[begin].ptr);
  for (let i = 0; i < firstPtr.length; i++) { m.mem[POINTERS + i] = firstPtr[i]; }
  const firstVic = bytes(rec.frames[begin].vic);
  for (let i = 0; i < firstVic.length; i++) { m.vic[i] = firstVic[i]; }

  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.frames; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, compared = 0, overrun = 0, died = 0;
  for (let f = begin; !overrun && f + 1 < rec.frames.length; f++) {
    const passes = bytes(rec.frames[f + 1].harness)[0x13];
    const out = player.frame(m, stick[f] === undefined ? 0x7F : stick[f], passes);
    if (passes !== 1 && !out.moving) { overrun = f + 1; break; }
    if (out.transition || out.moving || out.searched || out.computer
        || out.lift) { break; }
    // ★ Kolize sprajtů (`$94FA`) a umírání (`$95DA`) přepsané nejsou, takže
    // jakmile originál agenta zabije (`$43` ≠ 0), měří se dál nemá co —
    // roboti od té chvíle běží proti jinému světu. Záznam se uzavře a kolik
    // snímků dal, je vidět.
    // ★ Od 2026-09-20 **kolize i umírání přepsané jsou** (§30, §31), takže
    // agent umře i tady — jenže obřad na stroji proběhne **mezi dvěma
    // snímky** (drží v něm `SEI`), kdežto model ho krájí na 33 (`ZADANI.md`
    // §10.12). Od smrti dál tedy záznam a přepis počítají snímky jinak
    // a srovnávat je nemá smysl; měří to `tools/matchdeath.mjs`, který má
    // jednotku po zastávkách.
    const want43 = bytes(rec.frames[f + 1].zp);
    if (want43[0x43] || m.mem[0x43]) { died = f + 1; break; }
    // ★ **Na `$47` tu zarážka nestojí.** Stála, s odůvodněním „blesk agenta
    // omráčí" — jenže takový kód v originálu **není**: do `$47` píšou čtyři
    // místa (`$95C6`, `$96C1`, `$A0E4`, `$A24A`) a všechna jsou přepsaná.
    // Co vypadalo jako omráčení, byl odchod z místnosti — a na ten se
    // zastavuje řádek výš.
    frames++; compared++;
    const wantZp = bytes(rec.frames[f + 1].zp);
    const wantVic = bytes(rec.frames[f + 1].vic);
    const wantPtr = bytes(rec.frames[f + 1].ptr);
    const report = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} snímek ${f + 1}: ${what} přepis $${mine.toString(16)} `
          + `!= originál $${theirs.toString(16)}`);
      }
    };
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== wantZp[addr]) { report(`${label} ($${addr.toString(16)})`, m.mem[addr], wantZp[addr]); }
    }
    for (const [reg, label] of VIC) {
      checks++;
      const mask = (reg >= 0x20) ? 0x0F : 0xFF;
      if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
        report(`${label} ($d0${reg.toString(16).padStart(2, '0')})`,
               m.vic[reg] & mask, wantVic[reg] & mask);
      }
    }
    for (let i = 4; i < 8; i++) {
      checks++;
      if (m.mem[POINTERS + i] !== wantPtr[i]) {
        report(`ukazatel robota ${i - 4}`, m.mem[POINTERS + i], wantPtr[i]);
      }
    }
    if (bad && !verbose) { break; }
  }
  console.log(`  ${name}: ${compared} z ${rec.frames.length - 1 - begin} snímků`
    + (overrun ? `, od snímku ${overrun} originál smyčku nestíhá` : '')
    + (died ? `, na snímku ${died} agent umřel — dál měří matchdeath` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchrobots: ${records} záznamů, ${frames} snímků, ${checks} kontrol, `
  + `${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
