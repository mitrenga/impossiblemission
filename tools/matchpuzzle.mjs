#!/usr/bin/env node
/**
 * matchpuzzle — skládačka z dat proti tomu, co spočítá originál.
 *
 * `data/puzzle.json` vzniká staticky z rozbaleného obrazu
 * (`tools/dumppuzzle.py`; hranice tabulek a násobek 144 jsou odečtené
 * z kódu, `sources/docs/disasm_notes.md` §15). Tenhle nástroj ukazuje čtyři
 * věci, a tu hlavní **proti obrázkům, které postavil sám originál**:
 *
 * 1. **statická data** — 16 tvarů, 16 dlaždic, 8 hesel a 4 hlášky proti
 *    paměti stroje;
 * 2. ★ **skládání dílku**: pro všech **36 vylosovaných dílků** se z dat
 *    složí obrázek pravidlem `$9C3A` a porovná se s tím, co má stroj
 *    v `$5000` po jediném `JSR $9C3A` (`tools/tracepuzzle.py`);
 * 3. ★ **devět karet**: každá osmice v `$C9F0` musí být jedna z 16 dlaždic
 *    a na kartě musí sedět rámeček `$B12D` — tím padá čtení §9, že je
 *    `$C9F0` mřížka pevnosti;
 * 4. **vylosované heslo** na `$4FB5` musí být jedno z osmi (§14).
 *
 *     ./tools/matchpuzzle.mjs [--dir build/puzzle] [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/puzzle');
const verbose = args.includes('--verbose');

const data = JSON.parse(readFileSync('data/puzzle.json', 'utf8'));
const { columns, glyphRows, bytes: SIZE } = data.geometry;
const BAND = columns*8;
const addr = (key) => parseInt(key.slice(1), 16);
const SCRATCH = addr(data.build.scratch);
const CARDS = addr(data.cards.addr);
const RECORDS = addr(data.records.addr);
const PASSWORD_AT = 0x4FB5;          // §14 — vylosované heslo přes prázdné glyfy

let checks = 0, diffs = 0;

/**
 * Rámeček `$B12D`: vodorovná čára navrch, svislé okraje ve všech třech
 * řádcích glyfů a spodek, který kartu zkrátí na 21 pixelů.
 * @param {Uint8Array} block - 144 bajtů, přepisuje se na místě.
 * @returns {Uint8Array} Týž blok.
 */
function frame(block) {
  for (let off = 0; off < BAND; off += 8) { block[off] = 0xFF; }
  for (let band = 0; band < glyphRows; band++) {
    const base = band*BAND;
    for (let y = 0; y < 8; y++) {
      block[base + y] |= 0xC0;
      block[base + 0x28 + y] |= 0x03;
    }
  }
  const base = (glyphRows - 1)*BAND;
  for (let y = BAND - 1; y >= 0; y -= 8) {
    block[base + y] = 0; block[base + y - 1] = 0; block[base + y - 2] = 0;
    block[base + y - 3] = 0xFF;
  }
  return block;
}

/**
 * Srovnání kusu dat s pamětí stroje.
 * @param {string} what - Co se srovnává, do hlášení.
 * @param {number[]|Uint8Array} want - Bajty z dat.
 * @param {Uint8Array} ram - Paměť stroje.
 * @param {number} from - Adresa, na které to v paměti začíná.
 */
function compare(what, want, ram, from) {
  let bad = 0;
  for (let i = 0; i < want.length; i++) {
    checks++;
    if (want[i] !== ram[from + i]) {
      bad++; diffs++;
      if (verbose && bad <= 8) {
        console.log(`  ${what}: $${(from + i).toString(16)} `
          + `${want[i].toString(16)} != ${ram[from + i].toString(16)}`);
      }
    }
  }
  console.log(`${what}: ${want.length} bajtů, ${bad} rozdílů`);
}

const memPath = `${dir}/mem.bin`;
if (!existsSync(memPath)) {
  console.error(`chybí paměť originálu v ${dir}\n  ./tools/tracepuzzle.py`);
  process.exit(2);
}
const mem = new Uint8Array(readFileSync(memPath));

// --- 1. statická data ------------------------------------------------------
const shapeBytes = [];
for (const shape of data.shapes) { shapeBytes.push(Uint8Array.from(shape.bytes)); }
compare('16 tvarů dílku', data.shapes.flatMap((s) => s.bytes), mem, addr(data.shapes[0].addr));
compare('16 dlaždic karet', data.tiles.list.flatMap((t) => t.bytes), mem,
  addr(data.tiles.list[0].addr));
compare('8 hesel', data.passwords.flatMap((p) => p.codes), mem, addr(data.passwords[0].addr));
compare('4 hlášky počítače', data.texts.list.flatMap((t) => t.codes), mem,
  addr(data.texts.list[0].addr));

// --- 2. skládání dílku -----------------------------------------------------
// ★ `$9C3A`: `(tvarA ^ invA) & karta & (tvarB ^ invB)`, pak rámeček. Masky
// jsou **spodní dva bity čtvrtého bajtu** záznamu — bit 1 na tvar A, bit 0
// na tvar B (`$9C42`-`$9C51` si jimi přepíše dvě `LDA #`).
let pieceBad = 0, pieceCount = 0, missing = 0;
for (let piece = 0; piece < data.records.count; piece++) {
  const rec = mem.subarray(RECORDS + piece*4, RECORDS + piece*4 + 4);
  const path = `${dir}/p${String(piece).padStart(2, '0')}.bin`;
  if (!existsSync(path)) { missing++; continue; }
  const dump = new Uint8Array(readFileSync(path));
  const from = SCRATCH - 0x4F00;          // tracepuzzle ukládá $4F00-$5FFF
  const card = mem.subarray(CARDS + rec[0]*SIZE, CARDS + rec[0]*SIZE + SIZE);
  const a = shapeBytes[rec[1]], b = shapeBytes[rec[2]];
  const invA = (rec[3] & 2) ? 0xFF : 0, invB = (rec[3] & 1) ? 0xFF : 0;
  const want = new Uint8Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    want[i] = ((b[i] ^ invB) & ((a[i] ^ invA) & card[i])) & 0xFF;
  }
  frame(want);
  for (let i = 0; i < SIZE; i++) {
    checks++; pieceCount++;
    if (want[i] !== dump[from + i]) {
      pieceBad++; diffs++;
      if (verbose && pieceBad <= 8) { console.log(`  dílek ${piece} bajt ${i}`); }
    }
  }
}
if (missing) {
  console.error(`chybí ${missing} obrázků dílků v ${dir}\n  ./tools/tracepuzzle.py`);
  process.exit(2);
}
console.log(`36 dílků složených pravidlem $9C3A: ${pieceCount} bajtů, ${pieceBad} rozdílů`);

// --- 3. devět karet je z dlaždic a rámečku ---------------------------------
const tiles = data.tiles.list.map((t) => Uint8Array.from(t.bytes));
let cardBad = 0, cardCount = 0;
for (let n = 0; n < data.cards.count; n++) {
  const got = mem.subarray(CARDS + n*SIZE, CARDS + n*SIZE + SIZE);
  const want = new Uint8Array(SIZE);
  for (let group = 0; group < SIZE/8; group++) {
    // která dlaždice to je, se pozná tak, že se zkusí a orámuje
    const found = tiles.find((tile) => {
      const trial = new Uint8Array(SIZE);
      trial.set(tile, group*8);
      frame(trial);
      for (let i = 0; i < 8; i++) {
        if (trial[group*8 + i] !== got[group*8 + i]) { return false; }
      }
      return true;
    });
    if (found) { want.set(found, group*8); }
  }
  frame(want);
  for (let i = 0; i < SIZE; i++) {
    checks++; cardCount++;
    if (want[i] !== got[i]) { cardBad++; diffs++; }
  }
}
console.log(`9 karet z dlaždic a rámečku $B12D: ${cardCount} bajtů, ${cardBad} rozdílů`);

// --- 4. vylosované heslo ---------------------------------------------------
const drawn = Array.from(mem.subarray(PASSWORD_AT, PASSWORD_AT + data.passwords[0].codes.length));
const hit = data.passwords.find((p) => p.codes.every((c, i) => c === drawn[i]));
checks++;
if (!hit) { diffs++; console.log('  heslo na $4FB5 není žádné z osmi'); }
console.log(`vylosované heslo na $4FB5: ${hit ? hit.text : '???'}, `
  + `${hit ? 0 : 1} rozdílů`);

// --- 5. záznamy dílků dávají smysl -----------------------------------------
const perPuzzle = new Map();
let recBad = 0;
for (let piece = 0; piece < data.records.count; piece++) {
  const rec = mem.subarray(RECORDS + piece*4, RECORDS + piece*4 + 4);
  perPuzzle.set(rec[0], (perPuzzle.get(rec[0]) || 0) + 1);
  for (let i = 1; i < 4; i++) {
    checks++;
    if (rec[i] > 15) { recBad++; diffs++; }
  }
  checks++;
  if (rec[0] >= data.cards.count) { recBad++; diffs++; }
}
for (const [puzzle, count] of perPuzzle) {
  checks++;
  if (count !== 4) { recBad++; diffs++; console.log(`  skládačka ${puzzle} má ${count} dílků`); }
}
console.log(`36 záznamů dílků: 9 skládaček po 4, tvary 0-15, ${recBad} rozdílů`);

console.log(`matchpuzzle: ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
