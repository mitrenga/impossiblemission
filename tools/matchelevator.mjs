#!/usr/bin/env node
/**
 * matchelevator — jízda výtahem přepsaná proti jízdě výtahem originálu.
 *
 * Akceptace M3 (`MILNIKY.md`): výtah nejede „podobně", jede **kódem
 * originálu** (`app/elevator.js`, `sources/docs/disasm_notes.md` §20). Důkaz
 * má stejný tvar jako u agenta: vezme se paměť stroje v okamžiku, kdy záznam
 * začíná, dosadí se do ní nultá stránka, okno šachty a jeho barvy z prvního
 * kroku, a pak se **krok po kroku** pouští přepis a srovnává se s tím, co měl
 * originál (`tools/traceelevator.py`).
 *
 * ★ Jednotka není snímek, je to **krok výtahu** — a `traceelevator` ho
 * zastavuje přesně tam, kde je hotový (`$8587` nahoru, `$85AA` dolů), takže
 * se neměří nic rozdělaného. Kolik snímků krok zabral, je v záznamu taky
 * (`$0323`), a nástroj to kontroluje: má to být **dva**.
 *
 * Srovnává se **celé okno šachty** — 600 znaků obrazovky a 600 nibblů
 * barvy — protože jeden krok na ně sahá celé, dál nultá stránka, kterou si
 * výtah vede, sprajt kabiny v registrech VIC a stopa kabiny na mapě
 * pevnosti (`$FF30`).
 *
 *     ./tools/matchelevator.mjs [--dir build/elevator] [--name down42] [--verbose]
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/elevator');
const verbose = args.includes('--verbose');
const only = args.indexOf('--name') >= 0 ? [at('--name', '')] : null;

globalThis.self = globalThis;
loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/roomBuild.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
const elevator = loadClassicScript(new URL('../app/elevator.js', import.meta.url).pathname);

/** co si výtah vede v nulté stránce a jak se to jmenuje v §20 */
const WATCHED = [
  [0x10, 'cíl lo'], [0x11, 'cíl hi'], [0x12, 'zdroj lo'], [0x13, 'zdroj hi'],
  [0x14, 'barva cíl lo'], [0x15, 'barva cíl hi'], [0x16, 'barva zdroj lo'],
  [0x17, 'barva zdroj hi'], [0x18, 'obrázek lo'], [0x19, 'obrázek hi'],
  [0x1B, 'lano'], [0x1C, 'podřádek'], [0x1D, 'nahoře'], [0x1E, 'dole'],
  [0x1F, 'dveře vpravo'], [0x20, 'dveře vlevo'],
  [0x23, 'barva vpravo'], [0x24, 'barva vlevo'],
  [0x25, 'tón 1'], [0x26, 'tón 2'], [0x27, 'kabina x'], [0x28, 'kabina y'],
  [0xE4, 'E4'], [0xE5, 'E5'], [0xE6, 'E6'], [0xE8, 'E8'],
  [0xEB, 'míchačka lo'], [0xEC, 'míchačka hi'],
];
/**
 * ★ `$E9` se nesrovnává: je to **odložený registr `Y`** (`$787F` ho uloží
 * a hned vrátí), ne stav výtahu. Přepis registry nemodeluje, takže by to
 * bylo měření něčeho, co v přepisu neexistuje.
 */
const SPRITE6 = [[0x0C, 'sprajt 6 x', 0xFF], [0x0D, 'sprajt 6 y', 0xFF],
                 // ★ barevné registry VIC se čtou s horními čtyřmi bity v jedné
                 [0x2D, 'sprajt 6 barva', 0x0F]];

const SCREEN = 0x4000, SCREEN_LEN = 0x260;      // řádky 0-14
const COLOR = 0xD800, COLOR_LEN = 0x260;
const MARKS = 0xFF30, MARKS_LEN = 0x60;
const FRAMES_PER_STEP = 2;

const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

const names = only || readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

let checks = 0, diffs = 0, records = 0, steps = 0, cadence = 0;
for (const name of names) {
  const index = `${dir}/${name}.json`;
  if (!existsSync(index)) { console.log(`chybí ${index}`); continue; }
  const rec = JSON.parse(readFileSync(index, 'utf8'));
  if (!rec.steps || rec.steps.length < 2) { console.log(`${name}: prázdný záznam`); continue; }
  records++;

  const m = {mem: new Uint8Array(readFileSync(`${dir}/${name}_ram.bin`)),
             color: new Uint8Array(readFileSync(`${dir}/${name}_color.bin`)),
             vic: new Uint8Array(readFileSync(`${dir}/${name}_vic.bin`).subarray(0, 0x2F))};
  // ★ Entropie: originál mísí rastrový řádek, záznam má na `$82E3`
  // dosazený pevný bajt (§8) — tak ať ho přepis dostane taky.
  const entropy = parseInt(rec.entropy, 16);
  m.entropy = () => entropy;

  const first = rec.steps[0];
  const zp = bytes(first.zp);
  for (let i = 0; i < 0x100; i++) { m.mem[i] = zp[i]; }
  const screen = bytes(first.screen);
  for (let i = 0; i < SCREEN_LEN; i++) { m.mem[SCREEN + i] = screen[i]; }
  const colour = bytes(first.color);
  for (let i = 0; i < COLOR_LEN; i++) { m.color[i] = colour[i] & 0x0F; }
  const marks = bytes(first.marks);
  for (let i = 0; i < MARKS_LEN; i++) { m.mem[MARKS + i] = marks[i]; }
  const vic = bytes(first.vic);
  for (let i = 0; i < vic.length; i++) { m.vic[i] = vic[i]; }

  let bad = 0, compared = 0, badCadence = 0;
  for (let s = 1; s < rec.steps.length; s++) {
    const want = rec.steps[s];
    const harness = bytes(want.harness), before = bytes(rec.steps[s - 1].harness);
    // `$3A8E` / `$3AAE`: mezi dvěma kroky se překreslí kabina na mapě. ★ Barva
    // sprajtu 6 bliká podle **čítače snímků** `$E0`, který vede obsluha
    // přerušení, ne výtah — a ta tady neběží, takže se dosadí ze záznamu
    // (měří ji `matchplayer`). Je to jediný vstup kroku zvenčí, a harness
    // ho odečítá **přesně v tom okamžiku**, ne z výpisu vedle.
    m.mem[0xE0] = harness[4];
    elevator.cabin(m);
    const moved = harness[0] === 1 ? elevator.up(m, m.entropy)
                                   : elevator.down(m, m.entropy);
    checks++;
    if (!moved) {
      diffs++; bad++;
      console.log(`  ${name} krok ${s}: přepis stojí, originál jel`);
      break;
    }
    // ★ kadence: krok výtahu jsou dva snímky
    checks++;
    const took = (harness[3] - before[3]) & 0xFF;
    if (took !== FRAMES_PER_STEP) { badCadence++; diffs++; bad++; }

    steps++; compared++;
    const report = (what, mine, theirs) => {
      diffs++; bad++;
      if (verbose || bad <= 3) {
        console.log(`  ${name} krok ${s}: ${what} přepis $${mine.toString(16)} `
          + `!= originál $${theirs.toString(16)}`);
      }
    };
    const wantZp = bytes(want.zp);
    for (const [addr, label] of WATCHED) {
      checks++;
      if (m.mem[addr] !== wantZp[addr]) { report(`${label} ($${addr.toString(16)})`, m.mem[addr], wantZp[addr]); }
    }
    const wantScreen = bytes(want.screen);
    for (let i = 0; i < SCREEN_LEN; i++) {
      checks++;
      if (m.mem[SCREEN + i] !== wantScreen[i]) {
        report(`obrazovka $${(SCREEN + i).toString(16)}`, m.mem[SCREEN + i], wantScreen[i]);
      }
    }
    const wantColour = bytes(want.color);
    for (let i = 0; i < COLOR_LEN; i++) {
      checks++;
      if ((m.color[i] & 0x0F) !== (wantColour[i] & 0x0F)) {
        report(`barva $${(COLOR + i).toString(16)}`, m.color[i] & 15, wantColour[i] & 15);
      }
    }
    const wantMarks = bytes(want.marks);
    for (let i = 0; i < MARKS_LEN; i++) {
      checks++;
      if (m.mem[MARKS + i] !== wantMarks[i]) {
        report(`mapa $${(MARKS + i).toString(16)}`, m.mem[MARKS + i], wantMarks[i]);
      }
    }
    const wantVic = bytes(want.vic);
    for (const [reg, label, mask] of SPRITE6) {
      checks++;
      if ((m.vic[reg] & mask) !== (wantVic[reg] & mask)) {
        report(label, m.vic[reg] & mask, wantVic[reg] & mask);
      }
    }
    if (bad && !verbose) { break; }
  }
  cadence += badCadence;
  console.log(`  ${name}: ${compared} z ${rec.steps.length - 1} kroků, ${rec.script}`
    + (rec.lead ? ` po rozjezdu ${rec.lead}` : '')
    + (badCadence ? `, ${badCadence} kroků nemělo dva snímky` : '')
    + (bad ? `, ${bad} rozdílů` : ''));
}

console.log(`matchelevator: ${records} záznamů, ${steps} kroků, ${checks} kontrol, `
  + `${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
