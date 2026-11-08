#!/usr/bin/env node
/**
 * matchcharset — znaková sada z dat proti paměti běžícího originálu.
 *
 * `data/charset_room.json` vzniká staticky z rozbaleného obrazu
 * (`tools/dumpcharset.py --room`, adresa `$5000` odečtená ze stavitele
 * místnosti `$A3C6`, `sources/docs/disasm_notes.md` §12). Tenhle nástroj
 * ukáže, že to je opravdu ta sada, kterou má stroj:
 *
 * 1. **základní sada** proti paměti stroje ve chvíli, kdy staví normální
 *    místnost (`build/rooms/r00_pre.bin`, `tools/tracerooms.py`);
 * 2. **záplata řídicí místnosti** proti paměti po tom, co stavitel postavil
 *    místnost `$11` (`build/rooms/r17_post.bin`) — `$A649` tam nakopíruje
 *    144 bajtů z `$3063` na `$5000`, tedy glyfy `$00`–`$11`;
 * 3. **sada z úplně jiné cesty**: to, co z běžící hry vytáhl
 *    `tools/mkscreen.py --walk` do `data/room.json` (banka 1, `$5000`).
 *
 * ★ **Sady šachty (`$4800`) a počítače (`$5800`)** se měří taky, a to
 * jako `matchimage`: každý rozdíl proti paměti stroje musí být
 * **pojmenovaný** (`disasm_notes.md` §14). Pojmenované jsou tři věci —
 * záplata **26 písmen a 10 číslic z Char ROM** (`$39AA`-`$39D6` přepne
 * `$01 = $21` a kopíruje do obou sad naráz), **okno do obrázku mapy
 * pevnosti** z `$FC00` v sadě počítače — je to okno, do kterého počítač
 * kreslí mapu nebo dílek skládačky (§15), a losuje se, data to nejsou —
 * a čtyři **nárazníky přes prázdné glyfy** sady šachty: kopie sprajtů
 * agenta, **dílky skládačky v paměti počítače**, záznamy nábytku místnosti
 * a **vylosované heslo** na `$4FB5`.
 * Co by zbylo mimo ně, je nevysvětlený rozdíl a nástroj spadne.
 *
 * Že se ta sada i **správně kreslí**, měří `tools/matchscreen.mjs` nad
 * `data/room.json` — 64 000 pixelů, 0 rozdílů mimo sprajty.
 *
 *     ./tools/matchcharset.mjs [--dir build/rooms] [--screen-dir build/screen] [--verbose]
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const at = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const dir = at('--dir', 'build/rooms');
const screenDir = at('--screen-dir', 'build/screen');
const verbose = args.includes('--verbose');

const SET = 0x5000, SET_BYTES = 2048;
const CONTROL_ROOM = 17;            // $11, druhá je $1B — obě kopírují totéž

const data = JSON.parse(readFileSync('data/charset_room.json', 'utf8'));
const base = Uint8Array.from(data.bytes);
const patch = Uint8Array.from(data.controlRoom.bytes);

let checks = 0, diffs = 0;

/**
 * Jedno srovnání sady se souvislým kusem paměti.
 * @param {string} what - Co se srovnává, do hlášení.
 * @param {Uint8Array} want - Sada z dat.
 * @param {Uint8Array} got - Paměť stroje.
 */
function compare(what, want, got) {
  let bad = 0;
  for (let i = 0; i < want.length; i++) {
    checks++;
    if (want[i] !== got[i]) {
      bad++; diffs++;
      if (verbose && bad <= 8) {
        console.log(`  ${what}: $${(SET + i).toString(16)} `
          + `${want[i].toString(16)} != ${got[i].toString(16)}`);
      }
    }
  }
  console.log(`${what}: ${want.length} bajtů, ${bad} rozdílů`);
}

const plain = `${dir}/r00_pre.bin`;
const control = `${dir}/r${CONTROL_ROOM}_post.bin`;
if (!existsSync(plain) || !existsSync(control)) {
  console.error(`chybí záznamy originálu v ${dir}\n  ./tools/tracerooms.py`);
  process.exit(2);
}

compare('základní sada v paměti stroje', base,
  new Uint8Array(readFileSync(plain)).subarray(SET, SET + SET_BYTES));

const patched = Uint8Array.from(base);
patched.set(patch, data.controlRoom.firstGlyph * 8);
compare('sada po řídicí místnosti $11', patched,
  new Uint8Array(readFileSync(control)).subarray(SET, SET + SET_BYTES));

/**
 * Sada z obrazovky, kterou vytáhl `mkscreen.py` — jiná cesta k témuž.
 * @param {string} screen - Soubor obrazovky v `data/`.
 * @param {string} charset - Soubor sady v `data/`.
 * @param {number} addr - Adresa sady.
 * @param {string} what - Co se srovnává, do hlášení.
 */
function compareCapture(screen, charset, addr, what) {
  if (!existsSync(screen) || !existsSync(charset)) { return; }
  const key = '$' + addr.toString(16).toUpperCase().padStart(4, '0');
  const captured = JSON.parse(readFileSync(screen, 'utf8')).charsets?.[key];
  if (!captured) { return; }
  compare(what, Uint8Array.from(JSON.parse(readFileSync(charset, 'utf8')).bytes),
    Uint8Array.from(captured));
}

compareCapture('data/room.json', 'data/charset_room.json', SET,
  'sada místnosti z běžící hry (mkscreen)');

// --- sady šachty a počítače: rozdíl smí být jen pojmenovaný ---------------
const CHAR_ROM = 'sources/rom/characters.901225-01.bin';
const rom = existsSync(CHAR_ROM) ? new Uint8Array(readFileSync(CHAR_ROM)) : null;

/**
 * Sada, kterou hra za běhu doplňuje: statické glyfy, na ně záplata z Char
 * ROM, a co zbude, musí padnout do pojmenovaného nárazníku.
 * @param {string} file - Soubor sady v `data/`.
 * @param {string} dumpPath - Paměť stroje.
 * @param {string} what - Co se srovnává, do hlášení.
 */
function comparePatched(file, dumpPath, what) {
  if (!existsSync(file) || !existsSync(dumpPath) || !rom) { return; }
  const set = JSON.parse(readFileSync(file, 'utf8'));
  const ram = new Uint8Array(readFileSync(dumpPath));
  const want = Uint8Array.from(set.bytes);
  let romBytes = 0;
  for (const part of set.charRom.parts) {          // ★ písmena a číslice z ROM
    for (let i = 0; i < part.bytes.length; i++) {
      want[part.addr - set.addr + i] = rom[part.romAddr + i];
      romBytes++;
      if (rom[part.romAddr + i] !== part.bytes[i]) {
        diffs++;
        console.log(`  ${what}: záplata nesedí s Char ROM na $${(part.addr + i).toString(16)}`);
      }
      checks++;
    }
  }
  const named = (addr) => set.overlays.find((o) => addr >= o.addr && addr < o.addr + o.bytes);
  const tally = new Map(set.overlays.map((o) => [o.addr, 0]));
  let explained = 0, unexplained = 0;
  for (let i = 0; i < want.length; i++) {
    checks++;
    if (want[i] === ram[set.addr + i]) { continue; }
    const overlay = named(set.addr + i);
    if (overlay) {
      explained++; tally.set(overlay.addr, tally.get(overlay.addr) + 1); continue;
    }
    unexplained++; diffs++;
    if (verbose && unexplained <= 8) {
      console.log(`  ${what}: $${(set.addr + i).toString(16)} `
        + `${want[i].toString(16)} != ${ram[set.addr + i].toString(16)}`);
    }
  }
  const by = set.overlays.filter((o) => tally.get(o.addr))
    .map((o) => `$${o.addr.toString(16).toUpperCase()}:${tally.get(o.addr)}`).join(' ');
  console.log(`${what}: ${want.length} bajtů (z toho ${romBytes} z Char ROM), `
    + `${explained} vysvětlených nárazníkem${by ? ` (${by})` : ''}, `
    + `${unexplained} nevysvětlených`);
}

comparePatched('data/charset_shaft.json', `${screenDir}/elevator_ram.bin`,
  'sada šachty ve výtahu');
comparePatched('data/charset_shaft.json', `${dir}/r00_post.bin`,
  'sada šachty v místnosti');
comparePatched('data/charset_computer.json', `${screenDir}/elevator_ram.bin`,
  'sada počítače ve výtahu');
comparePatched('data/charset_computer.json', `${screenDir}/room_ram.bin`,
  'sada počítače v místnosti');


console.log(`matchcharset: ${checks} kontrol, ${diffs} rozdílů`);
process.exit(diffs ? 1 : 0);
