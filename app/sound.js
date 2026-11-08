// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The SID, as the game writes it (`sources/docs/disasm_notes.md` §32).
 *
 * ★ **The sound of this game is not a tune, it is a register.** Nothing in
 * Impossible Mission plays music: every noise is a handful of writes to
 * `$D400`-`$D418` made where the thing that makes the noise happens — the
 * lift's tone climbs in the lift's own step, the robot's hum is set in the
 * robot's frame, the agent's footstep in his. So this file holds the
 * routines, and the places that make the noise call them, exactly where
 * the original calls them. What comes out is **a list of writes with their
 * order**, which the worker hands to the library's {@link SID} through a
 * {@link ChipStream} (R-040's shape, one machine over).
 *
 * | routine | what makes it | voices |
 * |---|---|---|
 * | `$85B3` | a step of the lift in the shaft | 1 sawtooth, 2 noise, both from the frame counter |
 * | `$3A1B` | the shaft loop, once a pass | lets the tone fall again |
 * | `$8E77` | the agent's step | 3 noise — the footstep, and the pitch is **which way he faces** |
 * | `$9220` | a robot that is moving | 2 triangle, from the frame counter |
 * | `$9244` | a robot that is firing | 1 pulse, from `$E3` |
 * | `$9265` | a robot in its other state | 3 pulse, the width from the frame counter |
 * | `$8318` | the interrupt handler | `$A4` counts down and silences voices 2 and 3 |
 * | `$979A` | the flash of the dying agent | 2 pulse and 3 noise, the volume **out of the shuffle** |
 * | `$95EC`, `$965B` | the death ceremony | all three voices into test, and out again |
 * | `$A24C` | the curtain of a room change | all three to **zero** — no waveform at all, not the test bit |
 * | `$9D14` | the security terminal | all three into test — the terminal is silent |
 * | `$BF57` | before a sentence | all three into test, so only `$D418` moves |
 * | `$7D4C` | the telephone and the end of the game | the one place with a tune (M5) |
 *
 * ★ **The volume register is shared with the speech** (`app/speech.js`):
 * the effects set it to 5, 2 or whatever they need, and while a sentence
 * plays it is the sample stream. That is why both live on one bus and why
 * `$BF57` puts the voices into test first — on the original the speech
 * does not mix with anything, it replaces it.
 *
 * The writes are collected on the machine, not sent: `m.sid` grows a
 * `[where, register, value]` for each one and the worker empties it once a
 * frame. `where` is the unit {@link ChipStream} spaces writes by — a cycle
 * of the 6510 — and it is **a model of the cadence, not a measurement**:
 * what the original's interrupt handler writes goes at the frame's start,
 * what its main loop writes is spread over the pass. The order is the
 * original's, and that is what `tools/matchsound.mjs` compares.
 */

/** the SID as the game addresses it */
var SND_BASE = 0xD400, SND_TOP = 0xD418;

/** the registers this game names */
var SND_FRELO1 = 0x00, SND_FREHI1 = 0x01, SND_PWLO1 = 0x02, SND_PWHI1 = 0x03,
    SND_VCREG1 = 0x04, SND_ATDCY1 = 0x05, SND_SUREL1 = 0x06,
    SND_FRELO2 = 0x07, SND_FREHI2 = 0x08, SND_PWLO2 = 0x09, SND_PWHI2 = 0x0A,
    SND_VCREG2 = 0x0B, SND_ATDCY2 = 0x0C, SND_SUREL2 = 0x0D,
    SND_FRELO3 = 0x0E, SND_FREHI3 = 0x0F, SND_PWLO3 = 0x10, SND_PWHI3 = 0x11,
    SND_VCREG3 = 0x12, SND_ATDCY3 = 0x13, SND_SUREL3 = 0x14,
    SND_CUTLO = 0x15, SND_CUTHI = 0x16, SND_RESFILT = 0x17, SND_SIGVOL = 0x18;

/** the zero page the sound reads: the frame counter, the lift's two bytes, the timer */
var SND_FRAME = 0xE1, SND_FRAME2 = 0xE0, SND_FRAME3 = 0xE3,
    SND_TONE1 = 0x25, SND_TONE2 = 0x26, SND_TIMER = 0xA4,
    SND_PLACE = 0x1A, SND_STATE = 0x3F, SND_FACING = 0x50, SND_ANY = 0x4E;

/**
 * ★ **The cadence model, and the order that comes out of it.** The game's
 * interrupt is armed to raster `$FF` (`$835C`, `$836F`), so the handler —
 * and with it the robots' voices and `$8318` — runs **late in the frame**,
 * at about line 255 of the 312, while the main loop's pass runs from the
 * end of one handler to the start of the next. In a frame as the recording
 * counts it (two hits of `$8361`, which is inside that handler) the loop's
 * writes therefore come **first** and the handler's **last**.
 *
 * ★ The model runs them the other way round — `plFrame` does the handler
 * and then the pass — so the line is what puts them back in the machine's
 * order: {@link sndTake} hands them over sorted by it, and
 * {@link ChipStream} would sort them anyway. Measured: without it
 * `matchsound --effects` transposes the agent's step with the robots'
 * voices in every frame, which only shows where the step writes more than
 * one register (`$8E96 VCREG3 = $80`, the footstep going quiet).
 */
var SND_IRQ_LINE = 255*63, SND_LOOP_LINE = 2000, SND_STEP = 63;

function sndByte(v) { return v & 0xFF; }

/**
 * One write of one register, as the machine would see it.
 *
 * ★ Everything goes through here, including the writes the transcribed
 * routines make by storing into `$D4xx` — `rbStore` sends those here too,
 * so a routine that was written before M6 needs no change to be heard.
 *
 * @param {Object} m - The machine.
 * @param {number} register - 0-24.
 * @param {number} value - A byte.
 */
function sndPoke(m, register, value) {
  // ★ Dvě podmínky, ne jedna: `sndTake` nechává po sobě **prázdné pole**,
  // a to je pravdivé — takže snímek, ve kterém nikdo do SID nesáhl, by
  // jednou podmínkou nechal `sidRegs` nezaložené. Vyleze to až tehdy, když
  // se první zápis stane **po** prvním `sndTake`, tedy od chvíle, kdy za
  // úvodní řečí neběží hlavní smyčka (§22).
  if (!m.sid) { m.sid = []; }
  if (!m.sidRegs) { m.sidRegs = new Uint8Array(25); }
  register &= 0x1F;
  if (register > SND_SIGVOL) {
    return;
  }
  value = sndByte(value);
  m.sidRegs[register] = value;
  m.sid.push([m.sidLine || SND_LOOP_LINE, register, value]);
} // sndPoke

/** a write named by its address, the way the disassembly reads */
function sndStore(m, addr, value) { sndPoke(m, addr-SND_BASE, value); }

/**
 * Where in the frame the writes that follow belong: the interrupt handler
 * at its start, the main loop spread over the pass.
 * @param {Object} m - The machine.
 * @param {number} line - In cycles from the frame's start.
 */
function sndAt(m, line) { m.sidLine = line; }

/**
 * ★ **Zahodí zápisy, které obsluha přerušení toho snímku udělala** —
 * protože na stroji se nestaly.
 *
 * `$95E8 SEI` je v **hlavní smyčce**, a ta běží **před** obsluhou (ta je na
 * rastru `$FF`, tedy na konci snímku, §32). Začne-li tedy obřad umírání
 * v průchodu smyčkou, obsluha toho snímku už se **nespustí**. Model ale
 * počítá obsluhu první, takže její zápisy — hlasy robotů (`$9220`,
 * `$9244`) a doznívání (`$8318`) — v té chvíli ve frontě **už leží**, a
 * protože mají vyšší linku než `$95EC`, seřadí se **za** jeho ztišení:
 * ztišené hlasy se hned zase rozezvučí a přes celý obřad drží **zaseknutý
 * tón** (nahlásil operátor 2026-09-21).
 *
 * @param {Object} m - Stroj.
 * @param {number} line - Od které linky výš se zápisy zahazují.
 */
function sndDropFrom(m, line) {
  if (!m.sid) { return; }
  var kept = [], i;
  for (i = 0; i < m.sid.length; i++) {
    if (m.sid[i][0] < line) { kept.push(m.sid[i]); }
  }
  m.sid = kept;
} // sndDropFrom

/**
 * Empties the frame's writes.
 * @param {Object} m - The machine.
 * @returns {Array} `[[line, register, value], …]`, or an empty list.
 */
function sndTake(m) {
  var out = m.sid || [];
  m.sid = [];
  // ★ **Pořadí stroje, ne pořadí přepisu**: hlavní smyčka píše dřív než
  // obsluha přerušení, protože ta je na rastru `$FF`, tedy na konci snímku.
  // Řazení je **stabilní** — v rámci jedné linky zůstane pořadí zápisů tak,
  // jak je rutina udělala.
  return out.map(function (w, i) { return [w, i]; })
    .sort(function (a, b) { return (a[0][0]-b[0][0]) || (a[1]-b[1]); })
    .map(function (p) { return p[0]; });
} // sndTake

/* ------------------------------------------------------------- the lift */

/**
 * `$85B3` — a step of the lift. The two bytes of zero page climb
 * (`elTone` in `app/elevator.js` keeps them, because the shaft loop lets
 * them fall again), and the tone itself is **the frame counter**: voice 1
 * a sawtooth and voice 2 a noise, both at a pitch that walks on its own
 * from one step to the next, with the two counters folded in by `EOR`.
 * @param {Object} m - The machine.
 */
function sndLift(m) {
  var frame = m.mem[SND_FRAME];
  var high = frame >> 2;
  sndPoke(m, SND_FREHI1, high ^ m.mem[SND_TONE1]);
  sndPoke(m, SND_FREHI2, high ^ m.mem[SND_TONE2]);
  // `$85D7`: `LSR` then two `ROR`s — the bit that fell off comes back at the top
  var low = frame >> 1;
  var carry = frame & 1;
  low = ((carry << 7) | (low >> 1)) & 0xFF;
  carry = (frame >> 1) & 1;
  low = ((carry << 7) | (low >> 1)) & 0xFF;
  sndPoke(m, SND_FRELO1, low);
  sndPoke(m, SND_FRELO2, low);
  sndPoke(m, SND_ATDCY1, 0x00);
  sndPoke(m, SND_ATDCY2, 0x00);
  sndPoke(m, SND_SUREL1, 0x8F);
  sndPoke(m, SND_SUREL2, 0x8F);
  sndPoke(m, SND_VCREG1, 0x21);                    // sawtooth, gate on
  sndPoke(m, SND_VCREG2, 0x81);                    // noise, gate on
} // sndLift

/* ------------------------------------------------------ the agent's step */

/**
 * `$8E77` — the agent's footstep, and it is voice 3 on noise.
 *
 * ★ **The pitch says which way he is facing** (`$8EAC`): to the left the
 * divider is `$861E`, to the right `$C8F3` — two different scuffs. And
 * three of his states (`$0E`, `$0A`, `$03`) only **close the gate**
 * (`$80`) instead of opening it, which is how a jump goes quiet in the
 * air; four more (`$00`, `$07`, `$10` and the fall) keep stepping.
 *
 * ★ **`$4E` se bere tak, jak vypadalo před obsluhou přerušení.** Nuluje ho
 * `$8ECC` a sázejí ho hlasy robotů, jenže na stroji běží průchod smyčkou
 * **před** obsluhou (`SND_IRQ_LINE`), takže krok agenta vidí to, co nechal
 * **minulý** snímek. Model dělá obsluhu první, proto mu to podá `plSound`.
 *
 * @param {Object} m - The machine.
 * @param {number} [any] - `$4E`, jak ho viděl průchod; jinak to, co je teď.
 */
function sndStep(m, any) {
  if (any === undefined) { any = m.mem[SND_ANY]; }
  if (m.mem[SND_PLACE] && any) {                   // `$8E77`: a robot has the voice
    return;
  }
  sndPoke(m, SND_SIGVOL, 0x05);
  var state = m.mem[SND_STATE];
  if (state !== 0x00 && state !== 0x07 && state !== 0x10) {
    if (state === 0x0E || state === 0x0A || state === 0x03) {
      sndPoke(m, SND_VCREG3, 0x80);                // noise, the gate let go
    }
    return;
  }
  var left = (m.mem[SND_FACING] & 0x80) !== 0;
  sndPoke(m, SND_FREHI3, left ? 0x86 : 0xC8);
  sndPoke(m, SND_FRELO3, left ? 0x1E : 0xF3);
  sndPoke(m, SND_ATDCY3, 0x05);
  sndPoke(m, SND_SUREL3, 0x39);
  sndPoke(m, SND_VCREG3, 0x81);                    // noise, gate on
} // sndStep

/* ---------------------------------------------------------- the robots */

/**
 * `$9220` — a robot that is moving: voice 2, a triangle whose pitch is the
 * frame counter doubled and flipped about `$20`, so it wanders.
 * @param {Object} m - The machine.
 */
function sndRobotMove(m) {
  sndPoke(m, SND_FREHI2, sndByte(m.mem[SND_FRAME] << 1) ^ 0x20);
  sndPoke(m, SND_FRELO2, 0x00);
  sndPoke(m, SND_ATDCY2, 0x00);
  sndPoke(m, SND_PWLO2, 0x00);
  sndPoke(m, SND_SUREL2, 0x40);
  sndPoke(m, SND_PWHI2, 0x0E);
  sndPoke(m, SND_VCREG2, 0x11);                    // triangle, gate on
} // sndRobotMove

/**
 * `$9244` — a robot firing: voice 1, a pulse from the third frame counter.
 * @param {Object} m - The machine.
 */
function sndRobotFire(m) {
  sndPoke(m, SND_FREHI1, m.mem[SND_FRAME3] >> 1);
  sndPoke(m, SND_FRELO1, 0x00);
  sndPoke(m, SND_ATDCY1, 0x00);
  sndPoke(m, SND_PWLO1, 0x00);
  sndPoke(m, SND_PWHI1, 0x08);
  sndPoke(m, SND_SUREL1, 0x40);
  sndPoke(m, SND_VCREG1, 0x41);                    // pulse, gate on
} // sndRobotFire

/**
 * `$9265` — the robot's third voice: a pulse at a fixed low pitch whose
 * **width** is the frame counter, which is what gives it the warble.
 * @param {Object} m - The machine.
 */
function sndRobotThird(m) {
  sndPoke(m, SND_ATDCY3, 0x00);
  sndPoke(m, SND_PWLO3, 0x00);
  sndPoke(m, SND_PWHI3, m.mem[SND_FRAME2] >> 4);
  sndPoke(m, SND_SUREL3, 0xC0);
  sndPoke(m, SND_FREHI3, 0x04);
  sndPoke(m, SND_FRELO3, 0x04);
  sndPoke(m, SND_VCREG3, 0x41);                    // pulse, gate on
} // sndRobotThird

/* --------------------------------------------------------- the handler */

/**
 * `$8318` — in the interrupt handler: `$A4` is how many frames the sound
 * has left, and when it runs out voices 2 and 3 go into **test**, which on
 * a SID is silence at once rather than a release.
 * @param {Object} m - The machine.
 */
function sndTick(m) {
  var timer = m.mem[SND_TIMER];
  if (!timer) {
    return;
  }
  timer = sndByte(timer-1);
  m.mem[SND_TIMER] = timer;
  if (timer) {
    return;
  }
  sndPoke(m, SND_VCREG2, 0x08);
  sndPoke(m, SND_VCREG3, 0x08);
} // sndTick

/**
 * `$84EA` — ★ **the churn that gives the robots their pitch**, and the last
 * thing the interrupt handler does (`$8368`, right after `INC $E0`).
 *
 * `$E1` and `$E3` are not counters, they are **two little shift registers**:
 * each is shifted right and a bit fed back in, so they wander. `$9220` makes
 * the moving robot's pitch out of `$E1` and `$9244` the firing robot's out
 * of `$E3` — which is why the robots warble instead of humming one note.
 *
 * ★ **Leave it out and the robots go quiet**, not just monotonous: `$38FA`
 * starts both at 1, `$9244` writes `FREHI1 = $E3 >> 1` = **0** and `FRELO1`
 * is 0 too, so voice 1 has **frequency zero and makes no sound at all**.
 * Voice 2 keeps a single pitch. What is left of a robot is the one beep of
 * `$9265` when it changes state — which is exactly what the operator heard
 * (2026-09-20). No `match*` reached it: they compare the machine's memory,
 * and the recordings start from a dump where both registers are long since
 * churned.
 *
 * ★ `$E3` only churns when `$D024 & $0F` is `$0A`. It looks like a colour
 * register but here it is a flag the loader parks (§4): measured `$FA` in
 * every recording, so in a game it always churns. The other branch
 * (`$8501 JMP $799A`) is not transcribed — nothing in a game takes it.
 *
 * @param {Object} m - The machine.
 */
function sndChurn(m) {
  var e1 = m.mem[SND_FRAME], carry = e1 & 1, a;
  e1 >>= 1;                                        // `$84EA LSR $E1`
  a = sndByte(e1 + carry);                         // `$84EC`, `$84EE ADC #$00`
  a = sndByte(a << 2) & 0x07;                      // `$84F0` dvakrát `ASL`, `$84F2 AND #$07`
  m.mem[SND_FRAME] = a | e1;                       // `$84F4 ORA $E1`, `$84F6`
  // ★ `$8501 JMP $799A` — **skok doprostřed instrukce**, tedy jistá smrt
  // stroje. Nikdy se neudělá, protože `$D024` je `$FA` (§4), a je to zjevně
  // záměr: kdyby si někdo s příznakem zavaděče pohrál, hra se zasekne.
  if ((m.vic[0x24] & 0x0F) !== 0x0A) { return 0; }   // `$84F8`-`$84FF`
  var e3 = m.mem[SND_FRAME3];
  a = (e3 >> 2) ^ e3;                              // `$8504`-`$8508`
  carry = a & 1;
  a = (carry << 7) >> 2;                           // `$850A LSR`, `$850B/$850D ROR`, `$850E`-`$850F`
  m.mem[SND_FRAME3] = (a | e3) >> 1;               // `$8510 ORA $E3`, `$8512 LSR`, `$8513`
  // ★ A **vrací to, co uložilo** — řídicí místnost si `$84EA` půjčuje jako
  // zdroj náhody pro blikání svého panelu (`$ABCA`, §35)
  return m.mem[SND_FRAME3];
} // sndChurn

/* ----------------------------------------------------------- the death */

/**
 * `$979A` — one flash of the dying agent, and the noise under it.
 *
 * ★ **Its volume comes out of the shuffle** (`$97C4 JSR $82D6`), which is
 * why `$975B` may not be left out of the ceremony even though it looks
 * like nothing but colours: the mixer is asked, and the next thing to ask
 * gets a different answer (§31).
 *
 * @param {Object} m - The machine.
 * @param {function(): number} shuffle - The original's mixer.
 */
function sndDeathFlash(m, shuffle) {
  sndPoke(m, SND_FRELO2, 0x00);
  sndPoke(m, SND_FRELO3, 0x00);
  sndPoke(m, SND_ATDCY2, 0x00);
  sndPoke(m, SND_ATDCY3, 0x00);
  sndPoke(m, SND_PWLO2, 0x00);
  sndPoke(m, SND_SUREL2, 0xF0);
  sndPoke(m, SND_PWHI2, 0x0F);
  sndPoke(m, SND_SUREL3, 0x70);
  sndPoke(m, SND_FREHI2, 0x04);
  sndPoke(m, SND_FREHI3, 0xE0);
  sndPoke(m, SND_SIGVOL, shuffle() & 0x07);
  sndPoke(m, SND_VCREG2, 0x41);                    // pulse, gate on
  sndPoke(m, SND_VCREG3, 0x81);                    // noise, gate on
} // sndDeathFlash

/**
 * All three voices into test, which is how most of this game goes quiet:
 * `$95EC` at the start of the ceremony, `$9D14` on the way into the
 * terminal and `$BF57` before a sentence. ★ The curtain (`$A24C`) is the
 * odd one out — it writes a plain zero, so the voices keep their release
 * instead of stopping dead.
 * @param {Object} m - The machine.
 */
function sndSilence(m) {
  sndPoke(m, SND_VCREG1, 0x08);
  sndPoke(m, SND_VCREG2, 0x08);
  sndPoke(m, SND_VCREG3, 0x08);
} // sndSilence

/**
 * `$965B` — the end of the dissolve: only the two voices the flash used.
 * @param {Object} m - The machine.
 */
function sndSilenceTwo(m) {
  sndPoke(m, SND_VCREG2, 0x08);
  sndPoke(m, SND_VCREG3, 0x08);
} // sndSilenceTwo

/**
 * `$9D17` — the terminal, where the order is 1, 3, 2 rather than 1, 2, 3.
 * It makes no sound of its own: the interrupt handler is off in there, so
 * nothing would tick anyway (§29).
 * @param {Object} m - The machine.
 */
function sndTerminal(m) {
  sndPoke(m, SND_VCREG1, 0x08);
  sndPoke(m, SND_VCREG3, 0x08);
  sndPoke(m, SND_VCREG2, 0x08);
} // sndTerminal

/**
 * `$A929` — the code room's tones are set up once and then played by
 * moving the pitch (`$A950` and on). M5 builds the room; what M6 puts
 * back is the setting-up.
 * @param {Object} m - The machine.
 */
function sndCodeRoom(m) {
  sndPoke(m, SND_ATDCY1, 0x5A);
  sndPoke(m, SND_ATDCY2, 0x5A);
  sndPoke(m, SND_ATDCY3, 0x58);
  sndPoke(m, SND_SUREL1, 0x00);
  sndPoke(m, SND_SUREL2, 0x00);
  sndPoke(m, SND_SUREL3, 0x00);
  sndPoke(m, SND_PWLO1, 0x00);
  sndPoke(m, SND_PWLO2, 0x00);
  sndPoke(m, SND_PWLO3, 0x00);
  sndPoke(m, SND_SIGVOL, 0x05);
} // sndCodeRoom

/**
 * `$7D4C` — the one tune in the game, set up before the telephone rings
 * and before the end: voices 2 and 3 as pulses through the filter, and
 * `$A4` set to two so the handler shuts them again.
 * @param {Object} m - The machine.
 */
function sndTuneSetup(m) {
  sndPoke(m, SND_ATDCY2, 0x00);
  sndPoke(m, SND_ATDCY3, 0x00);
  sndPoke(m, SND_SUREL2, 0xF0);
  sndPoke(m, SND_SUREL3, 0xF0);
  sndPoke(m, SND_FRELO2, 0x6D);
  sndPoke(m, SND_FREHI2, 0x16);
  sndPoke(m, SND_FRELO3, 0x31);
  sndPoke(m, SND_FREHI3, 0x1C);
  sndPoke(m, SND_CUTHI, 0x40);
  sndPoke(m, SND_CUTLO, 0x00);
  sndPoke(m, SND_SIGVOL, 0x12);                    // ★ volume 2 with the low pass on
  sndPoke(m, SND_VCREG2, 0x11);
  sndPoke(m, SND_VCREG3, 0x11);
  m.mem[SND_TIMER] = 0x02;
} // sndTuneSetup

// v workeru se soubory potkávají na globálu, tak jak je `importScripts` nahraje
if (typeof self !== 'undefined') {
  self.sndPoke = sndPoke;
  self.sndStore = sndStore;
  self.sndAt = sndAt;
  self.sndTake = sndTake;
  self.sndLift = sndLift;
  self.sndStep = sndStep;
  self.sndTick = sndTick;
  self.sndChurn = sndChurn;
  self.sndRobotMove = sndRobotMove;
  self.sndRobotFire = sndRobotFire;
  self.sndRobotThird = sndRobotThird;
  self.sndDeathFlash = sndDeathFlash;
  self.sndSilence = sndSilence;
  self.sndSilenceTwo = sndSilenceTwo;
  self.sndTerminal = sndTerminal;
  self.sndCodeRoom = sndCodeRoom;
  self.sndTuneSetup = sndTuneSetup;
  self.sndDropFrom = sndDropFrom;
  self.SND_IRQ_LINE = SND_IRQ_LINE;
  self.SND_LOOP_LINE = SND_LOOP_LINE;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {sndPoke: sndPoke, sndStore: sndStore, sndAt: sndAt, sndTake: sndTake,
                    sndLift: sndLift, sndStep: sndStep, sndTick: sndTick, sndChurn: sndChurn,
                    sndRobotMove: sndRobotMove, sndRobotFire: sndRobotFire,
                    sndRobotThird: sndRobotThird, sndDeathFlash: sndDeathFlash,
                    sndSilence: sndSilence, sndSilenceTwo: sndSilenceTwo,
                    sndTerminal: sndTerminal, sndCodeRoom: sndCodeRoom,
                    sndTuneSetup: sndTuneSetup,
                    SND_IRQ_LINE: SND_IRQ_LINE, SND_LOOP_LINE: SND_LOOP_LINE};
}
