#!/usr/bin/env node
/**
 * matchsecurity — **bezpečnostní terminál** přepsaný proti terminálu
 * originálu (`sources/docs/disasm_notes.md` §29).
 *
 * ★ **Snímek tu není jednotka.** `$9D14` udělá `SEI` a `CLI` přijde až na
 * `$9ED8`, takže po celou dobu terminálu neběží obsluha přerušení: `$E0`
 * stojí, hodiny stojí, roboti stojí. Jednotka je proto **průchod menu**,
 * jako u výtahu je jednotka krok (§20), a záznam se zastavuje tam, kde je
 * průchod hotový (`tools/tracesecurity.py`).
 *
 * Srovnává se po každé zastávce:
 *
 * - **obrazovka terminálu** `$4000`-`$43E7` a její barvy — rozbalená po délkách;
 * - **místnost schovaná pod ní** `$C100` a `$0400` — a lift reset do ní kreslí;
 * - **záznam místnosti**, jehož seznam výtahů lift reset vrací na začátek;
 * - **počitadla v panelu šachty**, ze kterých terminál ubírá;
 * - nultá stránka a **všechny registry VIC**, které terminál přenastaví
 *   a na konci vrátí.
 *
 *     ./tools/matchsecurity.mjs [--dir build/security] [--name termnone42]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/security');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                          import.meta.url).pathname);
for (const file of ['roomBuild', 'fortressGen', 'elevator', 'shaftBuild',
                    'transition', 'roomLift', 'furniture', 'terminal', 'pocketComputer', 'codeRoom', 'controlRoom',
                    'robots', 'orb', 'collision', 'death']) {
  loadClassicScript(new URL(`../app/${file}.js`, import.meta.url).pathname);
}
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
const player = loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
const terminal = globalThis.terminal;

/** nultá stránka, kterou terminál používá — a hodiny, které v něm **stojí** */
const WATCHED = [
  [0x10, 'kreslicí lo'], [0x11, 'kreslicí hi'],
  [0x14, 'barevná lo'], [0x15, 'barevná hi'],
  [0x43, 'smrt'], [0x47, 'snooze'],
  [0x7E, 'místnost'], [0x81, 'záznam lo'], [0x82, 'záznam hi'],
  [0x83, 'západka'], [0x84, 'barva dlaždice'],
  [0x8A, 'kurzor'], [0xDE, 'západka střelby'],
  [0xD1, 'snímky'], [0xD2, 'vteřiny'], [0xD3, 'minuty'], [0xD4, 'hodiny'],
  [0xE0, 'čítač snímků'], [0xE7, 'barva terminálu'], [0xE8, 'zásobník'],
];
/** bloky, které se srovnávají celé: (jméno v záznamu, adresa, popis, maska) */
const BLOCKS = [
  ['counters', 0x3430, 'počitadla', 0xFF],
  ['record', 0x1900, 'záznam místnosti', 0xFF],
  ['parked', 0xC100, 'schovaná místnost', 0xFF],
  // ★ barvy se srovnávají **jen po spodním půlbajtu**: barevná paměť má na
  // stroji čtyři bity a horní půlbajt je to, co zrovna zůstalo na sběrnici
  ['parkedColor', 0x0400, 'schované barvy', 0x0F],
  ['screen', 0x4000, 'obrazovka terminálu', 0xFF],
];

/**
 * ★ Co z registrů VIC se srovnávat nedá — tytéž výjimky jako u stavitele
 * místnosti (`tools/matchrooms.mjs`): rastr a přerušovací registry se
 * v modelu snímků nemají odkud vzít, kolize se čtením nulují, a **nepoužité
 * bity se na stroji čtou jako jedničky** (barvy horní čtyři, `$D011` sedmý
 * bit je devátý bit rastru).
 */
const vicSkip = new Set([0x12, 0x19, 0x1E, 0x1F]);
function vicUnused(reg) {
  if (reg === 0x11) { return 0x80; }
  if (reg === 0x16) { return 0xC0; }
  if (reg === 0x18) { return 0x01; }
  if (reg === 0x1A || reg >= 0x20) { return 0xF0; }
  return 0x00;
}

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));
const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, stops = 0;
/** ★ pokrytí: která rozhodnutí `$A0D1` a `$A194` se aspoň jednou udělala */
const seen = {open: 0, moveUp: 0, moveDown: 0, required: 0,
              snooze: 0, liftReset: 0, leave: 0, close: 0};

for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.frames || rec.frames.length < 3) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;
  m.noRobots = true;
  // ★ Nultá stránka se dosadí z **první zastávky**, jako to dělá každé
  // měřidlo tohohle projektu: `_ram.bin` je paměť **před** terminálem, ale
  // mezi ní a `$9E50` ještě proběhlo pár snímků hry (agent zabral nahoru,
  // `$97F1` našlo nábytek). Terminál si svoje bajty stejně přepíše sám.
  const first = bytes(rec.frames[0].zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = first[i]; }
  // ★ A **obraz místnosti, jak ho terminál zastihl**, se vezme z jeho
  // odložené kopie: `_ram.bin` je paměť před rozjezdem terminálu, ale mezi
  // ní a `$9E50` ještě proběhlo pár snímků hry — a `$9837 JSR $8727` v nich
  // přepsalo **ukazatele sprajtů** na `$43F8`. Odložená kopie je z definice
  // to, co tam bylo, když si terminál obrazovku bral.
  const parked0 = bytes(rec.frames[0].parked);
  for (let i = 0; i < parked0.length; i++) { m.mem[0x4000 + i] = parked0[i]; }
  const parkedColor0 = bytes(rec.frames[0].parkedColor);
  for (let i = 0; i < parkedColor0.length; i++) { m.color[i] = parkedColor0[i] & 0x0F; }

  // ★ páka po **průchodech menu**, ne po snímcích: skript je tabulka, kterou
  // si terminál indexuje vlastním počitadlem (`tracesecurity.py`)
  // ★ Latch `$D01E` se **vynuluje**: hodnota ve výpisu paměti je zbytek po
  // monitoru, ne to, co hra viděla (`app/collision.js`, §30).
  globalThis.collision.reset(m);

  const stick = [];
  for (const seg of rec.segments) {
    for (let i = 0; i < seg.steps; i++) { stick.push(parseInt(seg.value, 16)); }
  }

  let bad = 0, compared = 0, term = null, why = '';
  const counterAt = 0x0334 - 0x0320;
  /**
   * Jeden **průchod menu**, tedy jedna zastávka záznamu — a je v něm i
   * ★ **zdržení `$A1E5`**: rámeček s odpovědí drží na stroji 67 snímků
   * (`terminal.ANSWER_FRAMES`, §29), ve kterých se nic nečte a v paměti
   * nezůstane nic. Měřidlo je proto **dotočí na místě**, jako to dělá
   * `matchsound --effects` s obřadem umírání (§31); bez toho by zastávka
   * skončila uprostřed odpovědi, s rámečkem ještě na obrazovce.
   */
  const pass = (joy) => {
    terminal.frame(m, term, joy);
    let guard = terminal.ANSWER_FRAMES + 2;
    while (term.phase === 'answer' && guard-- > 0) { terminal.frame(m, term, joy); }
  };
  for (let f = 0; f < rec.frames.length; f++) {
    if (f === 0) {
      term = terminal.start();
      term.phase = 'open';
      terminal.frame(m, term, 0x7F);                 // `$9D09` → `$9E50`
      seen.open++;
    } else if (f === rec.frames.length - 1) {
      // ★ Poslední zastávka je `$9ED9`, ale **dostane se k ní průchodem**:
      // `$9F68` ještě jednou přečte střelbu, ta vybere odchod a `$A0DD`
      // vyskočí rovnou na `$9E53`. Proto se tu dělá celý průchod, ne jen
      // zavření — a počitadlo v záznamu už je o jedna dál.
      const step = bytes(rec.frames[f].harness)[counterAt];
      pass(stick[step] === undefined ? 0x7F : stick[step]);
      if (term.chose === 'leave') { seen.leave++; }
      seen.close++;
    } else {
      const step = bytes(rec.frames[f].harness)[counterAt];
      const joy = stick[step] === undefined ? 0x7F : stick[step];
      const before = m.mem[0x8A], chose = term.chose;
      pass(joy);
      if (m.mem[0x8A] < before) { seen.moveUp++; }
      if (m.mem[0x8A] > before) { seen.moveDown++; }
      if (term.chose !== chose && term.chose !== 'leave') { seen[term.chose]++; }
      else if (!(joy & 0x10) && before < 2 && m.mem[0x8A] === before) { seen.required++; }
    }
    const want = bytes(rec.frames[f].zp);
    const wantVic = bytes(rec.frames[f].vic);
    const wantColor = bytes(rec.frames[f].color);
    stops++; compared++;
    const say = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 4) {
        console.log(`  ${name} zastávka ${f}: ${what} přepis $${mine.toString(16)}`
          + ` != originál $${theirs.toString(16)}`);
      }
    };
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== want[addr]) { say(`${label} ($${addr.toString(16)})`, m.mem[addr], want[addr]); }
    }
    for (let reg = 0; reg < 0x2F; reg++) {
      if (vicSkip.has(reg)) { continue; }
      const mask = 0xFF & ~vicUnused(reg);
      checks++;
      if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
        say(`VIC $d0${reg.toString(16).padStart(2, '0')}`, m.vic[reg] & mask, wantVic[reg] & mask);
      }
    }
    for (let i = 0; i < wantColor.length; i++) {
      checks++;
      if ((m.color[i] & 0x0F) !== (wantColor[i] & 0x0F)) {
        say(`barva ${Math.floor(i / 40)}/${i % 40}`, m.color[i] & 0x0F, wantColor[i] & 0x0F);
      }
    }
    for (const [block, base, label, mask] of BLOCKS) {
      const wantBlock = bytes(rec.frames[f][block]);
      for (let i = 0; i < wantBlock.length; i++) {
        checks++;
        if ((m.mem[base + i] & mask) !== (wantBlock[i] & mask)) {
          say(`${label} $${(base + i).toString(16)}`, m.mem[base + i] & mask, wantBlock[i] & mask);
        }
      }
    }
    if (bad && !verbose) { why = 'rozdíl'; break; }
  }
  console.log(`  ${name}: ${compared} z ${rec.frames.length} zastávek, `
    + `skript ${rec.script}${rec.counters ? ', počitadla $' + rec.counters.toString(16) : ''}`
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchsecurity: ${records} záznamů, ${stops} zastávek, ${checks} kontrol, `
  + `${diffs} rozdílů`);
const missed = Object.keys(seen).filter((k) => !seen[k]);
console.log('  pokryto: ' + Object.keys(seen).map((k) => `${k} ${seen[k]}×`).join(', ')
  + (missed.length ? ` — NEVYZKOUŠENO: ${missed.join(', ')}` : ''));
process.exit(diffs ? 1 : 0);
