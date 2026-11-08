#!/usr/bin/env node
/**
 * matchsprites — sprajty z dat proti paměti běžícího originálu.
 *
 * `data/sprites.json` vzniká staticky z rozbaleného obrazu
 * (`tools/dumpsprites.py`; kdo je kde, plyne z tabulek `$8D41`/`$8D5D`/
 * `$8D95` a z rutin `$A68B` a `$A729`, `sources/docs/disasm_notes.md` §13).
 * Tenhle nástroj ukáže, že to jsou opravdu bajty, které má stroj — a že
 * platí i to jediné, co s nimi hra za běhu dělá:
 *
 * 1. **všech 84 bloků** proti paměti stroje ve výtahu
 *    (`build/screen/elevator_ram.bin`, `tools/mkscreen.py`), kde agent
 *    kouká doleva a nic zrcadlené není;
 * 2. **bloky mimo agenta** proti paměti stroje v místnosti
 *    (`build/screen/room_ram.bin`, `tools/mkscreen.py --walk`) — robot,
 *    koule a drobnosti se nezrcadlí nikdy;
 * 3. ★ **zrcadlení agenta**: v místnosti kouká agent doprava, takže hra
 *    bloky použitých stavů obrátila na místě (`$8795`). Nástroj vezme
 *    data, pustí na ně tutéž rutinu a srovná s pamětí stroje **všech
 *    64 bloků agenta** — zrcadlené i nezrcadlené;
 * 4. **tabulka obracení bajtů** `$C500` (staví ji `$3939` při inicializaci)
 *    proti oběma pamětem;
 * 5. **`C64SpriteData`**: každý blok se rozloží na pixely a složí zpátky,
 *    aby bylo vidět, že knihovna čte tentýž tvar (hires u agenta,
 *    multicolor u robota a koule).
 *
 * Natočení si blok pamatuje v 63. bajtu, který VIC nečte: `$80` vlevo,
 * `$01` vpravo. Rutina ho porovná s `$50` a je-li jiný, obrátí řádky
 * a bajt přepíše obrácenou hodnotou — proto je zrcadlení samo sobě inverzí.
 *
 *     ./tools/matchsprites.mjs [--dir build/screen] [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';
import '../app/svision/tools/nodeEnv.mjs';

const { C64SpriteData } = await import('../app/svision/js/platform/canvas2D/c64/c64SpriteData.js');

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/screen');
const verbose = args.includes('--verbose');

const BLOCK = 64, ROWS = 21, ROW_BYTES = 3, FACING = 63;

const data = JSON.parse(readFileSync('data/sprites.json', 'utf8'));
const mirrorTable = Uint8Array.from(data.agent.mirror.bytes);
const addrOf = (key) => parseInt(key.slice(1), 16);

let checks = 0, diffs = 0;

/**
 * Jedno srovnání bloků s pamětí stroje.
 * @param {string} what - Co se srovnává, do hlášení.
 * @param {Object} want - Bloky z dat, klíč je adresa.
 * @param {Uint8Array} ram - Paměť stroje.
 */
function compare(what, want, ram) {
  let bad = 0, count = 0;
  for (const [key, block] of Object.entries(want)) {
    const addr = addrOf(key);
    for (let i = 0; i < block.length; i++) {
      checks++; count++;
      if (block[i] !== ram[addr + i]) {
        bad++; diffs++;
        if (verbose && bad <= 8) {
          console.log(`  ${what}: $${(addr + i).toString(16)} `
            + `${block[i].toString(16)} != ${ram[addr + i].toString(16)}`);
        }
      }
    }
  }
  console.log(`${what}: ${count} bajtů v ${Object.keys(want).length} blocích, ${bad} rozdílů`);
}

/**
 * Zrcadlení tak, jak ho dělá `$8795`: každý řádek se čte po třech bajtech,
 * krajní dva se prohodí a všechny tři se obrátí tabulkou `$C500`. Bajt 63
 * prvního bloku nese natočení a přepíše se svou obrácenou hodnotou; bajty 63
 * dalších bloků rutina nepotká (Y jde po trojkách od `$8D95` dolů).
 * @param {Uint8Array} span - Bloky stavu za sebou, kopie k přepsání.
 * @returns {Uint8Array} Tytéž bajty obrácené.
 */
function mirror(span) {
  const out = Uint8Array.from(span);
  for (let base = 0; base < span.length; base += BLOCK) {
    for (let row = 0; row < ROWS; row++) {
      const at0 = base + row*ROW_BYTES;
      out[at0] = mirrorTable[span[at0 + 2]];
      out[at0 + 1] = mirrorTable[span[at0 + 1]];
      out[at0 + 2] = mirrorTable[span[at0]];
    }
  }
  out[FACING] = mirrorTable[span[FACING]];
  return out;
}

const elevator = `${dir}/elevator_ram.bin`;
const room = `${dir}/room_ram.bin`;
if (!existsSync(elevator) || !existsSync(room)) {
  console.error(`chybí paměť originálu v ${dir}\n`
    + '  ./tools/mkscreen.py --name elevator\n  ./tools/mkscreen.py --walk --name room');
  process.exit(2);
}
const elevatorRAM = new Uint8Array(readFileSync(elevator));
const roomRAM = new Uint8Array(readFileSync(room));

// --- 1. a 2. bloky proti paměti -------------------------------------------
const all = {}, others = {};
for (const [key, block] of Object.entries(data.blocks)) {
  all[key] = block.bytes;
  if (block.what !== 'agent') { others[key] = block.bytes; }
}
compare('všechny bloky ve výtahu (agent kouká doleva)', all, elevatorRAM);
compare('robot, koule a drobnosti v místnosti', others, roomRAM);

// --- 3. zrcadlení agenta ---------------------------------------------------
// ★ Pro každý stav se vezmou jeho bloky z dat a podle 63. bajtu v paměti
// stroje se buď nechají, nebo obrátí — přesně to rozhodnutí dělá `$8795`.
const bank = parseInt(data.bankBase.slice(1), 16);
const seen = new Set();
let mirrored = 0, bad = 0, count = 0;
for (const state of data.agent.states) {
  const addr = bank + state.pointer*BLOCK;
  if (seen.has(addr)) { continue; }
  seen.add(addr);
  const span = new Uint8Array(state.blocks*BLOCK);
  for (let b = 0; b < state.blocks; b++) {
    span.set(Uint8Array.from(data.blocks['$' + (addr + b*BLOCK).toString(16)
      .toUpperCase().padStart(4, '0')].bytes), b*BLOCK);
  }
  const want = roomRAM[addr + FACING] === span[FACING] ? span : mirror(span);
  if (want !== span) { mirrored += state.blocks; }
  for (let i = 0; i < span.length; i++) {
    checks++; count++;
    if (want[i] !== roomRAM[addr + i]) {
      bad++; diffs++;
      if (verbose && bad <= 8) {
        console.log(`  agent v místnosti: $${(addr + i).toString(16)} `
          + `${want[i].toString(16)} != ${roomRAM[addr + i].toString(16)}`);
      }
    }
  }
}
console.log(`agent v místnosti: ${count} bajtů, z toho ${mirrored*BLOCK} zrcadlených, `
  + `${bad} rozdílů`);

// --- 4. tabulka obracení bajtů --------------------------------------------
const tableAddr = parseInt(data.agent.mirror.table.slice(1), 16);
for (const [what, ram] of [['výtah', elevatorRAM], ['místnost', roomRAM]]) {
  let wrong = 0;
  for (let i = 0; i < mirrorTable.length; i++) {
    checks++;
    if (mirrorTable[i] !== ram[tableAddr + i]) { wrong++; diffs++; }
  }
  console.log(`tabulka $C500 (${what}): ${mirrorTable.length} bajtů, ${wrong} rozdílů`);
}

// --- 5. knihovna čte tentýž tvar ------------------------------------------
// Agent je hires (sprajty 1-3, `$D01C` bit 1-3 nula), robot a koule
// multicolor (`$A68B` dá `$D01C = $F0`, `$A729` `$F1`).
let shapeBad = 0, shapeCount = 0;
for (const [key, block] of Object.entries(data.blocks)) {
  const multicolor = block.what !== 'agent' && (block.what.startsWith('robot')
    || block.pointer === 0x1F);
  const bytes = Uint8Array.from(block.bytes);
  const again = C64SpriteData.encode(C64SpriteData.decode(bytes, { multicolor }), { multicolor });
  for (let i = 0; i < C64SpriteData.BYTES; i++) {
    checks++; shapeCount++;
    if (again[i] !== bytes[i]) {
      shapeBad++; diffs++;
      if (verbose && shapeBad <= 8) { console.log(`  C64SpriteData ${key} bajt ${i}`); }
    }
  }
}
console.log(`C64SpriteData tam a zpátky: ${shapeCount} bajtů, ${shapeBad} rozdílů`);

console.log(`matchsprites: ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
