// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The robots (`$8ECA`, `sources/docs/disasm_notes.md` §24).
 *
 * ★ **A robot is not a state machine, it is a program.** Each one carries an
 * index into a single stream of bytes at `$2112` (§17) and every frame the
 * game runs the next instruction of it. The stream is shared: which program
 * a robot gets is **shuffled** when the fortress is (first phase of `$7236`),
 * so the same room is patrolled differently in every game.
 *
 * ★ The instruction set is decoded by **shifting the byte left** and looking
 * at what falls out (`$8F0B` onwards), not by a jump table:
 *
 * | first bits | what it does |
 * |---|---|
 * | `0…` | **move** — walk the robot along its platform (`$90AC`) |
 * | `10…` | jump inside the program, six bits signed (`$8F11`) |
 * | `110…` | wait for the ball (`$90A0`) |
 * | `1110…` | turn towards the agent (`$905B`) |
 * | `11110…` | look for the agent (`$8FD7`) |
 * | `111110…` | set the robot's speed (`$9047`) |
 * | `111111…` | **fire** (`$8F3D`) |
 *
 * Four bytes of zero page hold a robot, and `X` walks them six at a time:
 * `$55,X` is where it is in the program, `$56,X` its flags and speed,
 * `$57,X` the instruction it is still working on (`$FF` = fetch the next
 * one), `$58,X`/`$59,X` the screen address under it and `$5A,X` the
 * sub-column it has walked to.
 *
 * ★ And the whole thing runs in the **interrupt** (`$8340`), once a frame,
 * and only in a room — in the shaft `$82F8` skips it (§5).
 */

/** the frame counter of the interrupt, and the game's own counters */
var RBT_FRAME = 0xE0, RBT_TICK = 0x44;

/** ★ `$47` is the **snooze**: while it is not `$FF` the robots do not run */
var RBT_SNOOZE = 0x47;

/** which robot is being run, as an index and as twice an index (`$8EF6`) */
var RBT_INDEX = 0x48, RBT_INDEX2 = 0x49;

/** the three flags the frame collects to decide what the SID keeps playing */
var RBT_SOUND2 = 0x4A, RBT_SOUND_ANY = 0x4E, RBT_SOUND3 = 0x4F;

/** scratch the decoder works in */
var RBT_WORK = 0x4D;

/** the last robot's offset, and the six bytes each one has */
var RBT_LAST = 0x54, RBT_PC = 0x55, RBT_FLAGS = 0x56, RBT_OP = 0x57,
    RBT_ADDR = 0x58, RBT_SUB = 0x5A, RBT_STRIDE = 6;

/** the stream every robot's program is cut out of (§17) */
var RBT_PROGRAMS = 0x2112;

/** the agent: his state, and the sprites the robots aim at */
var RBT_AGENT_STATE = 0x3F, RBT_SEARCHING = 0x0F;

/** the masks of the ninth bit of x, one a sprite (`$0E6C`, §12) */
var RBT_MSB_MASKS = 0x0E6C;

/** where the sprite pointers of the robots live, and the orb's flag */
var RBT_POINTERS = 0x43FC, RBT_ORB_FLAG = 0x6D;

function rbtByte(v) { return v & 0xFF; }
function rbtLoad(m, a) { return rbLoad(m, a); }
function rbtStore(m, a, v) { rbStore(m, a, v); }

/**
 * `$9207` — the robots flash: every eight frames all four take the other of
 * the two colours the room's record gave them (`$4B`, `$4C`).
 * ★ `$DC` stops it — that is the byte the pocket computer and the speech set.
 * @param {Object} m - The machine.
 */
function rbtColours(m) {
  if (rbtLoad(m, 0xDC)) { return; }
  var y = (rbtLoad(m, RBT_FRAME) & 0x08) ? 0 : 1;
  var c = rbtLoad(m, 0x4B + y);
  for (var i = 3; i >= 0; i--) { rbtStore(m, 0xD02B + i, c); }
} // rbtColours

/**
 * `$9244`, `$9220`, `$9265` — the three voices of a robot, and from M6 the
 * SID with them (`app/sound.js`). The counter the frame uses to decide
 * whether a voice keeps sounding is kept here as before.
 *
 * ★ **`$9220` has no `RTS`: it falls through into `$9244`** (`$9242 INC $4A`
 * is the only thing between them). So a robot that moves sets voice 2 **and
 * voice 1 right after it** — the frame's writes are `$9244` once from
 * `$8EEA` and then a pair for every robot that moves, which is why the
 * original writes the SID about twice as often as a reading of `$9220`
 * alone suggests. Measured: `matchsound --effects` counted 5 452 writes in
 * 200 frames against 3 440 in the transcript until this was put back.
 *
 * @param {Object} m - The machine.
 * @param {number} voice - 1, 2 or 3.
 */
function rbtVoice(m, voice) {
  if (voice === 1) { sndRobotFire(m); return; }             // `$9244`
  if (voice === 3) { sndRobotThird(m); return; }            // `$9265`
  sndRobotMove(m);                                          // `$9220`
  rbtStore(m, RBT_SOUND2, rbtByte(rbtLoad(m, RBT_SOUND2) + 1));   // `$9242 INC $4A`
  sndRobotFire(m);                                          // `$9244`, propadnutím
} // rbtVoice

/**
 * `$9289` — the instruction's own counter ticks down, and at every
 * thirty-second step the robot is told to fetch the next one.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @returns {number} What the counter was.
 */
function rbtTick(m, x) {
  var a = rbtLoad(m, RBT_OP + x);
  rbtStore(m, RBT_OP + x, rbtByte(a - 1));
  if (!(a & 0x1F)) { rbtStore(m, RBT_OP + x, 0xFF); }
  return a;
} // rbtTick

/**
 * The ninth bit of a robot's x, which lives in `$D010` and is picked out by
 * the mask table `$0E6C`.
 * @param {Object} m - The machine.
 * @param {number} index - Which robot, 0 to 3.
 * @returns {number} 1 or 0.
 */
function rbtMsb(m, index) {
  return (rbtLoad(m, RBT_MSB_MASKS + index) & rbtLoad(m, 0xD010)) ? 1 : 0;
} // rbtMsb

/**
 * `$8ECA` — the robots, once a frame, from the interrupt.
 *
 * ★ Two things happen before any robot runs. `$44` goes up, which is the
 * counter the slower instructions divide down; and **the snooze is checked**:
 * while `$47` is not `$FF` nothing moves, and `$47` crawls back up one every
 * fourth frame until it is.
 *
 * @param {Object} m - The machine.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 * @returns {number} How many robots were run.
 */
function rbtFrame(m, entropy) {
  rbtStore(m, RBT_TICK, rbtByte(rbtLoad(m, RBT_TICK) + 1));
  rbtStore(m, RBT_SOUND2, 0);
  rbtStore(m, RBT_SOUND_ANY, 0);
  rbtStore(m, RBT_SOUND3, 0);
  if (rbtLoad(m, RBT_SNOOZE) !== 0xFF) {                  // `$8ED4`
    if (!(rbtLoad(m, RBT_FRAME) & 0x03)) {
      rbtStore(m, RBT_SNOOZE, rbtByte(rbtLoad(m, RBT_SNOOZE) + 1));
    }
    return 0;
  }
  var x = rbtLoad(m, RBT_LAST);
  if (x & 0x80) { return 0; }                             // `$8EE5`, žádní roboti
  rbtColours(m);                                          // `$9207`
  rbtVoice(m, 1);                                         // `$9244`
  // `$8EED` — `$48` je pořadí robota (X po šesti), `$49` je jeho dvojnásobek
  var index = 0, a = x;
  for (;;) { a = a - 6; if (a < 0) { break; } index++; }
  rbtStore(m, RBT_INDEX, index);
  rbtStore(m, RBT_INDEX2, rbtByte(index << 1));

  var ran = 0;
  for (;;) {
    rbtRun(m, x, entropy);
    ran++;
    // `$91C2` — a o robota níž
    rbtStore(m, RBT_INDEX, rbtByte(rbtLoad(m, RBT_INDEX) - 1));
    rbtStore(m, RBT_INDEX2, rbtByte(rbtLoad(m, RBT_INDEX2) - 2));
    x -= RBT_STRIDE;
    if (x < 0) { break; }
  }
  rbtAfter(m);
  return ran;
} // rbtFrame

/**
 * `$91D2` — what the frame does once every robot has run: the voices that
 * nobody asked for this frame go quiet, and the orb is turned off if the
 * room has none.
 * @param {Object} m - The machine.
 */
function rbtAfter(m) {
  if (!rbtLoad(m, RBT_SOUND2)) { rbtStore(m, 0xD40B, 0); }
  if (rbtLoad(m, RBT_SOUND_ANY)) { return; }
  if (!rbtLoad(m, RBT_SOUND3)
      && rbtLoad(m, RBT_AGENT_STATE) === RBT_SEARCHING) {
    rbtStore(m, 0xD412, 0);
  }
  if (rbtLoad(m, RBT_ORB_FLAG) & 0x80) {
    rbtStore(m, 0xD015, rbtLoad(m, 0xD015) & 0xFE);
  }
} // rbtAfter

/**
 * `$8EFC` — one robot: fetch an instruction if the last one is finished, and
 * then run it. ★ The fetch is `$8F02`: `$55,X` is the index into the stream
 * and it goes **up by one** every time, so a program is read forwards and
 * only the jump instruction moves it about.
 *
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset in zero page.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 */
function rbtRun(m, x, entropy) {
  var a = rbtLoad(m, RBT_OP + x);
  if (a !== 0xFF) {                                       // `$8EFE`
    if (rbtDispatch(m, x, a, entropy) !== 'again') { return; }
  }
  // ★ `$902A` a spol. skáčou na `$8F02`, tedy **rovnou na natažení**, ne na
  // test `$FF` — instrukce, která řekne „další", tím vždycky posune program
  for (var guard = 0; guard < 0x100; guard++) {
    var pc = rbtLoad(m, RBT_PC + x);
    rbtStore(m, RBT_PC + x, rbtByte(pc + 1));
    a = rbtLoad(m, (RBT_PROGRAMS + pc) & 0xFFFF);
    rbtStore(m, RBT_OP + x, a);
    if (rbtDispatch(m, x, a, entropy) !== 'again') { return; }
  }
} // rbtRun

/**
 * `$8F0B` — the decoder. ★ It is a **chain of `ASL`**, so each handler is
 * entered with the byte **already shifted** by as many places as it took to
 * get there, and some of them go on shifting it. Transcribing the original
 * byte instead of the shifted accumulator is the one mistake that makes a
 * robot look almost right and behave wrongly.
 *
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 * @param {function(): number} entropy - What `$D012` would give the mixer.
 * @returns {string} `'again'` when the robot is to run another instruction.
 */
function rbtDispatch(m, x, a, entropy) {
  if (!(a & 0x80)) { rbtMove(m, x, a); return ''; }       // `$8F0E` → `$90AC`
  if (a & 0x40) { rbtJump(m, x, a); return 'again'; }     // `$8F12` → skok
  if (a & 0x20) { rbtWaitOrb(m, x); return ''; }          // `$8F26` → `$90A0`
  if (!(a & 0x10)) { rbtFace(m, x, a, entropy); return ''; }   // `$8F2C` → `$905B`
  if (a & 0x08) { return rbtLook(m, x, a, entropy); }     // `$8F32` → `$8FD7`
  if (!(a & 0x04)) { rbtSpeed(m, x, a); return ''; }      // `$8F38` → `$9047`
  rbtFire(m, x, a);                                       // `$8F3D`
  return '';
} // rbtDispatch

/**
 * `$8F11` — a jump inside the program: six bits, signed, added to `$55,X`.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtJump(m, x, a) {
  // `$8F14` a `$8F15` posunou ještě dvakrát; do přenosu vypadne **bit 5**
  var negative = (a & 0x20) !== 0;
  var delta = a & 0x3F;
  if (negative) { delta |= 0xC0; }
  rbtStore(m, RBT_PC + x, rbtByte(rbtLoad(m, RBT_PC + x) + delta));
  rbtStore(m, RBT_OP + x, 0xFF);
} // rbtJump

/**
 * `$9047` — the robot's speed: the bottom two bits of the instruction go
 * into its flags, and the instruction is done with.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtSpeed(m, x, a) {
  var speed = a & 0x03;
  rbtStore(m, RBT_FLAGS + x, (rbtLoad(m, RBT_FLAGS + x) & 0xFC) | speed);
  rbtStore(m, RBT_OP + x, 0xFF);
} // rbtSpeed

/**
 * `$90A0` — wait until the orb comes round: every fourth frame the orb's
 * voice is kicked, and the instruction stays.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 */
function rbtWaitOrb(m, x) {
  // `$90A6` — a je to **tik instrukce** (`$9289`), ne zvuk: každý čtvrtý
  // průchod ubere z `$57,X` jedničku, takže čekání má konečnou délku
  if (!(rbtLoad(m, RBT_TICK) & 0x03)) { rbtTick(m, x); }
} // rbtWaitOrb

/**
 * `$905B` — turn to face the agent: which way the robot looks is its sprite
 * pointer, `$C0` one way and `$C6` the other, and `$57,X` keeps the phase of
 * the turn in its bottom nibble.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtFace(m, x, a, entropy) {
  var index = rbtLoad(m, RBT_INDEX), index2 = rbtLoad(m, RBT_INDEX2);
  var agent = (rbtLoad(m, 0xD010) >> 2) & 1;
  var agentX = ((agent << 8) | rbtLoad(m, 0xD002)) >> 1;
  var mine = ((rbtMsb(m, index) << 8) | rbtLoad(m, 0xD008 + index2)) >> 1;
  var left = mine < agentX;                               // `$9078 CMP`
  var op = (rbtLoad(m, RBT_OP + x) & 0x0F) | (left ? 0 : 0x20);
  rbtStore(m, RBT_OP + x, op);
  var pointer = rbtLoad(m, RBT_POINTERS + index);
  var want = left ? 0xC0 : 0xC6, set = left ? 0x65 : 0x45;
  if (pointer !== want) { rbtStore(m, RBT_OP + x, set); }
  // `$909B` — a hned se ta nová instrukce provede
  rbtDispatch(m, x, rbtLoad(m, RBT_OP + x), entropy);
} // rbtFace

/**
 * `$8FD7` — does the robot see the agent? ★ It is a **stack of conditions
 * folded into one byte**: the robot's x against the agent's, which way it is
 * looking, and whether the two are within twenty raster lines of each other
 * (`$901A CMP #$14`). The answer decides whether the program steps on.
 *
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 * @returns {boolean} True when the program is to fetch the next instruction.
 */
function rbtLook(m, x, a, entropy) {
  // ★ sem se přijde s bajtem posunutým **čtyřikrát**; `$8FD7` posune popáté
  if (rbtByte(a << 5) & 0x80) { return rbtGiveUp(m, x, entropy); }  // `$9037`
  if (!(rbtByte(a << 6) & 0x80)) {                        // `$902D`
    var v = rbtByte(rbtByte(a << 7) ^ rbtLoad(m, RBT_FLAGS + x));
    if (!(v & 0x80)) { rbtStore(m, RBT_PC + x, rbtByte(rbtLoad(m, RBT_PC + x) + 1)); }
    return 'again';
  }
  // ★ `$8FDD` a dál: rozhodnutí se **skládá po bitu 7** do `$4D` a teprve
  // nakonec se porovná s bajtem instrukce, který si `$8FDD PHA` odložil —
  // takže **bit 0 instrukce obrací smysl** celé podmínky.
  var saved = rbtByte(a << 7);                            // `$8FDD PHA`
  var index = rbtLoad(m, RBT_INDEX), index2 = rbtLoad(m, RBT_INDEX2);
  var work = rbtByte(((rbtMsb(m, index) << 7) | (rbtLoad(m, 0xD008 + index2) >> 1)));
  var agentHalf = rbtByte((((rbtLoad(m, 0xD010) >> 1) & 1) << 7)
                          | (rbtLoad(m, 0xD002) >> 1));   // `$8FF9`
  var carry = agentHalf >= work ? 1 : 0;                  // `$8FFD CMP $4D`
  work = rbtByte((carry << 7) | (work >> 1));             // `$8FFF ROR $4D`
  var pointer = rbtLoad(m, RBT_POINTERS + index);
  var facing = rbtByte(((pointer >= 0xC3 ? 1 : 0) << 7) | (pointer >> 1));
  work = rbtByte(facing ^ work);                          // `$9007`
  var dy = rbtLoad(m, 0xD009 + index2) - rbtLoad(m, 0xD007);
  var far = dy >= 0 ? dy : rbtByte(rbtByte(dy ^ 0xFF) + 1);
  var near = rbtByte((((far >= 0x14 ? 1 : 0) << 7) | (far >> 1)) ^ 0x80);
  work = rbtByte(near & work);                            // `$901F`
  rbtStore(m, RBT_WORK, work);
  if (rbtByte(saved ^ work) & 0x80) {                     // `$9026 BPL`
    rbtStore(m, RBT_PC + x, rbtByte(rbtLoad(m, RBT_PC + x) + 1));
  }
  return 'again';
} // rbtLook

/**
 * `$9037` — the robot gives up on the instruction, and **a coin toss out of
 * the mixer** decides whether the program skips one (`$903E BIT $EB`).
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} input - What the mixer mixes in.
 */
function rbtGiveUp(m, x, entropy) {
  rbtStore(m, RBT_OP + x, 0xFF);
  fgRandom(m.mem, entropy());
  // ★ `$9040 BVC` přeskočí `INC`, když je přetečení **shozené** — program se
  // tedy posune o jedna, když je v `$EB` **bit 6 nastavený**
  if (m.mem[0xEB] & 0x40) {
    rbtStore(m, RBT_PC + x, rbtByte(rbtLoad(m, RBT_PC + x) + 1));
  }
  return 'again';
} // rbtGiveUp

/**
 * `$8F3D` — the robot fires. ★ The bolt is **sprite 0**, borrowed: the same
 * sprite the orb uses, put at the robot's own position, stretched sideways,
 * with a block picked out of the mixer and a colour that flashes with `$E0`.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtFire(m, x, a) {
  rbtVoice(m, 3);                                         // `$9265`
  rbtStore(m, RBT_SOUND3, rbtByte(rbtLoad(m, RBT_SOUND3) + 1));
  var e0 = rbtLoad(m, RBT_FRAME);
  if (e0 & 0x1F) {
    if ((e0 & 0x03) !== rbtLoad(m, RBT_INDEX)) { return; }
  } else {
    var y = rbtByte(rbtLoad(m, RBT_OP + x) - 1);
    rbtStore(m, RBT_OP + x, y);
    if (y < 0x94) { rbtStore(m, RBT_OP + x, 0xFF); return; }
    if ((e0 & 0x03) !== rbtLoad(m, RBT_INDEX)) { return; }
  }
  rbtStore(m, RBT_SOUND_ANY, rbtByte(rbtLoad(m, RBT_SOUND_ANY) + 1));
  var index = rbtLoad(m, RBT_INDEX), index2 = rbtLoad(m, RBT_INDEX2);
  var pointer = rbtLoad(m, RBT_POINTERS + index);
  var reach;
  if (pointer === 0xC0) { reach = 0x09; }
  else if (pointer === 0xC6) { reach = 0xEA; }
  else { rbtStore(m, RBT_OP + x, 0xFF); return; }         // `$8F6D` → `$8F4F`
  rbtStore(m, RBT_WORK, reach);
  // ★ `$8F83 PHP` schová **bit 0 robotova x**, který vypadl z `ROR`, a
  // `$8F88 ROL` ho vrátí zpátky dolů; devátý bit blesku je naopak přenos
  // **z toho `ROL`**, tedy bit 7 součtu. Kdo si ty dva bity poplete, má
  // blesk o půl obrazovky vedle.
  var rx = rbtLoad(m, 0xD008 + index2);
  var msb = rbtMsb(m, index);
  var half = rbtByte((msb << 7) | (rx >> 1));
  var sum = rbtByte(half + reach);
  var carry = (sum & 0x80) ? 1 : 0;
  var value = rbtByte((sum << 1) | (rx & 1));
  rbtStore(m, 0xD000, value);
  if (carry) { rbtStore(m, 0xD010, rbtLoad(m, 0xD010) | 0x01); }
  else { rbtStore(m, 0xD010, rbtLoad(m, 0xD010) & 0xFE); }
  rbtStore(m, 0xD001, rbtLoad(m, 0xD009 + index2));
  rbtStore(m, 0x43F8, rbtByte((fgRandom(m.mem, rbtLoad(m, 0xD012)) & 0x03) + 0x14));
  rbtStore(m, 0xD027, (e0 & 0x04) ? 0x01 : 0x06);
  rbtStore(m, 0xD01D, rbtLoad(m, 0xD01D) | 0x01);
  rbtStore(m, 0xD015, rbtLoad(m, 0xD015) | 0x01);
  rbtStore(m, 0xD01C, rbtLoad(m, 0xD01C) & 0xFE);
} // rbtFire

/**
 * `$90AC` — the robot walks. The instruction's low bits say how far and
 * which way, `$5A,X` counts the pixels within a character and `$58,X` walks
 * the screen address under the robot, so it knows when the platform runs out.
 *
 * ★ And it is the only instruction that looks at the **picture**: the two
 * characters it would step on to have to be floor (`$45` or `$46`), or the
 * robot stops and its program is abandoned (`$91FB`).
 *
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtMove(m, x, a) {
  var shifted = rbtByte(a << 1);
  if (!(shifted & 0x80)) { return rbtWalk(m, x, a); }     // `$90F1`
  // `$90AF` — pohyb nahoru a dolů po plošinách: tón a posun ukazatele
  // ★ `$90B0 PHP` si schová znaménko z **druhého** posunu a `$90C7 BPL`
  // se ho ptá až po zvuku: kladné jde na `$90DD`, tedy ukazatel **nahoru**
  var down = (rbtByte(shifted << 1) & 0x80) !== 0;
  rbtVoice(m, 2);                                         // `$9220`, a v něm `INC $4A`
  if (rbtLoad(m, RBT_TICK) & 0x03) { return; }
  rbtTick(m, x);                                          // `$90BE`
  var index = rbtLoad(m, RBT_INDEX);
  var pointer = rbtLoad(m, RBT_POINTERS + index);
  if (down) {
    if (pointer === 0xC0) { rbtStore(m, RBT_OP + x, 0xFF); return; }
    rbtStore(m, RBT_POINTERS + index, rbtByte(pointer - 1));
  } else {
    if (pointer === 0xC6) { rbtStore(m, RBT_OP + x, 0xFF); return; }
    rbtStore(m, RBT_POINTERS + index, rbtByte(pointer + 1));
  }
} // rbtMove

/**
 * `$90F1` — the walk itself, one instruction's worth.
 * @param {Object} m - The machine.
 * @param {number} x - The robot's offset.
 * @param {number} a - The instruction.
 */
function rbtWalk(m, x, a) {
  rbtTick(m, x);                                          // `$9289`
  rbtStore(m, 0x45, rbtLoad(m, RBT_ADDR + x));
  rbtStore(m, 0x46, rbtLoad(m, RBT_ADDR + 1 + x));
  // ★ `$90FC` — rychlost jsou dva spodní bity příznaků, ale **nula znamená
  // nula**, ne jedna: takový robot se nehýbe vůbec. Jednička je „každý druhý
  // snímek o jedna" (`$9107` se ptá bitu 0 `$E0`), dvojka a trojka o jedna
  // a o dva.
  var speed = rbtLoad(m, RBT_FLAGS + x) & 0x03;
  if (speed) {
    speed -= 1;
    if (!speed) {
      if (rbtLoad(m, RBT_FRAME) & 0x01) { return; }       // `$910C`
      speed = 1;
    }
  }
  rbtStore(m, RBT_WORK, speed);
  // `$9113` — `ASL`/`LSR` na `$56,X`: sedmý bit se shodí
  var flags = rbtLoad(m, RBT_FLAGS + x);
  rbtStore(m, RBT_FLAGS + x, rbtByte(rbtByte(flags << 1) >> 1));
  var left = (rbtByte(a << 2) & 0x80) !== 0;              // `$9117`
  var at = rbtLoad(m, 0x45) | (rbtLoad(m, 0x46) << 8);
  var floor = left ? rbtLoad(m, (at - 1) & 0xFFFF) : rbtLoad(m, (at + 1) & 0xFFFF);
  if (floor !== 0x45 && floor !== 0x46) {
    rbtStore(m, RBT_FLAGS + x, rbtLoad(m, RBT_FLAGS + x) | 0x80);
    rbtStore(m, RBT_OP + x, 0xFF);
    return;                                               // `$91FB`
  }
  var index2 = rbtLoad(m, RBT_INDEX2), step = rbtLoad(m, RBT_WORK);
  var sub = rbtLoad(m, RBT_SUB + x);
  if (left) {
    sub -= step;
    if (sub < 0) {
      var lo = rbtLoad(m, RBT_ADDR + x);
      if (!lo) { rbtStore(m, RBT_ADDR + 1 + x, rbtByte(rbtLoad(m, RBT_ADDR + 1 + x) - 1)); }
      rbtStore(m, RBT_ADDR + x, rbtByte(lo - 1));
      sub = rbtByte(sub + 8);
    }
    rbtStore(m, RBT_SUB + x, rbtByte(sub));
    var mine = rbtLoad(m, 0xD008 + index2) - step;
    rbtStore(m, 0xD008 + index2, rbtByte(mine));
    if (mine < 0) { rbtFlipMsb(m); }
  } else {
    sub += step;
    if (sub >= 8) {
      sub -= 8;
      var lo2 = rbtByte(rbtLoad(m, RBT_ADDR + x) + 1);
      rbtStore(m, RBT_ADDR + x, lo2);
      if (!lo2) { rbtStore(m, RBT_ADDR + 1 + x, rbtByte(rbtLoad(m, RBT_ADDR + 1 + x) + 1)); }
    }
    rbtStore(m, RBT_SUB + x, rbtByte(sub));
    var mine2 = rbtLoad(m, 0xD008 + index2) + step;
    rbtStore(m, 0xD008 + index2, rbtByte(mine2));
    if (mine2 > 0xFF) { rbtFlipMsb(m); }
  }
} // rbtWalk

/**
 * `$91B6` — the robot's x has wrapped, so its ninth bit flips.
 * @param {Object} m - The machine.
 */
function rbtFlipMsb(m) {
  var y = rbtLoad(m, RBT_INDEX2) >> 1;
  rbtStore(m, 0xD010, rbtLoad(m, 0xD010) ^ rbtLoad(m, RBT_MSB_MASKS + y));
} // rbtFlipMsb

// published the way every classic worker script is (`svision/tools/classicScript.cjs`)
var robots = {
  frame: rbtFrame, run: rbtRun, colours: rbtColours, tick: rbtTick,
  PROGRAMS: RBT_PROGRAMS, STRIDE: RBT_STRIDE, SNOOZE: RBT_SNOOZE
};
if (typeof self !== 'undefined') {
  self.robots = robots;
  self.rbtFrame = rbtFrame;
}
if (typeof module !== 'undefined' && module.exports) { module.exports = robots; }
