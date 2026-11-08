#!/usr/bin/env node
/**
 * runworker — protokol workeru bez prohlížeče.
 *
 * Worker je klasický skript (`importScripts`), takže se načítá přes
 * `app/svision/tools/classicScript.cjs` (R-001). Nástroj ho projede tak, jak
 * ho pouští hra: `init` se semínkem, `start`, pár snímků, `random`, `stop` —
 * a zkontroluje, že odpovědi sedí a že **totéž semínko dá tutéž
 * posloupnost** (bez toho nemá regres o co opřít otisk).
 *
 *     ./tools/runworker.mjs [--frames 5]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { loadClassicScript } = require('../app/svision/tools/classicScript.cjs');

/**
 * Data losování pevnosti. Ve workeru je fetchne hlavní vlákno a pošle je
 * v `init` — stejně jako u obrazovek je stahování věc volajícího, ne
 * loaderu (`app/screenLoader.js`).
 */
const fortressData = JSON.parse(
  readFileSync(new URL('../data/fortress.json', import.meta.url), 'utf8'));

/** Místnosti — z nich si worker staví pevnost, ze které pak staví místnost. */
const roomsData = JSON.parse(
  readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'));

/** Tabulky pohybu a bloky sprajtů — bez nich se agent nehne (M3). */
const globalData = JSON.parse(
  readFileSync(new URL('../data/global.json', import.meta.url), 'utf8'));
const spritesData = JSON.parse(
  readFileSync(new URL('../data/sprites.json', import.meta.url), 'utf8'));
const charsetRoom = JSON.parse(
  readFileSync(new URL('../data/charset_room.json', import.meta.url), 'utf8'));
const shaftData = JSON.parse(
  readFileSync(new URL('../data/shaft.json', import.meta.url), 'utf8'));
const furnitureData = JSON.parse(
  readFileSync(new URL('../data/furniture.json', import.meta.url), 'utf8'));
const terminalData = JSON.parse(
  readFileSync(new URL('../data/terminal.json', import.meta.url), 'utf8'));
/** ★ sada šachty jde i do **paměti stroje**: `$4EF0` v ní je start agenta (§14) */
const charsetShaft = JSON.parse(
  readFileSync(new URL('../data/charset_shaft.json', import.meta.url), 'utf8'));
/** ★ tabulky a texty kapesního počítače (M5, §34) a šestnáct tvarů dílku */
const computerData = JSON.parse(
  readFileSync(new URL('../data/computer.json', import.meta.url), 'utf8'));
const puzzleData = JSON.parse(
  readFileSync(new URL('../data/puzzle.json', import.meta.url), 'utf8'));
/** ★ dvě zvláštní místnosti (M5, §35) — osm tónů a obrázek řídicí */
const specialData = JSON.parse(
  readFileSync(new URL('../data/special.json', import.meta.url), 'utf8'));
/** ★ tabulky konce hry (M5, §33) — bez nich by tabule byla prázdná */
const endData = JSON.parse(
  readFileSync(new URL('../data/end.json', import.meta.url), 'utf8'));
/** ★ řeč (M6) — rozběh hry jí řekne dvě věty (`$39F4`, `$39FF`) */
const speechData = JSON.parse(
  readFileSync(new URL('../data/speech.json', import.meta.url), 'utf8'));

/** ★ osm hesel z `$208E` originálu (`disasm_notes.md` §9) */
const PASSWORDS = ['swordfish', 'asparagus', 'artichoke', 'crocodile',
                   'alligator', 'albatross', 'butterfly', 'cormorant'];

/** ★ snímek PAL, tak jak ho počítá worker (`FRAME_MS`) */
const FRAME_MS = 20;

const args = process.argv.slice(2);
const frames = Number(args[args.indexOf('--frames')+1]) || 5;

let checks = 0, differences = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { differences++; console.log(`  RŮZNÉ ${name}: ${a} != ${e}`); }
}

/**
 * Spustí worker. `loadClassicScript` vyhodnotí skript proti skutečnému
 * globálu (tak, jak to dělá `importScripts`), takže se mu tam podstrčí
 * `postMessage` a hodiny a pak se sáhne na `onmessage`, které si nastavil.
 */
function startWorker() {
  const out = [];
  let beat = null;
  globalThis.postMessage = (data) => out.push(data);
  // ★ Worker tiká `setTimeout`em s **akumulátorem** (R-045 to nebylo, tohle
  // je `schedule()` v `app/gameWorker.js`), takže se nedá jen zavolat
  // zachycená funkce: ta se ptá, **kolik času opravdu uběhlo**. Harness mu
  // proto podstrčí i hodiny a posune je o snímek — tím je jeden `tick()`
  // přesně jeden tik světa, jako dřív.
  let clock = 0;
  const realNow = Date.now;
  globalThis.Date.now = () => clock;
  globalThis.setTimeout = (fn) => { beat = fn; return 1; };
  globalThis.clearTimeout = () => {};
  globalThis.onmessage = null;
  // worker si je bere `importScripts`; pod Node se nahrají ručně a najdou se
  // přes `self`, tedy tak, jak to ve workeru dělá globál
  globalThis.self = globalThis;
  // ★ kolize sprajtů počítá knihovna (`C64Collision`, R-043); worker si ji
  // bere `importScripts` jako klasický skript, tady se nahraje ručně
  loadClassicScript(new URL('../app/svision/js/platform/canvas2D/c64/c64Collision.js',
                            import.meta.url).pathname);
  loadClassicScript(new URL('../app/fortressGen.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/fortressMap.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/roomBuild.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/roomsLoader.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/elevator.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/shaftBuild.js', import.meta.url).pathname);
loadClassicScript(new URL('../app/transition.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/roomLift.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/furniture.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/terminal.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/pocketComputer.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/codeRoom.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/controlRoom.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/robots.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/orb.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/collision.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/death.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/endGame.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/sound.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/speech.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/player.js', import.meta.url).pathname);
  loadClassicScript(new URL('../app/gameWorker.js', import.meta.url).pathname);
  const handler = globalThis.onmessage;
  // ★ **Harness hraje i za čip.** Od M6 čeká `$BF51` na dohrání věty
  // a tu zprávu posílá hlavní vlákno, až mu ji ohlásí `ChipStream`
  // (`blockDone` → `spoken`, `app/gameModel.js`). Bez toho by se svět
  // zastavil na první větě, takže si to `tick` odehraje sám: blok „dohraje"
  // přesně tolik snímků, kolik věta trvá (`speech.frames`).
  const playing = [];
  const send = (data) => handler({data});
  const chipTick = () => {
    let last = 0;
    for (const o of out) {
      if (o.message === 'frame') { last = o.frame; }
      if (o.speech && !playing.some((c) => c.id === o.speech.id)) {
        playing.push({id: o.speech.id, doneAt: o.frame+o.speech.frames, sent: false});
      }
    }
    for (const c of playing) {
      if (!c.sent && last >= c.doneAt) {
        c.sent = true;
        send({message: 'spoken', ids: [c.id]});
      }
    }
  };
  // `tick` je to, co ve workeru dělá `schedule()`: jeden snímek světa
  return {send: send, out,
          tick: () => { clock += FRAME_MS; const r = beat && beat(); chipTick(); return r; },
          // ★ týž snímek, ale **bez čipu**: tím se dá ukázat, že se na jeho
          // zprávu opravdu čeká
          tickNoChip: () => { clock += FRAME_MS; return beat && beat(); },
          restoreClock: () => { globalThis.Date.now = realNow; }};
}

const w = startWorker();
w.send({message: 'init', seed: 12345, fortress: fortressData, rooms: roomsData});
check('init odpoví ready', w.out[0].message, 'ready');
check('init vrátí semínko', w.out[0].seed, 12345);

// losování pevnosti rutinou originálu (M2): co se dá o pevnosti říct, aniž
// by se čekalo na místnosti — heslo, mapa a obsah nábytku
const fortress = w.out[0].fortress;
check('init vylosuje pevnost', !!fortress, true);
check('heslo je jedno z osmi', PASSWORDS.indexOf(fortress.password) >= 0, true);
check('mapa má 9 x 6 čtverců', fortress.map.length, 54);
// ★ 32 místností je přesně to, co slibuje manuál (`manual_transcript.md`)
check('v mapě stojí 32 místností', fortress.map.filter((x) => x !== 0xFF).length, 32);
check('nábytku k prohledání je 126', fortress.slots, 126);
check('v nábytku je 36 dílků skládačky', fortress.pieces, 36);
check('a 18 terminálů', fortress.terminals, 18);

// ★ Místnost se **staví**, nekreslí se z obrázku (`disasm_notes.md` §12):
// worker ji postaví z vylosované pevnosti rutinou originálu `$A39C`. Že to
// staví správně, měří `tools/matchrooms.mjs` (celá RAM proti stroji) a
// `--data` (z dat proti obrazu paměti); tady jde o protokol a o to, že
// místnost, kterou worker vydá, je místnost.
w.send({message: 'room', room: 0, side: 0});
const room0 = w.out[w.out.length-1];
check('room odpoví room', room0.message, 'room');
check('obrazovka má 1000 buněk', room0.screen.length, 1000);
check('barevná paměť má 1000 buněk', room0.color.length, 1000);
// zdi místnosti: 25 řádků $47 vlevo a $48 vpravo (`$A45D`), a co se kreslí
// po nich (podlahy, šachty, nábytek), je smí přepsat — proto horní rohy
check('vlevo je zeď', [room0.screen[0], room0.screen[40]], [0x47, 0x47]);
check('vpravo je zeď', [room0.screen[39], room0.screen[79]], [0x48, 0x48]);
check('roboti sedí se záznamem', room0.robots, roomsData.rooms[0].robots.length);
// ★ zapnuté sprajty nejsou v `$D015`, ale v `$8E` — do registru je dá `$A35E`
check('zapnuté sprajty jsou z posledního bajtu záznamu',
      room0.sprites.enabled, roomsData.rooms[0].sprite.enable);
// roboti dostanou ukazatel $C0 (`$A68B`), agent žádný — ten je věc jeho stavu (M3)
check('roboti ukazují na sprajt robota',
      room0.spritePointers.slice(4), [0xC0, 0xC0, 0xC0, 0xC0]);
check('agent zatím ukazatel nemá', room0.spritePointers.slice(1, 4), [0, 0, 0]);
// ★ `$A5C9` kreslí konzoli **kódové** místnosti, ne řídicí: `$A771` je
// kódová (dvě, `$11` a `$1B`), `$AA40` řídicí (jedna, místnost 5) — §35
check('místnost 0 není kódová', room0.codeRoom, false);
w.send({message: 'room', room: 0x11, side: 1});
const control = w.out[w.out.length-1];
check('místnost $11 je kódová', control.codeRoom, true);
// ★ řídicí místnost má navrch konzoli (`$A5C9`): pás 32 znaků $01 od $C17C,
// tedy na řádku 3 od sloupce 4
check('konzole řídicí místnosti stojí',
      Array.from(control.screen.slice(3*40+4, 3*40+36)).every((c) => c === 0x01), true);
// ★★ **A konzole má čtyři vlastní sprajty** (`$A656`): ukazatele `$10`
// (ruka), `$33`, `$34`, `$35` z tabulky `$A67B`, a `$43F8` = `$1E`. Ta
// tabulka i **záplata sady** `$3063` jsou v `data/rooms.json` od začátku,
// jenže je do paměti nikdo nesypal — konzole tedy neměla glyfy a ruka
// kódové místnosti se kreslila ukazatelem `$00`, tedy **obrazovkou**
// (nahlásil operátor 2026-09-21). Do M5 to vidět nebylo: sprajt bez bloku
// model schovává, takže ruka jen chyběla.
check('a má svoje čtyři sprajty', control.spritePointers.slice(4), [0x10, 0x33, 0x34, 0x35]);
check('a nulty je konzolí taky', control.spritePointers[0], 0x1E);
// ★ a **glyfy konzole** z `$3063`: prvních osmnáct znaků sady místnosti
{
  const patch = roomsData.codeRoom.parts.find((p) => p.name === 'charsetPatch');
  const machine = globalThis.roomsLoader.memory(roomsData);
  check('a záplatu sady na $3063',
        Array.from(machine.subarray(patch.from, patch.from + 8)),
        patch.bytes.slice(0, 8));
}

// ★ Dvojí nasypání téhož statického obrazu se musí shodnout tam, kde se
// překrývá: `data/rooms.json` (záznamy místností) a `data/fortress.json`
// (vstupy losování) jsou vytažené z jedné paměti, takže překryv je kontrola,
// ne shoda náhodou.
{
  const seeded = globalThis.roomsLoader.memory(roomsData);
  let overlaps = 0, clashes = 0;
  for (const segment of fortressData.segments) {
    const raw = Buffer.from(segment.bytes, 'base64');
    for (let i = 0; i < raw.length; i++) {
      if (seeded[segment.at + i] === 0) { continue; }      // tam data místností nesahají
      overlaps++;
      if (seeded[segment.at + i] !== raw[i]) { clashes++; }
    }
  }
  check('překryv dat místností a losování je neprázdný', overlaps > 0, true);
  check('a v překryvu se shodují', clashes, 0);
}

const values = [];
for (let i = 0; i < 8; i++) {
  w.send({message: 'random'});
  values.push(w.out[w.out.length-1].value);
}
check('náhoda dá bajty', values.every((v) => Number.isInteger(v) && v >= 0 && v < 256), true);
check('náhoda není konstanta', new Set(values).size > 1, true);

const w2 = startWorker();
w2.send({message: 'init', seed: 12345, fortress: fortressData, rooms: roomsData});
const again = [];
for (let i = 0; i < 8; i++) {
  w2.send({message: 'random'});
  again.push(w2.out[w2.out.length-1].value);
}
check('totéž semínko dá tutéž posloupnost', again, values);
check('totéž semínko dá tutéž pevnost', w2.out[0].fortress, fortress);
w2.send({message: 'room', room: 0, side: 0});
check('a tutéž místnost', Array.from(w2.out[w2.out.length-1].screen),
      Array.from(room0.screen));

// M3: rozehraná místnost a agent, který se v ní hýbe krokem originálu.
// Nesrovnává se tu s originálem (to dělá `tools/matchplayer.mjs`) — kontroluje
// se, že drží protokol: `play` postaví, `input` se projeví a `frame` vrací
// agenta, kterému běží hodiny.
const wp = startWorker();
wp.send({message: 'init', seed: 12345, fortress: fortressData, rooms: roomsData});
wp.send({message: 'play', room: 3, side: 0, global: globalData, sprites: spritesData,
         shaft: shaftData, furniture: furnitureData, terminal: terminalData,
         charset: charsetRoom});
const playing = wp.out[wp.out.length-1];
check('play odpoví playing', playing.message, 'playing');
check('agent stojí', playing.agent.state, 0x0E);
check('agent je v místnosti', playing.agent.place, 1);
check('hodiny startují ve dvanáct', playing.agent.clock.hours, 0x12);
check('agent kouká doprava', playing.agent.facing, 0x01);
const startX = playing.agent.sprites.x[0];
const startBlock = playing.agent.sprites.blocks[0].join(',');

wp.send({message: 'start'});
wp.send({message: 'input', joystick: 0x77});           // doprava
for (let i = 0; i < 180; i++) { wp.tick(); }
const walked = wp.out[wp.out.length-1];
check('snímek nese agenta', walked.message, 'frame');
check('agent ušel doprava', walked.agent.sprites.x[0] > startX, true);
check('a všechny tři sprajty jdou spolu',
      walked.agent.sprites.x[1] === walked.agent.sprites.x[0]
      && walked.agent.sprites.x[2] === walked.agent.sprites.x[0], true);
// ★ herní vteřina je 60 snímků (`disasm_notes.md` §19)
check('hodiny naskočily o tři vteřiny', walked.agent.clock.seconds, 0x03);

// ★ `$D025`/`$D026` jezdí **ve stavu sprajtů**, ne v barvách obrazu. Obraz
// se posílá, jen když se změní obrazovka (`changedPicture`), takže do
// místnosti, kterou agent prošel dveřmi, by sdílené barvy sprajtů nikdy
// nedorazily a robot by se kreslil barvami předchozí místnosti. V půlce
// místností je jedna z nich **bílá** a v bloku robota je `$D026` osmdesát
// bodů z dvou set čtyř, takže je to na první pohled vidět — a **žádné
// `match*` na to nedosáhne**, protože všechna srovnávají paměť, ne obraz.
{
  const record = globalThis.roomsLoader.buildRoom(roomsData, 3, 0);
  let seen = null;
  for (const m of wp.out) { if (m.sprites) { seen = m.sprites; } }
  check('stav sprajtů veze $D025', seen && seen.multi0, record.colors.spriteMulti0);
  check('stav sprajtů veze $D026', seen && seen.multi1, record.colors.spriteMulti1);
  // ★ a **vlastní barvu robotů**, která se mrká: `$9207` sází všem čtyřem
  // střídavě `$4B` a `$4C` podle `$E0 & 8`, takže se nekontroluje která,
  // ale že ji všichni čtyři mají touž a že to je jedna z těch dvou
  check('a vlastní barvu mají roboti společnou',
        new Set(seen ? seen.color.slice(4) : []).size, 1);
}

wp.send({message: 'input', joystick: 0x7B});           // doleva
for (let i = 0; i < 30; i++) { wp.tick(); }
const turned = wp.out[wp.out.length-1];
check('agent se otočil', turned.agent.facing, 0x80);
// ★ otočka **zrcadlí bloky sprajtů v paměti** (§13), takže blok téhož
// ukazatele je po otočce jiný
check('a jeho blok se zrcadlil',
      turned.agent.sprites.blocks[0].join(',') === startBlock, false);
// ★ Pozadí místnosti (§21): `$D021` stavitel **nepíše** a nechá ho nulové —
// barva je `$8D`, první bajt záznamu, a do registru ji dostane až rastrový kód
// clony. Kdyby se hlásilo z registru, byla by každá místnost černá.
const backgrounds = [];
for (let r = 0; r < 32; r++) {
  backgrounds.push(globalThis.roomsLoader.buildRoom(roomsData, r, 0).colors.background0);
}
check('žádná místnost nemá černé pozadí', backgrounds.filter((c) => !c).length, 0);
// ★ a rámeček je **jiný registr** než pozadí: hra ho drží černý po celou hru
check('rámeček zůstává černý ve všech místnostech',
      new Set([0, 7, 17, 31].map((r) =>
        globalThis.roomsLoader.buildRoom(roomsData, r, 0).colors.border)),
      new Set([0]));
check('a pozadí nejsou všechna stejná', new Set(backgrounds).size > 1, true);
// a musí to být opravdu `$8D`, ne něco, co se na něj náhodou podobá
const bgMem = globalThis.roomsLoader.memory(roomsData);
const bgRooms = [0, 7, 17, 31];
check('pozadí je první bajt záznamu místnosti ($8D)',
      bgRooms.map((r) => {
        globalThis.roomsLoader.buildRoom(roomsData, r, 0, bgMem);
        return bgMem[0x8D] & 0x0F;
      }),
      bgRooms.map((r) => backgrounds[r]));

// ★ Salto zhasne **prostřední sprajt** (§13, §17): `$8737` ve stavech
// `$14`-`$19` shodí v `$D015` bit 2 a ukazatel `$43FA` nechá stát na starém
// bloku. Model to musí hlásit, protože obrazovka na tom stojí — sprajt, který
// se nezhasne, tam visí jako pahýl (v prohlížeči 2026-09-20).
const somMem = globalThis.roomsLoader.memory(roomsData);
const somM = {mem: somMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
somM.entropy = () => 0x42;
globalThis.player.seedMemory(somMem, globalData, spritesData);
globalThis.player.startRoom(somM, 3, 0);
let somDark = 0, somLit = 0, somPointerMoved = 0, somLastPointer = -1;
for (let f = 0; f < 70; f++) {
  globalThis.player.frame(somM, f >= 3 && f < 6 ? 0x6F : 0x7F);
  const a = globalThis.player.view(somM);
  const middleOn = !!(a.enabled & 0x04);
  if (a.state >= 0x14 && a.state < 0x1A) {
    somDark++;
    if (middleOn) { somLit++; }
    if (somLastPointer >= 0 && a.sprites.pointer[1] !== somLastPointer) { somPointerMoved++; }
    somLastPointer = a.sprites.pointer[1];
  }
}
check('salto má fáze, ve kterých prostřední sprajt zhasíná', somDark > 0, true);
check('a v žádné z nich nesvítí', somLit, 0);
check('a jeho ukazatel se v nich nehýbe', somPointerMoved, 0);

// ★ **Latch kolizí `$D01E` se při rozběhu místnosti nuluje** (§30). Je to
// registr, který se **čtením nuluje**, takže cokoli, co v něm zbylo, přečte
// první `$94FA` jako kolizi, která se nestala — a zabije agenta dřív, než
// udělá krok. Žádné `match*` na to nedosáhne: měřidla začínají z výpisu
// paměti originálu a latch si vynulují sama, takže tohle hlídá jen tady.
const colMem = globalThis.roomsLoader.memory(roomsData);
const colM = {mem: colMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
colM.entropy = () => 0x42;
colM.vic[0x1E] = 0xFF;                       // zbytek, jaký by přišel z výpisu
globalThis.player.seedMemory(colMem, globalData, spritesData, furnitureData, terminalData);
globalThis.player.startRoom(colM, 3, 0);
check('rozběh místnosti vynuluje latch kolizí', colM.vic[0x1E], 0);
// a agent v ní stojí padesát snímků, aniž by na něco „narazil"
let colDied = 0;
for (let f = 0; f < 50; f++) {
  if (globalThis.player.frame(colM, 0x7F).died) { colDied++; }
}
check('a agent v ní stojí, aniž by na něco narazil', [colDied, colMem[0x43]], [0, 0]);
// ★ a latch se opravdu plní: agentovy tři sprajty se překrývají, takže
// `$94FA` má co číst — kdyby tam byla nula, nedokazovalo by nic ani to výš
check('a přitom se latch plní (agent koliduje sám se sebou)',
      globalThis.C64Collision.spriteSprite(globalThis.collision.sprites(colM)) & 0x0E,
      0x0E);

// ★ **Umírání v prohlížeči** (§31): obřad má vlastní snímky a obsluha
// přerušení v nich neběží, takže se v nich nesmí hnout ani `$E0`, ani
// hodiny. Na tohle žádné `match*` nedosáhne — záznam začíná z paměti
// originálu a měřidlo obřad pouští po kusech samo.
const dieMem = globalThis.roomsLoader.memory(roomsData);
const dieM = {mem: dieMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
dieM.entropy = () => 0x42;
globalThis.player.seedMemory(dieMem, globalData, spritesData, furnitureData, terminalData);
globalThis.player.startRoom(dieM, 3, 0);
const clockBefore = [dieMem[0xD3], dieMem[0xD4]];
dieMem[0x43] = 1;                            // robot se agenta dotkl
const dieStarted = globalThis.player.frame(dieM, 0x7F);
check('smrt obřad rozběhne', [dieStarted.died, dieStarted.dying], [1, 1]);
const frameBefore = dieMem[0xE0], tickBefore = dieMem[0xD1];
let dieFrames = 1, dieDone = 0;
const dieFlashes = [];
for (let f = 0; f < 200 && !dieDone; f++) {
  const out = globalThis.player.frame(dieM, 0x7F);
  dieFrames++;
  dieFlashes.push(dieM.vic[0x28]);
  if (out.dying === 2) { dieDone = dieFrames; }
}
// ★ **Obřad trvá 123 snímků, ne 33** (§31, opraveno 2026-09-21): jednotkou
// není kolo rozpouštění, ale **zdržení `$9787`** — prázdná smyčka 18 001
// cyklů, tedy 0,916 snímku PAL, kterou `$975B` volá před každou půlkou
// bliknutí. Obřad je `(34 + 33)·2` půlek, tedy dvě a půl vteřiny.
check('a doběhne za 123 snímků, jak vychází zdržení $9787', dieDone, 124);
// ★ a v těch snímcích **stojí svět**: `$E0` ani tik hodin se nehnuly
check('a v obřadu stojí čítač snímků i tik hodin',
      [dieMem[0xE0], dieMem[0xD1]], [frameBefore, tickBefore]);
// ★ **A v obřadu agent bliká** — to je to, co z něj hráč vidí. Barvy
// `$9783` a masky `$97E9` jsou **data programu** a v paměti remaku
// nebyly: s nulami byl agent po celý obřad **černý** a rozpouštění mazalo
// celé bajty místo jednoho bitu, takže zmizel za osminu času a hráč viděl
// jen zamrzlou scénu a na jejím konci novou figurku. ★ Žádné `match*` na to
// nedosáhne — `matchdeath` začíná z výpisu paměti originálu, kde obě
// tabulky jsou (§13; nahlásil operátor 2026-09-21).
check('barvy blikání i masky rozpouštění jsou v paměti',
      [Array.from(dieMem.subarray(0x9783, 0x9787)),
       Array.from(dieMem.subarray(0x97E9, 0x97F1))],
      [globalData.death.flash.values, globalData.death.masks.values]);
// ★ Sprajt 1 dostane v každé půlce **druhou** barvu dvojice (`$9761` mu dá
// `b`, `$9773` `a`), takže se za obřad prostřídají všechny čtyři z `$9783`
check('a v obřadu agent bliká všemi čtyřmi barvami $9783',
      Array.from(new Set(dieFlashes)).sort((a, b) => a - b),
      Array.from(new Set(globalData.death.flash.values)).sort((a, b) => a - b));
check('po obřadu agent stojí a žije',
      [dieMem[0x43], dieMem[0x3F], dieMem[0x47]], [0, 0x0E, 0xFF]);
check('a jeho sprajty jsou zase jeho, ne rozpuštěná kopie',
      [dieMem[0x43F9], dieMem[0x43FA], dieMem[0x43FB]],
      [dieMem[0x9708], dieMem[0x9709], dieMem[0x970A]]);
// ★ **deset minut** — to je celá cena smrti (`$96EF`)
check('a hodiny jsou o deset minut dál',
      [dieMem[0xD3], dieMem[0xD4]],
      [((clockBefore[0] + 0x10) % 0x60), clockBefore[1]]);

// ★ **Smrtelný pád se nerozpouští a hra po něm jede dál** (§31): `$95FD`
// agenta zhasne, řekne větu a skočí **rovnou na stavbu**. Řeč je M6, takže
// se přizná (`out.speech`), ale všechno ostatní se udělat musí — jinak by
// po pádu do jámy hra stála. Na tohle `match*` nedosáhne: v žádném záznamu
// se agent k smrti nezřítil.
{
  const fm = globalThis.roomsLoader.memory(roomsData);
  const fmM = {mem: fm, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
  fmM.entropy = () => 0x42;
  globalThis.player.seedMemory(fm, globalData, spritesData, furnitureData, terminalData);
  globalThis.player.startRoom(fmM, 3, 0);
  const clockWas = fm[0xD3];
  fm[0x43] = 2;                                // spadl a zabil se
  const started = globalThis.player.frame(fmM, 0x7F);
  check('smrtelný pád obřad rozběhne', [started.died, started.dying], [2, 1]);
  // ★ **Nejdřív výkřik, teprve pak nová figurka** (§31, opraveno 2026-09-21):
  // `$9605` řekne větu 7 a `$BF51` čeká, až přehrávač domluví (`$BF7E`) —
  // po tu dobu je obrazovka bez agenta a svět stojí. Worker to drží tím, že
  // posílá `passes` = 0, dokud mu čip nepošle `spoken`; stavba je až za tím.
  // ★ **A po ztišení už nesmí nic zaznít**: `$95E8 SEI` je v hlavní smyčce,
  // takže obsluha toho snímku se nespustí — ale model ji počítá první, tak
  // jí zápisy leží ve frontě a seřadily by se **za** `$95EC` (hlasy robotů
  // mají vyšší linku). Přes celý výkřik pak držel **zaseknutý tón**
  // (nahlásil operátor 2026-09-21). ★ Doloženo i záznamem: ve `sidwalk`
  // jsou poslední zápisy snímku smrti `$D40B`/`$D412` = `$08`.
  {
    const ws = globalThis.sndTake(fmM);
    const last = ws.filter((w) => [0x04, 0x0B, 0x12].includes(w[1]));
    check('a ztišení $95EC je v tom snímku poslední, co hlasy slyšely',
          last.map((w) => [w[1], w[2]]), [[0x04, 0x08], [0x0B, 0x08], [0x12, 0x08]]);
  }
  const cried = globalThis.player.frame(fmM, 0x7F);
  check('a napřed se jen vykřikne', [cried.speech, cried.dying], [7, 1]);
  check('a agent je po tu dobu zhasnutý', fm[0xD015] & 0x0E, 0);
  for (let f = 0; f < 5; f++) {
    check('a dokud se mluví, nestaví se',
          globalThis.player.frame(fmM, 0x7F, 0).dying, 1);
  }
  const fell = globalThis.player.frame(fmM, 0x7F);
  check('a jakmile se domluví, je hotový hned, bez rozpouštění', fell.dying, 2);
  check('agent po něm stojí a žije',
        [fm[0x43], fm[0x3F], fm[0x47]], [0, 0x0E, 0xFF]);
  check('a stojí ho taky deset minut', fm[0xD3], (clockWas + 0x10) % 0x60);
}

// ★ **Smrt po jízdě výtahem musí obraz vrátit tam, kde byl** (§31). `$A0F5`
// to dělá ve třech průchodech — smaže plošiny tam, kde jsou, vrátí seznam
// z předlohy a nakreslí je tam, kde začínaly — a **žádné `match*` na to
// nedosáhne**: oba záznamy smrti jsou z běhů, ve kterých agent výtahem
// nejel, takže smazat a nakreslit znovu v nich vyjde nastejno.
// Nahlásil operátor 2026-09-20 („staré plošiny se nevymažou z obrazu").
{
  let rode = 0, checked = 0, dirty = 0;
  for (const roomNo of [3, 5, 8, 10, 14, 20, 22, 26]) {
    const dm = globalThis.roomsLoader.memory(roomsData);
    const dmM = {mem: dm, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
    dmM.entropy = () => 0x42;
    globalThis.player.seedMemory(dm, globalData, spritesData, furnitureData, terminalData);
    globalThis.player.startRoom(dmM, roomNo, 0);
    const fresh = Array.from(dm.subarray(0x4000, 0x43E8));
    // agenta na sloupec výtahu, jako výš
    let on = -1;
    for (let x = 24; x < 250 && on < 0; x++) {
      dm[0x2C] = x; dm[0x2E] = x; dm[0x30] = x; dm[0x32] = 0;
      on = globalThis.roomLift.under(dmM, 0x7F);
    }
    if (on < 0) { continue; }
    let steps = 0;
    for (let f = 0; f < 200; f++) {
      const o = globalThis.player.frame(dmM, 0x7D);
      if (o.riding) { steps++; }
      if (o.riding === 2) { break; }
    }
    if (!steps) { continue; }
    rode++;
    dm[0x43] = 1;
    // ★ 200 snímků: obřad trvá 123 (jednotka je zdržení `$9787`, viz výš)
    for (let f = 0; f < 200; f++) { if (globalThis.player.frame(dmM, 0x7F).dying === 2) { break; } }
    checked++;
    for (let i = 0; i < fresh.length; i++) { if (dm[0x4000 + i] !== fresh[i]) { dirty++; } }
  }
  check('výtahem se v několika místnostech opravdu jelo', rode >= 4, true);
  check('★ a po smrti je obraz zase ten postavený (staré plošiny smazané)',
        [checked >= 4, dirty], [true, 0]);
}

// ★ Výtah **v místnosti** (§23): `$AC81` se ptá seznamu výtahů v záznamu
// místnosti, na který míří `$81`. Ten seznam musí jít projít a musí v něm
// něco být — a agent postavený na sloupec výtahu ho musí najít.
const liftMem = globalThis.roomsLoader.memory(roomsData);
const liftM = {mem: liftMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
globalThis.player.seedMemory(liftMem, globalData, spritesData, furnitureData, terminalData);
globalThis.player.startRoom(liftM, 3, 0);
const liftBase = liftMem[0x81] | (liftMem[0x82] << 8);
const liftList = [];
for (let y = 0; liftMem[liftBase + y] < 0x80;) {
  liftList.push({row: liftMem[liftBase + y], col: liftMem[liftBase + y + 1],
                 stops: liftMem[liftBase + y + 2]});
  y += 3;
  while (liftMem[liftBase + y] < 0x80) { y++; }
  y++;
}
check('místnost 3 má seznam výtahů', liftList.length > 0, true);
check('a zastávky jsou po šesti řádcích',
      liftList.every((l) => l.row % 6 === 0 || l.row === 15 || l.row === 14), true);
// agenta postavíme na sloupec výtahu a `$AC81` ho musí najít
let liftFound = -1;
for (let x = 24; x < 250 && liftFound < 0; x++) {
  liftMem[0x2C] = x; liftMem[0x2E] = x; liftMem[0x30] = x; liftMem[0x32] = 0;
  liftFound = globalThis.roomLift.under(liftM, 0x7F);
}
check('a agent na jeho sloupci ho najde', liftFound >= 0, true);
// ★ A **jezdí** (§25): z toho sloupce musí joystick dolů rozjet jízdu, ta
// musí trvat dva snímky na znakový řádek a skončit o šest řádků níž, a agent
// musí sjet s ní. Měřit proti originálu to umí `tools/matchroomlift.mjs`;
// tady se hlídá jen to, co měření míjí — že to rozhýbe **worker**, ne záznam.
const rideEntry = liftMem[0x81] | (liftMem[0x82] << 8);
let rideY = liftMem[0x2D], rideFrames = 0, rideRows = liftMem[rideEntry];
for (let f = 0; f < 60; f++) {
  const out = globalThis.player.frame(liftM, 0x7D, 1);       // joystick dolů
  if (out.riding) { rideFrames++; }
  if (out.riding === 2) { break; }
}
check('výtah v místnosti se rozjede', rideFrames > 0, true);
check('a sveze agenta o šest znakových řádků', liftMem[0x2D] - rideY, 48);
check('a záznam místnosti si nový řádek pamatuje',
      liftMem[rideEntry] - rideRows, 6);
// ★ Snímků je o jeden víc, než kolik jich jízda kreslí: ten první je ten,
// ve kterém se ještě dokončil **průchod smyčkou** a `$AC81` v něm jízdu
// rozjelo (`$ACEB` do prvního `JSR $7F6B`).
check('a je to dva snímky na řádek a dva na doznění', rideFrames, 1 + 6*2 + 2);

// ★ Výtah (§20): `play` bere navíc `shaft`, a `elevator.seedMemory` z něj
// musí položit tabulky šachty tam, kde je má originál — bez nich by krok
// výtahu skládal nový řádek z nul.
const shaftMem = new Uint8Array(0x10000);
globalThis.elevator.seedMemory(shaftMem, shaftData);
check('tabulka lana je v paměti', Array.from(shaftMem.subarray(0x0DBD, 0x0DC0)),
      shaftData.tables.cable.values);
check('tabulka prahu dveří je v paměti',
      Array.from(shaftMem.subarray(0x0E28, 0x0E50)), shaftData.tables.doorSill.values);
// ★ **A značka kabiny na mapě musí blikat** (`$73E4`, §20): barvu sprajtu 6
// bere `elCabin` z tabulky `$741F` podle `($E0 >> 2) & 7`, a ta tabulka
// v `data/shaft.json` **nebyla** — v paměti remaku tedy ležely nuly a značka
// byla černá, tedy neviditelná. Žádné `match*` na to nedosáhne: každé
// začíná z výpisu paměti originálu, kde ta tabulka je (táž slepá skvrna jako
// `seedMemory`, §13; nahlásil operátor 2026-09-21).
check('tabulka blikání značky kabiny je v paměti',
      Array.from(shaftMem.subarray(0x741F, 0x7427)), shaftData.tables.cabinFlash.values);
// ★ **A blok značky staví mapa, ne jen rozběh** (`$B712`-`$B724` na konci
// `$B6FE`, do kterého `$B68F` propadá): `$C0` do `$4D80`, `$4D83` a `$4D86`,
// tedy dva body ve třech řádcích. Při návratu z místnosti jde hra
// `$AF3F` → `$B68F` → `$B746`, a `$B746` sází **jen ukazatel** — takže kdo
// blok postaví jen v rozběhu (`pocketComputer.mapMarker`), má po první
// místnosti značku **jednořádkovou a zploštělou** (nahlásil operátor
// 2026-09-21). ★ Žádné `match*` na to nedosáhne: `matchstart` měří rozběh,
// kde blok staví ta druhá cesta, a `matchelevator` sprajty neporovnává.
{
  const mapMem = globalThis.roomsLoader.memory(roomsData);
  const mapM = {mem: mapMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
  globalThis.elevator.seedMemory(mapMem, shaftData);
  for (let i = 0; i < 0x40; i++) { mapMem[0x4D80 + i] = 0xFF; }   // ať je co mazat
  globalThis.shaftBuild.map(mapM);
  const mark = [];
  for (let i = 0; i < 0x40; i++) { if (mapMem[0x4D80 + i]) { mark.push(i); } }
  check('mapa postaví blok značky kabiny celý (tři řádky po dvou bodech)',
        [mark, mark.map((i) => mapMem[0x4D80 + i])], [[0, 3, 6], [0xC0, 0xC0, 0xC0]]);
}
{
  const cabM = {mem: shaftMem, color: new Uint8Array(0x400),
                vic: new Uint8Array(0x2F)};
  shaftMem[0x27] = 0x80; shaftMem[0x28] = 0x60;            // kabina někde v šachtě
  const seen = new Set();
  for (let e = 0; e < 32; e++) {
    shaftMem[0xE0] = e;
    globalThis.elevator.cabin(cabM);
    seen.add(cabM.vic[0x2D]);
  }
  check('a značka za kolo `$E0` opravdu probliká všemi osmi barvami',
        Array.from(seen).sort((a, b) => a - b), [0, 1, 11, 12, 15]);
}
// ★ Tabulka obracení bitů `$C500`: `player.seedMemory` ji **počítá** (jako
// `$3939` originálu), `data/sprites.json` ji má **změřenou**. Musí se rovnat —
// jednotková tabulka místo obrácené agenta nezrcadlí, jen mu prohodí krajní
// bajty řádku, a figurka se rozsype (stalo se 2026-09-20, §13).
const flipMem = new Uint8Array(0x10000);
globalThis.player.seedMemory(flipMem, globalData, spritesData);
// ★ **Tabulky a okna prohledávání** `$99ED`-`$9B27` a dvě okna terminálu
// (§27): taky **data programu**, která v paměti remaku nejsou, dokud je tam
// `player.seedMemory` nepoloží — bez nich se okno nad agentem neotevře
// a ukazatel postupu je prázdný. A `$97F1` je musí najít.
const furnMem = new Uint8Array(0x10000);
globalThis.player.seedMemory(furnMem, globalData, spritesData, furnitureData, terminalData);
check('pás tabulek prohledávání je v paměti',
      Array.from(furnMem.subarray(0x99ED, 0x9B28)), furnitureData.block.values);
for (const w of furnitureData.terminalWindows) {
  const at = parseInt(w.addr.slice(1), 16);
  check(`okno terminálu ${w.holds} je v paměti`,
        Array.from(furnMem.subarray(at, at + w.values.length)), w.values);
}
// ★ a hlavně: **prohledávání se dá spustit a doběhne**. Agenta postavíme nad
// kus nábytku tak, jak to dělá hra, a necháme ho zabrat nahoru.
const fuMem = globalThis.roomsLoader.memory(roomsData);
const fuM = {mem: fuMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
globalThis.player.seedMemory(fuMem, globalData, spritesData, furnitureData, terminalData);
// ★ Ve **statické** pevnosti (bez losování) má každý kus nábytku `$FF`, tedy
// „nic" — dílky do něj rozdá až generátor (§9). Zkouší se proto ten případ,
// který tam je; že prohledávání najde i dílek a terminál, měří
// `tools/matchsearch.mjs` proti originálu.
globalThis.player.startRoom(fuM, 3, 0);
// ★ `$39BF`/`$39C1` — **seznam nalezených dílků je od startu ukončený `$FF`**
// a je to jediné, co ho zakládá (`plNewGameLists`). `$9964` ho prochází
// **bez meze**, takže bez toho první nález doběhne až do **záznamů nábytku
// na `$4F55`** a přepíše některému kusu `start_lo`; `$9B28` si pak z rozdílu
// spočítá šířku dvě stě dvacet osm a vymaže čtyři řádky přes celou místnost
// — podlahu i zeď (nahlásil operátor 2026-09-20). ★ Žádné `match*` na to
// nedosáhne: každé měřidlo startuje z výpisu paměti originálu, ve kterém
// `$4EF5` dávno `$FF` je. Je to táž slepá skvrna jako `seedMemory` (§13).
check('seznam nálezů je ukončený', fuMem[0x4EF5], 0xFF);
check('a příznak koule taky', fuMem[0x6D], 0xFF);
let fuRec = -1;
for (let x = 0; fuMem[0x4F55 + x] !== 0xFF && x < 120; x += 6) {
  if (fuMem[0x4F59 + x] !== 0xFF) { fuRec = x; break; }
}
check('místnost 3 má co prohledávat', fuRec >= 0, true);
if (fuRec >= 0) {
  // `$10`/`$11` na levý horní roh toho kusu, jak by je spočítalo `$9296`
  fuM.mem[0x10] = fuMem[0x4F55 + fuRec];
  fuM.mem[0x11] = fuMem[0x4F56 + fuRec];
  const held = fuMem[0x4F5A + fuRec];
  const begun = globalThis.furniture.start(fuM);
  check('a prohledávání se nad ním rozjede', !!begun && !begun.unsupported, true);
  check('a agent přejde do stavu $0F', fuM.mem[0x3F], 0x0F);
  let fuFrames = 0, done = null;
  for (let f = 0; f < 600 && !done; f++) {
    const r = globalThis.furniture.frame(fuM, begun, 0x7E);   // drží nahoru
    fuFrames++;
    if (r.done) { done = r; }
    if (f > 400) { break; }
  }
  // páka se drží, takže se čeká ve fázi `hold` — pustíme ji
  check('a doběhne k výsledku', begun.phase, 'hold');
  check('a ve statické pevnosti nenajde nic', begun.found, 'nothing');
  const off = globalThis.furniture.frame(fuM, begun, 0x7F);   // páka pryč
  globalThis.furniture.frame(fuM, begun, 0x7F);
  check('a nábytek je pak vyprázdněný', fuMem[0x4F5A + fuRec], 0xF0);
  check('a nebyl prázdný předtím', held !== 0xF0, true);
}

// ★ A **nález se musí vejít do seznamu, ne do záznamů nábytku**: to je ta
// druhá polovina `$39C1`. Statická pevnost má v každém kusu „nic", takže se
// `$995C` výš nezavolá — tady se proto kusu dílek **nasadí** a hlídá se, že
// po nálezu je v `$4EF5` dílek a `$FF` za ním a že pás záznamů `$4F55` je
// bajt po bajtu tentýž (až na to, co vyprázdnění změnit má).
{
  const pcMem = globalThis.roomsLoader.memory(roomsData);
  const pcM = {mem: pcMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
  globalThis.player.seedMemory(pcMem, globalData, spritesData, furnitureData, terminalData);
  globalThis.player.startRoom(pcM, 3, 0);
  let rec = -1;
  for (let x = 0; pcMem[0x4F55 + x] !== 0xFF && x < 120; x += 6) {
    if (pcMem[0x4F59 + x] !== 0xFF && pcMem[0x4F59 + x] !== 0) { rec = x; break; }
  }
  if (rec >= 0) {
    pcMem[0x4F5A + rec] = 0x14;                     // dílek číslo 20
    pcMem[0x4F59 + rec] = 0x08;                     // a krátké prohledávání
    pcM.mem[0x10] = pcMem[0x4F55 + rec];
    pcM.mem[0x11] = pcMem[0x4F56 + rec];
    let end = 0;
    while (pcMem[0x4F55 + end] !== 0xFF && end < 120) { end += 6; }
    const records = Array.from(pcMem.subarray(0x4F55, 0x4F55 + end + 1));
    const begun = globalThis.furniture.start(pcM);
    for (let f = 0; f < 200 && begun.phase !== 'hold'; f++) {
      globalThis.furniture.frame(pcM, begun, 0x7E);
    }
    check('nález je dílek', begun.found, 'piece');
    check('a stojí v seznamu nálezů', [pcMem[0x4EF5], pcMem[0x4EF6]], [0x14, 0xFF]);
    globalThis.furniture.frame(pcM, begun, 0x7F);
    globalThis.furniture.frame(pcM, begun, 0x7F);
    records[rec + 5] = 0xF0;                        // `$9B2F`, vyprázdněný kus
    records[rec + 4] = 0x00;                        // a dojetý ukazatel postupu
    check('a záznamy nábytku zůstaly celé',
          Array.from(pcMem.subarray(0x4F55, 0x4F55 + end + 1)), records);
  }
  check('místnost 3 má kus, do kterého jde dílek nasadit', rec >= 0, true);
}

// ★ **Písmena v sadě šachty a počítače na disketě nejsou** (§14): `$39AA`
// si přepne `$01` a nakopíruje je z **Char ROM stroje**. `data/charset_*.json`
// je proto vezou zvlášť v `charRom.parts`, a kdo je nedosadí, má v terminálu
// i v šachtě rámečky **bez textu** (nahlásil operátor 2026-09-20).
const charsetShaftData = JSON.parse(
  readFileSync(new URL('../data/charset_shaft.json', import.meta.url), 'utf8'));
for (const [name, data] of [['šachty', charsetShaftData]]) {
  const parts = (data.charRom && data.charRom.parts) || [];
  check(`sada ${name} veze písmena z Char ROM`, parts.length, 2);
  const bytes = Uint8Array.from(data.bytes);
  const letterAt = parts.length ? parts[0].addr - data.addr : 0;
  check(`a na disketě je tam prázdno`,
        Array.from(bytes.subarray(letterAt, letterAt + 8)).some((v) => v), false);
  for (const part of parts) {
    const at = part.addr - data.addr;
    for (let i = 0; i < part.bytes.length; i++) { bytes[at + i] = part.bytes[i] & 0xFF; }
  }
  check(`a po dosazení je tam glyf`,
        Array.from(bytes.subarray(letterAt, letterAt + 8)).some((v) => v), true);
}

// ★ **Bezpečnostní terminál vrací ukazatele sprajtů** (§29). Odkládá si
// obrazovku do `$C100` — a `$43F8`-`$43FF` **leží v ní**, protože se kopíruje
// `$400` bajtů, ne tisíc. Kdo odloží jen tisíc, vrátí se do hry s ukazateli
// terminálu a roboti jsou rozsypaní (nahlásil operátor 2026-09-20). Žádné
// `match*` na to nedosáhlo, dokud mělo úzké okno — tady je to natvrdo.
const tmMem = globalThis.roomsLoader.memory(roomsData);
const tmM = {mem: tmMem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
globalThis.player.seedMemory(tmMem, globalData, spritesData, furnitureData, terminalData);
let tmRec = -1;
globalThis.player.startRoom(tmM, 3, 0);
for (let x = 0; tmMem[0x4F55 + x] !== 0xFF && x < 180; x += 6) {
  if (tmMem[0x4F59 + x] === 0xFF) { tmRec = x; break; }
}
check('místnost 3 má bezpečnostní terminál', tmRec >= 0, true);
if (tmRec >= 0) {
  const before = Array.from(tmMem.subarray(0x43F8, 0x4400));
  const term = globalThis.terminal.start();
  globalThis.terminal.frame(tmM, term, 0x7F);          // `$9D09` postaví
  check('terminál si vezme sadu šachty', tmM.vic[0x18] & 0x0E, 0x02);
  check('a svoje ukazatele sprajtů', tmMem[0x43F8], 0x18);
  check('a odloží ty herní', Array.from(tmMem.subarray(0xC4F8, 0xC500)), before);
  // páka na střed, pak střelba na položce 2 = odchod
  globalThis.terminal.frame(tmM, term, 0x7F);
  globalThis.terminal.frame(tmM, term, 0x6F);
  check('a po odchodu je vrátí', Array.from(tmMem.subarray(0x43F8, 0x4400)), before);
  check('a sadu taky', tmM.vic[0x18] & 0x0E, 0x04);
}
// ★ **Kurzor terminálu musí sednout na text, na který ukazuje.** Rozestupy
// nese tabulka `$9FE0` — a ta leží **mimo** pás `$99ED`-`$9B27`, takže se
// snadno přehlédne; bez ní čte model nulu a kurzor se posouvá o jeden řádek
// místo o tři a sedm (nahlásil operátor 2026-09-20). ★ Žádné `match*` na to
// nepřijde, protože měřidlo běží nad **pamětí originálu**, kde ta tabulka je.
const tmCur = globalThis.roomsLoader.memory(roomsData);
const tmCurM = {mem: tmCur, color: new Uint8Array(0x400),
                vic: new Uint8Array(0x2F), entropy: () => 0x42};
globalThis.player.seedMemory(tmCur, globalData, spritesData, furnitureData, terminalData);
globalThis.elevator.seedMemory(tmCur, shaftData);
globalThis.player.startRoom(tmCurM, 3, 0);
const tmCurTerm = globalThis.terminal.start();
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7F);      // `$9D09`
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7F);      // `$9F01`, hlavička
const cursorRow = () => (((tmCur[0x11] << 8) | tmCur[0x10]) - 0x4000) / 40 | 0;
/** na kterém řádku sedí která položka menu — ze **sady**, ne z hlavy */
const rowOf = (word) => {
  const text = (r) => {
    let out = '';
    for (let c = 0; c < 40; c++) {
      const ch = tmCur[0x4000 + r*40 + c];
      out += (ch >= 0x71 && ch <= 0x8A) ? String.fromCharCode(97 + ch - 0x71) : ' ';
    }
    return out;
  };
  for (let r = 0; r < 25; r++) { if (text(r).indexOf(word) >= 0) { return r; } }
  return -1;
};
check('kurzor začíná na „log off"', cursorRow(), rowOf('log off'));
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7E);      // nahoru
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7F);
check('a nahoru sedne na „temporarily"', cursorRow(), rowOf('temporarily'));
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7E);
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7F);
check('a ještě nahoru na „reset"', cursorRow(), rowOf('reset'));
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7D);      // dolů
globalThis.terminal.frame(tmCurM, tmCurTerm, 0x7F);
check('a dolů zpátky na „temporarily"', cursorRow(), rowOf('temporarily'));

// ★ **V terminálu stojí obsluha přerušení** (`SEI`, §29) — a to je podstatné
// pro obraz: koule je **sprajt 0** a roboti mají čtyři, takže kdyby běželi
// dál, přepsali by terminálu sprajtové registry i ukazatele a v rozích by
// blikala náhodná data (nahlásil operátor 2026-09-20). Tohle to hlídá.
const tmFreeze = globalThis.roomsLoader.memory(roomsData);
const tmFreezeM = {mem: tmFreeze, color: new Uint8Array(0x400),
                   vic: new Uint8Array(0x2F), entropy: () => 0x42};
globalThis.player.seedMemory(tmFreeze, globalData, spritesData, furnitureData, terminalData);
globalThis.elevator.seedMemory(tmFreeze, shaftData);
globalThis.player.startRoom(tmFreezeM, 3, 0);
tmFreezeM.pl.search = {phase: 'terminal', terminal: globalThis.terminal.start(),
                       found: 0, unsupported: 0};
globalThis.player.frame(tmFreezeM, 0x7F, 1);            // `$9D09` postaví
const frozen = {e0: tmFreeze[0xE0], clock: tmFreeze[0xD1],
                ptr: Array.from(tmFreeze.subarray(0x43F8, 0x4400)),
                orb: [tmFreezeM.vic[0], tmFreezeM.vic[1]]};
for (let f = 0; f < 6; f++) { globalThis.player.frame(tmFreezeM, 0x7F, 1); }
check('v terminálu stojí čítač snímků', tmFreeze[0xE0], frozen.e0);
check('a hodiny', tmFreeze[0xD1], frozen.clock);
check('a ukazatele sprajtů zůstanou terminálu',
      Array.from(tmFreeze.subarray(0x43F8, 0x4400)), frozen.ptr);
check('a koule nepřepíše sprajt 0',
      [tmFreezeM.vic[0], tmFreezeM.vic[1]], frozen.orb);

// ★ a bloky, kterými se terminál zdobí, musí být v datech — bez nich by
// v prohlížeči zmizely sprajty uprostřed jeho obrazovky
const tmBlocks = new Set(Object.values(spritesData.blocks).map((b) => b.pointer));
check('bloky sprajtů terminálu jsou v datech',
      [0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D].every((p) => tmBlocks.has(p)), true);

// ★ **Proud programů robotů** `$2112`-`$232B` (§17, §24): losuje se ukazatel
// do něj, sám proud je data programu a `player.seedMemory` ho musí položit do
// paměti. Bez něj mají všichni roboti program samých nul — jedou **stejně
// rychle a jen doprava** — a koule, jejíž skript v témž proudu leží, se
// nehne vůbec. ★ Žádné `match*` na to nepřijde: všechna začínají z výpisu
// paměti originálu, kde ten proud je (stalo se 2026-09-20).
check('proud programů robotů je v paměti',
      Array.from(flipMem.subarray(0x2112, 0x232C)),
      globalData.robots.programs.values);
check('a není to prázdno',
      globalData.robots.programs.values.filter((v) => v).length > 500, true);
check('spočítaná tabulka obracení bitů se rovná originálu',
      Array.from(flipMem.subarray(0xC500, 0xC600)), spritesData.agent.mirror.bytes);
check('a barvy sprajtů agenta jsou v paměti',
      Array.from(flipMem.subarray(0x970B, 0x970E)), globalData.agent.defaults.colors);

check('adresy barevných řádků jsou v paměti',
      [shaftMem[0x0E50] | shaftMem[0x0E5E] << 8,
       shaftMem[0x0E5D] | shaftMem[0x0E6B] << 8], [0xD828, 0xDA30]);
check('ukazatele na obrázek pevnosti jsou v paměti',
      shaftMem[0x78A4] | shaftMem[0x78A5] << 8, 0xFC08);
// ★ Obraz se od M3 hýbe sám (§21, §22), takže ho worker posílá ve zprávě
// `frame`, **když se změní** — a hned po `play` musí přijít, jinak by model
// neměl co kreslit.
const firstPicture = wp.out.filter((o) => o.message === 'frame' && o.picture);
check('worker pošle obraz, když se změní', firstPicture.length > 0, true);
if (firstPicture.length) {
  const pic = firstPicture[0].picture;
  check('a je to celá obrazovka', [pic.screen.length, pic.color.length], [1000, 1000]);
  check('se sadou místnosti ($D018 = $04)', pic.charset, 2);
  check('a s jejím pozadím a černým rámečkem',
        [pic.colors.background0 > 0, pic.colors.border], [true, 0]);
  check('a s ostatními sprajty', pic.sprites.pointer.length, 8);
}
// ★ **Sprajty chodí zvlášť od obrazu**, a tohle je ta kontrola, kvůli které
// to tak je (M4, 2026-09-20): robot po plošině a koule po místnosti píšou jen
// registry VIC, obrazovky se nedotknou (§24) — takže když se sprajty vezou
// s obrazem, zpráva nikdy nepřijde a roboti v prohlížeči stojí. Musí tedy
// být snímky, které nesou `sprites` a **nenesou `picture`**.
// ★ A **glyfy** chodí taky zvlášť, ze stejného důvodu: okno prohledávání je
// přepsaná znaková sada (§27), ne obrazovka. Hned po `play` musí přijít, aby
// model věděl, s čím kreslit.
const firstGlyphs = wp.out.filter((o) => o.message === 'frame' && o.glyphs);
check('worker pošle glyfy', firstGlyphs.length > 0, true);
if (firstGlyphs.length) {
  check('a je to okno prohledávání', [firstGlyphs[0].glyphs.at, firstGlyphs[0].glyphs.bytes.length],
        [0x5000, 0x90]);
  // ★ V běžné místnosti jsou glyfy `$00`-`$11` **prázdné** — hra ty kódy
  // nepoužívá a právě proto si je prohledávání může přepsat (a řídicí
  // místnost taky, z `$3063`, §12). Kontroluje se tedy shoda se sadou, ne
  // „něco tam je".
  check('a nese sadu místnosti tak, jak je',
        Array.from(firstGlyphs[0].glyphs.bytes), charsetRoom.bytes.slice(0, 0x90));
}
const spriteOnly = wp.out.filter((o) => o.message === 'frame' && o.sprites && !o.picture);
check('worker pošle sprajty i bez obrazu', spriteOnly.length > 0, true);
if (spriteOnly.length) {
  const st = spriteOnly[0].sprites;
  check('a je to celá sada registrů',
        [st.x.length, st.y.length, st.pointer.length, st.color.length], [8, 8, 8, 8]);
}
// a hýbou se v nich opravdu roboti a koule, ne jen agent
const moved = [0, 4, 5, 6, 7].filter((n) => {
  const seen = new Set(wp.out.filter((o) => o.sprites)
    .map((o) => o.sprites.x[n] + ',' + o.sprites.y[n]));
  return seen.size > 1;
});
check('a hýbou se v nich roboti nebo koule', moved.length > 0, true);
// ★ A hýbou se **každý po svém**: bez proudu programů by jeli všichni stejně
// rychle a jen doprava, což je přesně to, co se 2026-09-20 stalo v prohlížeči.
const steps = (n) => {
  const t = wp.out.filter((o) => o.sprites).map((o) => o.sprites.x[n]);
  const d = new Set();
  for (let i = 1; i < t.length; i++) { if (t[i] !== t[i - 1]) { d.add(t[i] - t[i - 1]); } }
  return d;
};
const turning = [4, 5, 6, 7].filter((n) => [...steps(n)].some((v) => v < 0));
check('a některý robot se otočí, ne jen jede doprava', turning.length > 0, true);

// ★ **Zvuk** (M6): worker hlásí zápisy do SID, protože hra jimi zní. Žádné
// `match*` na tenhle konec nedosáhne — měřidla končí u přepisu, ne u zprávy
// — takže se to hlídá tady, stejně jako sprajty a barvy (§13, bod 4).
const withSid = wp.out.filter((o) => o.message === 'frame' && o.sid && o.sid.length);
check('worker hlásí zápisy do SID', withSid.length > 0, true);
if (withSid.length) {
  const all = withSid.flatMap((o) => o.sid);
  check('a jsou to trojice [cyklus, registr, hodnota]', all[0].length, 3);
  const regs = new Set(all.map((w) => w[1]));
  // hlas 3 (šum kroku, `$8E77`) a hlasitost `$D418` musí být mezi nimi
  check('mezi nimi je hlas 3 a hlasitost', [regs.has(0x12), regs.has(0x18)], [true, true]);
  check('a žádný registr mimo $D400-$D418',
        [...regs].every((r) => r >= 0 && r <= 0x18), true);
}
wp.send({message: 'stop'});

// ★ **Hra začíná v šachtě, ne v místnosti** (`$3960`-`$3A12`,
// `player.startShaft`): agent stojí v kabině pod stropem pevnosti a do
// místnosti se teprve dojede a projde dveřmi. Na tenhle kus přepisu žádné
// `match*` nedosáhne — každé měřidlo začíná z výpisu paměti originálu, ve
// kterém hra dávno běží — takže se hlídá tady, jako `seedMemory`.
{
  const ws = startWorker();
  ws.send({message: 'init', seed: 4242, fortress: fortressData, rooms: roomsData,
           speech: speechData});
  ws.send({message: 'play', where: 'shaft', global: globalData, sprites: spritesData,
           shaft: shaftData, furniture: furnitureData, terminal: terminalData,
           charset: charsetRoom, charsetShaft: charsetShaft});
  const started = ws.out[ws.out.length-1];
  check('play do šachty odpoví playing', started.message, 'playing');
  check('agent je v šachtě', started.agent.place, 0);
  check('a stojí', started.agent.state, 0x0E);
  // ★ `$3986` — v kabině kouká **doleva**, na rozdíl od vstupu do místnosti
  check('a kouká doleva', started.agent.facing, 0x80);
  check('hodiny startují ve dvanáct', started.agent.clock.hours, 0x12);
  // ★ `$396C`: jeden sloupec `$AC` a tři výšky z **`$4EF0`**, což je adresa
  // uvnitř znakové sady šachty — data programu mezi prázdnými glyfy (§14).
  // Bez `charsetShaft` v paměti by agent stál na řádku nula.
  const at = 0x4EF0 - charsetShaft.addr;
  check('tři sprajty agenta stojí v jednom sloupci', started.agent.sprites.x, [0xAC, 0xAC, 0xAC]);
  check('a ve třech výškách z $4EF0', started.agent.sprites.y,
        [charsetShaft.bytes[at], charsetShaft.bytes[at+2], charsetShaft.bytes[at+4]]);

  // a obraz, který z toho vyjde, je opravdu šachta: sada `$02` a `$1A` = 0
  ws.send({message: 'start'});
  ws.tick();
  const shaftFrame = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  check('první snímek nese obraz šachty', !!shaftFrame, true);
  if (shaftFrame) {
    check('a kreslí se sadou šachty', shaftFrame.picture.charset, 1);
    check('a hlásí se jako šachta', shaftFrame.picture.place, 0);
    // ★★ **Za úvodní řečí není na obrazovce panel ani mapa** (nahlásil
    // operátor 2026-09-21): `$72E5` i `$B63B` leží na `$3A08`-`$3A12`, tedy
    // za oběma větami, a `$731C` na `$39F1` dokreslí **šachtu pod oknem**.
    // ★ A **neběží clona**: ve vektoru je `$838C` (`$391E`), obsluha, která
    // jen zvedne `$E0`, takže se obraz nedělí na pruhy a je celý sadou
    // šachty. Model se ptá právě na tohle číslo — kdo si splete „kterou
    // sadou" s „dělí se obraz", nakreslí za řeči šachtu sadou místnosti
    // a grafika se rozsype.
    check('za řeči drží vektor přerušení $838C', shaftFrame.picture.irq, 0x838C);
    check('a panel v obrazu ještě není',
          shaftFrame.picture.screen[15*40] === shaftData.tables.panel.values[0], false);
    check('ani rámeček mapy', shaftFrame.picture.screen[16*40 + 7] === 0xF0, false);
    // ★★ **A hlavní smyčka za rozběhu ještě neběžela**: `$3A15` je až za
    // `$3A12`, takže po celý rozběh jede jen obsluha přerušení. Kdo pustí
    // byť jediný průchod dřív, zavolá `$73E4` (kabina na mapě) dřív, než
    // `$B6FE` postaví její značku — a sprajt 6 skočí doprostřed obrazovky
    // s ukazatelem `$00`, tedy s **obrazovkou místo obrázku**. Vypadá to
    // jako rozsypané sprajty (nahlásil operátor 2026-09-21).
    // ★ Čísla jsou změřená na originálu zastávkou na `$39F4`
    // (`tools/tracestart.py`): sprajty stojí tam, kde je nechal `$AFE5`.
    const sp = shaftFrame.sprites;
    check('sprajty stojí tam, kde je nechal $AFE5',
          [sp.pointer, sp.x, sp.y, sp.enabled, sp.multicolor, sp.expandY],
          [[0x12, 0x9E, 0x9C, 0x9D, 0, 0, 0, 0x11],
           [160, 172, 172, 172, 0, 0, 0, 172],
           [94, 106, 94, 115, 0, 0, 0, 77], 0xCF, 0x01, 0x01]);
  }
  // ★ **Šest přihrádek kapesního počítače jde do modelu zvlášť** (§34): je to
  // okno do **druhé** znakové sady (`$5C50`-`$5FAF`), takže ho nenese ani
  // obraz, ani `glyphs` (ty jsou o sadě místnosti). Bez téhle zprávy by okno
  // v prohlížeči zůstalo tím, co do něj naposled dala mapa, a dílky by
  // v počítači nebyly vidět vůbec.
  const windowFrame = ws.out.filter((o) => o.message === 'frame' && o.window).pop();
  check('a okno počítače přijde taky', !!windowFrame, true);
  if (windowFrame) {
    check('a je to $5C50 a šest přihrádek po $90',
          [windowFrame.window.at, windowFrame.window.bytes.length], [0x5C50, 6*0x90]);
  }
  // ★ A **výtah se rozjede**: tím se pozná, že `$1D`/`$1E` (strop a dno)
  // vyšly z kreslení šachty správně. Kdyby se nultá stránka mazala **až
  // po** losování mapy, přišla by kabina (`$27`/`$28`) o svoje místo,
  // `$1E` by vyšlo na 3 — dno — a výtah by se nehnul.
  const before = shaftFrame ? Array.from(shaftFrame.picture.screen) : [];
  // ★ **Napřed se domluví.** `$BF51` čeká, až přehrávač dořekne (`$BF7E`),
  // takže po celý úvod hlavní smyčka nejede a joystick se nečte; teprve pak
  // se dá jet. ★ Že věta dohrála, říká **čip** (`ChipStream` → `blockDone`
  // → `GameModel` → zpráva `spoken`), takže si to tady harness musí
  // odehrát za hlavní vlákno: až blok dojde, pošle `spoken`.
  for (let i = 0; i < 400; i++) { ws.tick(); }
  ws.send({message: 'input', joystick: 0x7D});         // dolů
  for (let i = 0; i < 40; i++) { ws.tick(); }
  const moved = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  check('výtah se ze startu rozjede dolů',
        !!moved && Array.from(moved.picture.screen).join(',') !== before.join(','), true);
  // ★★ **A je to slyšet jako hučení, ne jako praskání** (nahlásil operátor
  // 2026-09-21). Rozjetý výtah hlavní smyčku vůbec nepustí (`$3A85`,
  // `$3AA4`), takže se po celou jízdu **nedělá doznívání tónu** (`$3A1B`) —
  // a `$25`/`$26` proto stoupají k `$20`/`$18` a tam zůstanou. Přepis to měl
  // uvnitř `plLoop`, tedy za dozníváním, a to tón každý druhý snímek shodilo
  // zpátky na nulu i s oběma hlasy (`$3A22 STA VCREG1`, `$3A25 STA VCREG2`).
  // ★ Žádné `match*` na to nedosáhlo: `matchelevator` měří kroky, ne zvuk,
  // a `matchsound --effects` jízdu do té doby **přeskakoval**. Teď ji měří
  // (`build/sound/sidlift42`), a tohle hlídá tutéž věc v prohlížeči.
  // ★ **Bez prvního snímku jízdy**: v tom ještě proběhl vrchol smyčky
  // šachty, tedy i doznívání (`$3A1B`) — a to je správně, stroj to dělá taky
  // (v záznamu `sidlift42` je to výpis `01=00 04=00 0b=00`). Od druhého už
  // se smyčka nepustí, takže tam žádné zavírání hlasů být nesmí.
  const ridingSid = ws.out.filter((o) => o.message === 'frame' && o.sid
                                        && o.out && o.out.lift)
    .slice(1).flatMap((o) => o.sid);
  const gateOff = ridingSid.filter((w) => (w[1] === 0x04 || w[1] === 0x0B) && w[2] === 0);
  check('za jízdy se hlasy výtahu nezavírají', gateOff.length, 0);
  const pitches = ridingSid.filter((w) => w[1] === 0x01).map((w) => w[2]);
  check('a tón výtahu stoupá', pitches.length > 4 && pitches[pitches.length-1] > pitches[0], true);
  // ★ **Rozběh hry mluví** (`$39F4`, `$39FF`): dvě věty, druhá o `$20`
  // snímků **po konci té první**. Na titulce originál **mlčí** — změřeno, od
  // resetu po `$3855` neproběhl jediný zápis do `$D400`-`$D418` — takže
  // tohle je první zvuk hry (`ZADANI.md` §10.16).
  // ★ **`$20` se počítá od konce, ne od začátku**: `$BF51` po `JSR $0880`
  // čeká, až přehrávač domluví (`$BF7E`-`$BF84`), a teprve `$39FA` odpočítá
  // těch `$20`. Věta 2 trvá 77 snímků, takže gap od začátku by pustil druhou
  // větu doprostřed první — a obě jdou na **týž registr** `$D418`, takže by
  // se promíchaly (nahlásil operátor 2026-09-21).
  // ★ A **až domluví, objeví se obojí naráz** (`$3A08`-`$3A12`): panel,
  // rámeček mapy a herní obsluha přerušení, která teprve dělí obraz na pruhy.
  const after = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  check('po řeči je ve vektoru herní obsluha', after.picture.irq, 0x82E7);
  check('a panel je nakreslený',
        after.picture.screen[15*40], shaftData.tables.panel.values[0]);
  check('a v něm rámeček mapy', after.picture.screen[16*40 + 7], 0xF0);
  // ★ a teprve teď má značka kabiny svůj blok (`$B6FE`: `$43FE` = `$36`)
  const afterSprites = ws.out.filter((o) => o.message === 'frame' && o.sprites).pop();
  check('a značka kabiny svůj blok', afterSprites.sprites.pointer[6], 0x36);

  const spoken = ws.out.filter((o) => o.speech).map((o) => [o.frame, o.speech.word]);
  check('rozběh řekne dvě věty', spoken.map((x) => x[1]), [2, 3]);
  const firstLength = spoken.length === 2
    ? ws.out.filter((o) => o.speech)[0].speech.frames : 0;
  check('a druhou až $20 snímků po konci té první',
        spoken.length === 2 && spoken[1][0] - spoken[0][0], firstLength+0x20);
  check('takže se věty nepřekrývají', firstLength > 0
        && spoken[1][0] - spoken[0][0] > firstLength, true);
  // ★ A **po dobu věty stojí hlavní smyčka**: `$BF51` čeká, `$BF6A CLI` je
  // před tím čekáním, takže obsluha přerušení jede dál. Pozná se to na tom,
  // že se za úvod **nenapsalo do `$D418` nic z kroku agenta** (`$8E77`) —
  // kdyby ano, byla by to padesátka zápisů za vteřinu doprostřed věty.
  const during = ws.out.filter((o) => o.message === 'frame' && o.frame > spoken[0][0]
                               && o.frame < spoken[1][0] && o.sid)
    .reduce((n, o) => n + o.sid.filter((w) => w[1] === 0x18).length, 0);
  check('a po dobu věty do $D418 nepíše nikdo jiný', during, 0);
  ws.send({message: 'stop'});
}

// ★ **A na čí zprávu se čeká: na zprávu čipu.** `$BF51` se ptá přehrávače
// (`$BF7E`), tady se ptá `ChipStream`u — blok vzorků si nese značku a ta se
// vrátí zprávou `blockDone`, kterou `GameModel` přepošle workeru jako
// `spoken` (`app/gameModel.js`). Dokud nepřijde, hlavní smyčka stojí:
// joystick se nečte a výtah se nerozjede. A **přijde i bez zvuku**, protože
// sběrnice, která blok nepřehraje, ho dohlásí sama
// (`AbstractAudioHandler.reportBlocksDone`), takže se hra nemá o co
// zaseknout.
{
  const ws = startWorker();
  ws.send({message: 'init', seed: 4242, fortress: fortressData, rooms: roomsData,
           speech: speechData});
  ws.send({message: 'play', where: 'shaft', global: globalData, sprites: spritesData,
           shaft: shaftData, furniture: furnitureData, terminal: terminalData,
           charset: charsetRoom, charsetShaft: charsetShaft});
  ws.send({message: 'start'});
  ws.tickNoChip();
  const first = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  const screen0 = first ? Array.from(first.picture.screen) : [];
  ws.send({message: 'input', joystick: 0x7D});         // dolů
  for (let i = 0; i < 300; i++) { ws.tickNoChip(); }
  const stuck = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  check('bez zprávy od čipu svět stojí a výtah se nerozjede',
        !!stuck && Array.from(stuck.picture.screen).join(',') === screen0.join(','), true);
  // ★ ale **obsluha přerušení jede** (`$BF6A CLI` je před čekáním), takže
  // čítač snímků roste a hodiny tikají
  const last = ws.out.filter((o) => o.message === 'frame').pop();
  check('ale snímky běží dál', last.frame > 300, true);
  // a jakmile čip ohlásí dohrání obou vět, svět se rozjede
  const said = ws.out.filter((o) => o.speech);
  check('a mezitím se řekla jen první věta', said.length, 1);
  ws.send({message: 'spoken', ids: [said[0].speech.id]});
  for (let i = 0; i < 400; i++) { ws.tick(); }
  const went = ws.out.filter((o) => o.message === 'frame' && o.picture).pop();
  check('po zprávě od čipu se rozjede',
        Array.from(went.picture.screen).join(',') !== screen0.join(','), true);
  check('a jsou to bloky vzorků s kadencí 101 cyklů',
        ws.out.filter((o) => o.speech).every((o) => o.speech.cadence === 101
                                                    && o.speech.register === 0x18
                                                    && o.speech.samples.length > 0), true);
  ws.send({message: 'stop'});
}

// ★ **Konec hry ve workeru** (M5, §33). `matchend` měří `app/endGame.js`
// proti originálu bajt po bajtu, ale na **spojení s workerem** nedosáhne:
// začíná z výpisu paměti a končí na poslední zastávce. Že hodiny vypršely,
// že se svět zastavil a že se síň slávy vrátila na hlavní vlákno, se proto
// hlídá tady — stejně jako `seedMemory` a start v šachtě.
{
  const we = startWorker();
  we.send({message: 'init', seed: 4242, fortress: fortressData, rooms: roomsData,
           speech: speechData, end: endData});
  // ★ Hodiny se **nastaví**, nevyčkají: šest herních hodin je 1 296 000 tiků.
  // Je to stav, ne záplata — přetečení pak udělá `plClockAdd` sama, tedy táž
  // rutina, kterou hodiny tikají celou hru (`$83C2`).
  we.send({message: 'play', where: 'shaft', global: globalData, sprites: spritesData,
           shaft: shaftData, furniture: furnitureData, terminal: terminalData,
           charset: charsetRoom, charsetShaft: charsetShaft,
           clock: [0x05, 0x59, 0x59]});
  we.send({message: 'start'});
  we.tick();
  const before = we.out.length;
  // vteřina hodin je 60 snímků, takže na přetečení minuty stačí 61 tiků;
  // pak třes (128 kol), rozpad (128) a tabule — dohromady pod tři stovky.
  // ★ A před tím vším **celý rozběh** (dvě věty, 322 snímků): hodiny sice
  // vyprší už v něm, ale `$83EA` je **vrchol hlavní smyčky**, a ta za řeči
  // neběží (§22), takže konec hry začne teprve za ní — na stroji taky.
  let over = null;
  for (let i = 0; i < 900 && !over; i++) {
    we.tick();
    over = (we.out.slice(before).filter((o) => o.gameOver).pop() || {}).gameOver || null;
  }
  check('vypršení času skončí hru', !!over, true);
  if (over) {
    // ★ **Rámeček zbělá a zčerná** (`$8402`, `$84B7`) a `$43` = `$FF` — to je
    // to, co konec hry pustilo (`$83DF`)
    check('hodiny stojí na šesté', over.hours, 0x06);
    // ★ Prázdná hra, tedy nula nalezených a nula zbývajících vteřin: skóre
    // musí být **nula celá**, ne „skoro nula"
    check('a skóre je nula', over.score, [0, 0, 0]);
    check('síň slávy má šestnáct položek', over.fame.length, 16);
    check('a nulové skóre se do ní nevejde', over.entered, null);
    // ★ **Svět se zastavil**: po tabuli už žádný snímek se světem nechodí,
    // protože `endingTick` shodí `playing` (na stroji to dělá `SEI`)
    const after = we.out.length;
    we.tick(); we.tick();
    check('a po tabuli už svět netiká',
          we.out.slice(after).some((o) => o.agent), false);
  }
  // ★ **A řeč**: konec hry časem řekne **větu 5** (`$8407`) a je to poslední,
  // co se v té hře řekne. ★ Věta **0** je konec, který časem **není**
  // (`$B86E`, řídicí místnost), a ta tady padnout nesmí — do M6 by si toho
  // nikdo nevšiml, protože řeč nikdo nepřehrával.
  // (Věta 3 v seznamu je druhá věta rozběhu hry, `$39FF` o `$20` snímků
  // za první — ta se stihne dávno před přetečením hodin.)
  const said = we.out.slice(before).filter((o) => o.speech).map((o) => o.speech.word);
  check('konec hry časem řekne větu 5 a je poslední', said[said.length-1], 5);
  check('a větu 0, tedy dokončenou misi, neřekne', said.indexOf(0), -1);
  we.send({message: 'stop'});
}

// ★ A **tabule se skóre**: síň slávy, do které se skóre vejde, si vyžádá
// jméno — a to je vstup, jako joystick (zpráva `name`, §33).
{
  const wn = startWorker();
  wn.send({message: 'init', seed: 77, fortress: fortressData, rooms: roomsData,
           speech: speechData, end: endData});
  // ★ nálezy se dosadí: skóre se počítá z `$D6`-`$D8` (§33) a nasbírat je
  // chůzí po pevnosti je měření prohledávání, ne konce hry
  wn.send({message: 'play', where: 'shaft', global: globalData, sprites: spritesData,
           shaft: shaftData, furniture: furnitureData, terminal: terminalData,
           charset: charsetRoom, charsetShaft: charsetShaft,
           clock: [0x05, 0x59, 0x59], found: [0x24, 7, 9]});
  wn.send({message: 'start'});
  wn.tick();
  let asking = false, over = null;
  // ★ i tady se čeká na rozběh: hlavní smyčka začíná až za oběma větami
  for (let i = 0; i < 900 && !asking; i++) {
    wn.tick();
    asking = wn.out.some((o) => o.enteringName);
  }
  check('skóre 8 800 si vyžádá jméno', asking, true);
  // pět znaků: `a` je `$71` v sadě šachty (§14)
  for (const code of [0x71, 0x77, 0x75, 0x7E, 0x84]) {
    wn.send({message: 'name', key: code});
    wn.tick();
  }
  over = (wn.out.filter((o) => o.gameOver).pop() || {}).gameOver || null;
  check('a po pátém znaku je tabule hotová', !!over, true);
  if (over) {
    // 36 dílků + 7 hesel po stovce a 9 skládaček po pěti stech = 8 800
    check('skóre je 8 800 v BCD', over.score, [0x00, 0x88, 0x00]);
    check('jméno se uložilo', over.entered && over.entered.name,
          [0x71, 0x77, 0x75, 0x7E, 0x84]);
    check('a je na prvním místě', over.entered && over.entered.index, 0);
    check('což v síni slávy opravdu stojí', over.fame[0].score, [0x00, 0x88, 0x00]);
  }
  wn.send({message: 'stop'});
}

const w3 = startWorker();
w3.send({message: 'init', seed: 999, fortress: fortressData, rooms: roomsData});
const other = [];
for (let i = 0; i < 8; i++) {
  w3.send({message: 'random'});
  other.push(w3.out[w3.out.length-1].value);
}
check('jiné semínko dá jinou posloupnost', other.every((v, i) => v === values[i]), false);
check('jiné semínko dá jinou pevnost',
      JSON.stringify(w3.out[0].fortress) === JSON.stringify(fortress), false);

// ★ **Kapesní počítač** (M5, §34). Tohle je zase to, na co žádné `match*`
// nedosáhne: každé měřidlo začíná z výpisu paměti originálu, kde tabulky
// počítače i šestnáct tvarů dílku dávno jsou — do paměti přepisu je musí
// položit `pocketComputer.seedMemory`, a jestli to dělá, se pozná jen tady.
const pcMem = globalThis.roomsLoader.memory(roomsData);
const pcM = {mem: pcMem, color: new Uint8Array(0x400),
             vic: new Uint8Array(0x2F), entropy: () => 0x42};
globalThis.player.seedMemory(pcMem, globalData, spritesData, furnitureData,
                             terminalData, charsetShaft, pcM, computerData, puzzleData);
check('tabulka X šesti přihrádek je v paměti',
      Array.from(pcMem.subarray(0x720C, 0x7212)), computerData.tables.slotX.values);
check('a adresy jejich barevné paměti',
      Array.from(pcMem.subarray(0x7A55, 0x7A5B)), computerData.tables.slotColorLo.values);
check('a osm hlášek počítače',
      Array.from(pcMem.subarray(0x81FB, 0x82AB)), computerData.tables.messages.values);
check('a obrazovka telefonu',
      Array.from(pcMem.subarray(0x7C44, 0x7CF4)), computerData.tables.phoneScreen.values);
// ★ **Šestnáct tvarů dílku `$2763`**: veze je `data/puzzle.json` od M2, ale
// do paměti je do M5 nikdo nesypal, protože se `$9C3A` nevolalo. Bez nich
// je každý složený dílek prázdný.
check('šestnáct tvarů dílku je v paměti',
      Array.from(pcMem.subarray(0x2763, 0x2763 + 0x90)),
      puzzleData.shapes[0].bytes);
check('a poslední z nich taky',
      Array.from(pcMem.subarray(0x2763 + 15*0x90, 0x2763 + 16*0x90)),
      puzzleData.shapes[15].bytes);
// ★ Přihrádka je `$5C50 + $90*n`, a `$82AB` to **nepočítá násobením**:
// s `$FF`, které mu podá `$80B6` bez vybrané přihrádky, vyjde `$DCC0`
check('adresy šesti přihrádek', [0, 1, 2, 3, 4, 5].map(globalThis.pocketComputer.slotAddr),
      [0x5C50, 0x5CE0, 0x5D70, 0x5E00, 0x5E90, 0x5F20]);
check('a bez vybrané přihrádky vyjde $DCC0, ne $EBC0',
      globalThis.pocketComputer.slotAddr(0xFF), 0xDCC0);

// ★ **První dva nálezy si lehnou rovnou do okna** (`$9976`): `$C690` je
// odložená kopie přihrádky 0 a jde tam **obrácený** obrázek. Do M5 to
// v `app/furniture.js` chybělo a bylo to přiznané (§34).
globalThis.pocketComputer.compose(pcM, 7);
const pcWant = Array.from(pcMem.subarray(0x5000, 0x5090)).map((b) => b ^ 0xFF);
const pcParked = pcMem.subarray(0xC690, 0xC720).slice();
pcMem.fill(0, 0x4EF5, 0x4EF8);
pcMem[0x4EF5] = 0xFF;
pcM.vic[0x21] = 0x06;
globalThis.furniture.foundPiece(pcM, 7);
check('nález dílku ho složí a obrátí do $C690',
      Array.from(pcMem.subarray(0xC690, 0xC720)), pcWant);
check('a je to jiné, než tam bylo', JSON.stringify(Array.from(pcParked)) ===
      JSON.stringify(Array.from(pcMem.subarray(0xC690, 0xC720))), false);
check('a přihrádka 0 se označí za obsazenou', [pcMem[0x92], pcMem[0x98]], [0x01, 0x06]);
check('a dílek se zapíše do seznamu', [pcMem[0x4EF5], pcMem[0x4EF6], pcMem[0x4F25]],
      [7, 0xFF, 0x06]);

// ★ **Dvě zvláštní místnosti** (M5, §35). Zase to, na co `match*` nedosáhne:
// `tracespecial.py` do rutin skáče rovnou, takže nábytek, který je otevírá,
// a obrázek, který si vstup hry odstěhoval zpod programu, nikdo jiný nehlídá.
const spMem = globalThis.roomsLoader.memory(roomsData);
const spM = {mem: spMem, color: new Uint8Array(0x400),
             vic: new Uint8Array(0x2F), entropy: () => 0x42};
globalThis.player.seedMemory(spMem, globalData, spritesData, furnitureData,
                             terminalData, charsetShaft, spM, computerData,
                             puzzleData, specialData);
check('osm tónů kódové místnosti je v paměti',
      Array.from(spMem.subarray(0xA9F8, 0xAA00)), specialData.tables.freqLo.values);
check('a délky bouří blikání řídicí',
      Array.from(spMem.subarray(0xAB67, 0xAB6E)), specialData.control.rounds.values);
// ★ `$71C0` při vstupu hry (`$3868`) odstěhuje obrázek řídicí místnosti zpod
// programu: `$C400` na `$DC00` a `$C000` na `$F800`. Bez toho by se do banky 3
// zkopírovalo, co po sobě nechala místnost, kapesní počítač a tabulka zrcadlení.
check('obrázek řídicí místnosti leží na $DC00',
      Array.from(spMem.subarray(0xDC00, 0xDC40)),
      specialData.picture.screenBytes.slice(0, 0x40));
check('a jeho barvy na $F800',
      Array.from(spMem.subarray(0xF800, 0xF840)),
      specialData.picture.colorBytes.slice(0, 0x40));
check('a není to prázdno',
      specialData.picture.screenBytes.filter((b) => b).length > 500, true);

// ★ **Nábytek, který není nábytek**: `$FB` je kódová místnost, `$FE` řídicí
const spSearch = {at: 0, phase: 'wipe', unsupported: 0, found: 0, empty: 0,
                  gaveUp: 0, died: 0};
spMem[0xE4] = 0;
spMem[0x4F5A] = 0xFB;                       // `$4F55` + 5, tedy `holds` (§27)
spMem[0x7E] = 0x11;
globalThis.furniture.dispatch(spM, spSearch);
check('nábytek s $FB otevře kódovou místnost', spSearch.phase, 'codeRoom');
check('a už se z ní nevrací (`$990B` je `JMP`)', !!spSearch.code, true);
// ★ Řídicí místnost bez celého hesla **jen mlčky odmítne** (`$AA42`) a je
// k nerozeznání od prázdného kusu nábytku
const spCtrl = {at: 0, phase: 'wipe', unsupported: 0, found: 0, empty: 0,
                gaveUp: 0, died: 0};
spMem[0x4F5A] = 0xFE;
for (let i = 0; i < 9; i++) { spMem[0x345D + i] = 0x53; }
globalThis.furniture.dispatch(spM, spCtrl);
check('řídicí místnost bez hesla mlčí', spCtrl.phase, 'empty');
const spOpen = {at: 0, phase: 'wipe', unsupported: 0, found: 0, empty: 0,
                gaveUp: 0, died: 0};
for (let i = 0; i < 9; i++) { spMem[0x345D + i] = 0x71 + i; }
globalThis.furniture.dispatch(spM, spOpen);
check('a s ním se otevře', spOpen.phase, 'controlRoom');
// ★ a kde ty tři kusy nábytku leží, plyne ze **záznamů místností**, ne z losu
check('kódové místnosti jsou dvě', specialData.rooms.code, [17, 27]);
check('a řídicí jedna', specialData.rooms.control, [5]);

// ★★ **Koule neprojde plošinou výtahu** (`$9431`-`$9481`, §24). Vodorovné
// vytlačení (`$93F0`) bere za pevné jen znaky `$45`-`$4B`, ale **svislé**
// všechno, co `$8CC3` ohlásí, tedy `$45`-`$51` — a v tom rozsahu leží
// plošiny. Ta svislá půlka v přepisu chyběla: koule se do plošiny zanořila
// a vodorovné vytlačení ji pak snímek co snímek hnalo o osm pixelů doprava,
// až dojela ke zdi (nahlásil operátor 2026-09-21).
// ★ **Žádný záznam na to nedosáhne**: v místnostech, kde se to děje, originál
// nestíhá smyčku ve snímku (§10.6), takže se měřidlo zastaví dřív — proto se
// to hlídá tady, a hlídá se **příznak**, ne čísla: koule musí zůstat
// v místnosti a někde se zastavit.
{
  const ORB_ROOM = 31;                       // koule a tři výtahy (`data/rooms.json`)
  const mem = globalThis.roomsLoader.memory(roomsData);
  const m = {mem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
  m.entropy = () => 0x42;
  globalThis.player.seedMemory(mem, globalData, spritesData, furnitureData, terminalData,
                               charsetShaft, m, computerData, puzzleData, specialData);
  for (let i = 0; i < charsetRoom.bytes.length; i++) { mem[0x5000 + i] = charsetRoom.bytes[i]; }
  globalThis.player.startRoom(m, ORB_ROOM, 0);
  // ★ `$6D` shodí `plNewGameLists` (`$39BF`), protože prohlížečka místností
  // začíná tam, kde hra začíná šachtou; v místnosti ho sází stavitel
  mem[0x6D] = 0x00;
  const seen = [];
  for (let f = 0; f < 600; f++) {
    globalThis.player.frame(m, 0x7F, 1);
    seen.push([m.vic[0] | ((m.vic[0x10] & 1) << 8), m.vic[1]]);
  }
  const xs = seen.map((p) => p[0]);
  // pravá zeď místnosti je na `$158`; bez svislého vytlačení se koule zarazí
  // přesně o ni a zůstane tam
  check('koule se nedostane ke zdi', Math.max(...xs) < 0x150, true);
  const rest = seen.slice(-40);
  check('a někde se zastaví',
        rest.every((p) => p[0] === rest[0][0] && p[1] === rest[0][1]), true);
}

// ★★ **A oknem prohledávání koule neproletí** (`$9482`, §24). Znaky okna
// jsou `$00`-`$1F`, tedy mimo pevný rozsah, takže `$8CC3` řekne „prázdno"
// — a kdyby se už nikdo nezeptal, koule by bublinou i tím, co je pod ní,
// prolétla (nahlásil operátor 2026-09-21). `$9482` se proto podívá, jestli
// buňka padla **do okna** (čtyři řádky po osmi znacích od `$10`/`$11`),
// a jestli ano, rozhodne podle **`$C100`**, tedy podle místnosti, jak
// vypadala, než ji okno překrylo.
// ★ **Žádný záznam na to nedosáhne**: `tracesearch` roboty i kouli vypíná
// (`$92C1` je přepsané na `RTS`) a v záznamech s koulí se zase
// neprohledává — proto se tu měří **rutina samotná**.
{
  const mem = new Uint8Array(0x10000);
  const m = {mem, color: new Uint8Array(0x400), vic: new Uint8Array(0x2F)};
  const set = (window, row, column, ch) => {
    mem[0x3F] = 0x0F;                       // agent prohledává
    mem[0x10] = window & 0xFF; mem[0x11] = window >> 8;
    mem[0x7C] = row & 0xFF; mem[0x7D] = row >> 8;
    mem[0xC100 + ch.at] = ch.byte;
    return globalThis.orb.underWindow(m, column);
  };
  // první řádek okna, pátý znak → `$C105`
  check('pod oknem rozhoduje $C100', set(0x4100, 0x4100, 5, {at: 5, byte: 0x47}), true);
  check('a prázdné místo tam neplatí', set(0x4100, 0x4100, 5, {at: 5, byte: 0x44}), false);
  // ★ druhý řádek okna je o **celý řádek obrazovky** dál, ale v `$C100`
  // hned za prvním: `$28` na obrazovce, `$08` v okně
  check('druhý řádek okna je o $28 dál',
        set(0x4100, 0x4100, 0x28 + 3, {at: 0x0B, byte: 0x47}), true);
  // devátý sloupec je **za oknem**, tam okno nerozhoduje
  check('devátý sloupec je mimo okno', set(0x4100, 0x4100, 8, {at: 8, byte: 0x47}), false);
  // a bez prohledávání se okno neptá vůbec
  mem[0x3F] = 0x0E;
  check('a bez prohledávání se okno neptá', globalThis.orb.underWindow(m, 5), false);
}

console.log(`runworker: ${checks} kontrol, ${differences} rozdílů`);
process.exit(differences);
