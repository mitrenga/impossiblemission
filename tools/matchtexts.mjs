#!/usr/bin/env node
/**
 * matchtexts — texty z dat proti paměti běžícího originálu a proti sadám.
 *
 * `data/texts.json` vzniká staticky z rozbaleného obrazu
 * (`tools/dumptexts.py`; délka řádku i počet řádků plynou z tiskáren
 * v kódu, `sources/docs/disasm_notes.md` §16). Nástroj ukazuje tři věci:
 *
 * 1. **bajty** všech bloků — textů i tabulek barev, které k nim tiskárny
 *    kopírují — proti paměti stroje ve výtahu i v místnosti; texty jsou
 *    statická data programu a v obou stavech musí sedět;
 * 2. **kódování tam a zpátky**: přečtený text se znovu složí na screen
 *    codes a musí dát tytéž bajty;
 * 3. ★ **texty proti znakovým sadám**: každé písmeno a číslice musí mít
 *    ve své sadě (`data/charset_shaft.json`, `data/charset_computer.json`,
 *    po záplatě z Char ROM podle §14) glyf, který se shoduje s Char ROM
 *    stroje. Tím drží §16 na §14: text se čte proto, že tam ta písmena
 *    opravdu jsou.
 *
 *     ./tools/matchtexts.mjs [--dir build/screen] [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/screen');
const verbose = args.includes('--verbose');

const CHAR_ROM = 'sources/rom/characters.901225-01.bin';
const ROM_LETTER = 1;       // znak 1 = "A"
const ROM_DIGIT = 0x30;     // znak $30 = "0"
const SETS = { shaft: 'data/charset_shaft.json', computer: 'data/charset_computer.json' };

const data = JSON.parse(readFileSync('data/texts.json', 'utf8'));
const code = (key) => parseInt(key.slice(1), 16);

let checks = 0, diffs = 0;

/**
 * Text zpátky na screen codes té sady, ze které se četl.
 * @param {string} text - Přečtený řádek, `{XX}` je syrový bajt.
 * @param {string} charset - `shaft` nebo `computer`.
 * @returns {number[]} Screen codes.
 */
function encode(text, charset) {
  const cs = data.charsets[charset];
  const punct = new Map(Object.entries(cs.punct).map(([k, v]) => [v, code(k)]));
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    } else if (ch === ' ') { out.push(code(cs.space)); }
    else if (ch >= 'a' && ch <= 'z') { out.push(code(cs.a) + ch.charCodeAt(0) - 97); }
    else if (ch >= '0' && ch <= '9') { out.push(code(cs.zero) + ch.charCodeAt(0) - 48); }
    else if (punct.has(ch)) { out.push(punct.get(ch)); }
    else { out.push(-1); }
  }
  return out;
}

const dumps = [['výtah', `${dir}/elevator_ram.bin`], ['místnost', `${dir}/room_ram.bin`]];
for (const [, path] of dumps) {
  if (!existsSync(path)) {
    console.error(`chybí paměť originálu v ${dir}\n  ./tools/mkscreen.py --name elevator`);
    process.exit(2);
  }
}

// --- 1. bajty proti paměti stroje -----------------------------------------
for (const [what, path] of dumps) {
  const ram = new Uint8Array(readFileSync(path));
  let bad = 0, count = 0, colorCount = 0;
  const span = (from, bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      checks++;
      if (bytes[i] !== ram[from + i]) {
        bad++; diffs++;
        if (verbose && bad <= 8) {
          console.log(`  ${what}: $${(from + i).toString(16)} `
            + `${bytes[i].toString(16)} != ${ram[from + i].toString(16)}`);
        }
      }
    }
  };
  for (const block of data.blocks) {
    for (const line of block.lines) {
      span(code(line.addr), line.codes);
      count += line.codes.length;
    }
    if (block.colors) {                       // tabulka barev vedle textu
      span(code(block.colors.addr), block.colors.bytes);
      colorCount += block.colors.bytes.length;
    }
  }
  console.log(`texty v paměti stroje (${what}): ${count} bajtů textu `
    + `a ${colorCount} bajtů barev, ${bad} rozdílů`);
}

// --- 2. kódování tam a zpátky ---------------------------------------------
let backBad = 0, backCount = 0;
for (const block of data.blocks) {
  for (const line of block.lines) {
    const again = encode(line.text, block.charset);
    checks++; backCount++;
    if (again.length !== line.codes.length
        || again.some((c, i) => c !== line.codes[i])) {
      backBad++; diffs++;
      if (verbose) { console.log(`  ${line.addr}: |${line.text}| se nesloží zpátky`); }
    }
  }
}
console.log(`kódování tam a zpátky: ${backCount} řádků, ${backBad} rozdílů`);

// --- 3. písmena proti znakovým sadám --------------------------------------
// ★ Sady si písmena kopírují z Char ROM (§14), takže glyf pod screen codem
// písmene se musí rovnat glyfu toho písmene v ROM stroje.
if (existsSync(CHAR_ROM)) {
  const rom = new Uint8Array(readFileSync(CHAR_ROM));
  const glyphs = {};
  for (const [name, file] of Object.entries(SETS)) {
    if (!existsSync(file)) { continue; }
    const set = JSON.parse(readFileSync(file, 'utf8'));
    const bytes = Uint8Array.from(set.bytes);
    for (const part of set.charRom.parts) {        // záplata z Char ROM
      bytes.set(Uint8Array.from(part.bytes), part.addr - set.addr);
    }
    glyphs[name] = bytes;
  }
  let glyphBad = 0, glyphCount = 0;
  for (const block of data.blocks) {
    const bytes = glyphs[block.charset];
    if (!bytes) { continue; }
    const cs = data.charsets[block.charset];
    for (const line of block.lines) {
      for (let i = 0; i < line.codes.length; i++) {
        const c = line.codes[i];
        let romCode = null;
        if (c >= code(cs.a) && c < code(cs.a) + 26) { romCode = ROM_LETTER + c - code(cs.a); }
        else if (c >= code(cs.zero) && c < code(cs.zero) + 10) {
          romCode = ROM_DIGIT + c - code(cs.zero);
        }
        if (romCode === null) { continue; }
        for (let y = 0; y < 8; y++) {
          checks++; glyphCount++;
          if (bytes[c*8 + y] !== rom[romCode*8 + y]) {
            glyphBad++; diffs++;
            if (verbose && glyphBad <= 8) {
              console.log(`  ${line.addr}: glyf $${c.toString(16)} není znak z Char ROM`);
            }
          }
        }
      }
    }
  }
  console.log(`písmena textů proti sadám a Char ROM: ${glyphCount} bajtů glyfů, `
    + `${glyphBad} rozdílů`);
}

console.log(`matchtexts: ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
