// classic worker script (importScripts): no import, no export — R-001
// begin code

/**
 * The speech (`$0880`, `sources/docs/disasm_notes.md` §18 and §32).
 *
 * ★ **The speech is not a recording and it does not run in frames.** It is
 * a little sample player of its own, driven by the **NMI of CIA 2's timer
 * B** every **101 cycles** — 9 754.9 Hz on PAL, 194.6 samples a frame — and
 * every sample leaves the machine as `LSR` + `STA $D418`, that is as **four
 * bits of the SID's volume register**. That is why the game needs a 6581
 * (`ZADANI.md` §9) and why this file makes samples, not sound: the sound is
 * the library's ({@link SID}).
 *
 * ★ **The game stands still while it talks.** `$BF51` waits for the raster,
 * puts all three voices into test (silent), hands the IRQ to `$838C` and
 * calls `$0880`; for six of the eight sentences it then spins on `LDA #$FF`
 * + `JSR $0880` until the player says it has stopped. So a sentence is not
 * something the world runs alongside — it is a block of samples with a
 * length, and the frames of the world resume after it.
 *
 * ## The four phases
 *
 * The NMI vector `$FFFA` **is the player's state** — the routine rewrites
 * it between phases:
 *
 * | phase | at | what it does |
 * |---|---|---|
 * | A | `$0883` | plays the window **forwards**, `$AD` samples, the `LDA` operand walking up |
 * | B | `$08A4` | plays it **backwards**, `$AE` samples, the operand walking down |
 * | C | `$08C3` | writes `$07` once — silence at mid level |
 * | D | `$08D9` | ★ **writes nothing at all**, `$AF`-1 times: the level simply holds |
 * | end | `$08E1` | stops the timer and leaves `$07` behind |
 *
 * ★ **So a frame of speech is a wave: the window forwards, the window
 * backwards, then a pad of silence** — and the pad is where the pitch is.
 * `$AF` comes from `$0CF4`, and `$0CF4` is the contour (`$0B1D`), so the
 * period of the wave is `2·length + pad` samples. The stream of pairs at
 * the sentence's first pointer, which §18 called an envelope, is therefore
 * **a pitch track**, not a volume one — the amplitude is in the samples.
 *
 * ## The four unpackers
 *
 * Byte 1 of a script record picks one, and with it whether the frame is
 * played straight out of the buffer it was unpacked into or through the
 * interpolator:
 *
 * | mode | at | bits a sample | played |
 * |---|---|---|---|
 * | 0 | `$0BE3` | two, table forced to the first | straight, window shrinks |
 * | 1 | `$0B73` | **one** (`$0E` or `$10`) | straight, window shrinks |
 * | 2 | `$0AE5` | four (a nibble doubled) | ★ interpolated with the frame before |
 * | 3 | `$0A68` | two, table from bits 0-1 of the first byte | interpolated |
 *
 * ★ **Modes 0 and 1 shrink their window** (`$0951`): every repeat the start
 * walks up by an eighth of the frame and the length comes down by the same,
 * so the wave gets shorter and shorter — and higher and higher — until the
 * length reaches `$10`, when it starts over. Modes 2 and 3 keep a fixed
 * length of 8, 16, 24 or 32 and **average the new frame into the one
 * before** (`$0BFD`, `(a + b + 1)/2`) on every repeat, which is what makes
 * a vowel glide instead of clicking.
 *
 * ★ **And a record with bit 2 of byte 1 set is a pause**: bytes 2 and 3 are
 * not a pointer, the handler becomes `$0981`, and the player sits in phases
 * C and D for `$80` samples without touching a buffer.
 *
 * ## ★ And it runs on cycles, not on states
 *
 * The player is **re-entrant**, and that is not a detail: a refill that
 * unpacks a frame takes hundreds of cycles, the timer keeps underflowing
 * every 101, and **the 6502 does not mask NMI inside an NMI**. So the
 * player interrupts itself — a sample is played out of a buffer the
 * unpacker is still filling, and a sample that lands in the eleven cycles
 * of `$08F5`-`$0908`, between the new phase going into `$FFFA` and the new
 * counters going into `$AD`/`$AE`/`$AF`, is played by the new phase with
 * the old counts and is **one sample more than the state machine asked
 * for**. Six of the eight sentences have one to four of those.
 *
 * So this file is not a state machine that is stepped once a sample; it is
 * the driver's **instructions with their cycle counts**, written as
 * generators that yield the cost of each one. {@link speechRun} owns the
 * clock, the CIA's underflows and the NMI line, and takes an interrupt at
 * an instruction boundary exactly where the machine would — including
 * inside a handler. Between interrupts it runs the game's own waiting loop
 * (`$BF7E`), because where its instruction boundaries fall decides the few
 * cycles of jitter a sample starts with.
 *
 * ★ That is also why this could not be measured with a stub: a `JSR` into
 * a logging routine adds 28 cycles to every sample and **moves the very
 * boundaries being measured** (a run with four more `NOP`s gave a
 * different answer). `tools/tracesound.py` therefore records with
 * checkpoints of the monitor, which cost the emulation nothing.
 *
 * The data — the sentence table, the contours, the scripts and the shared
 * frames — is `IM.WORDS`, 6 016 bytes at `$E000` under the switched-out
 * KERNAL, and it rides in `data/speech.json` with the driver's own tables
 * (the amplitudes at `$0AD5`, the contour steps at `$0B63`, the frame
 * lengths at `$0A47` and the state at `$0CF1`). ★ Those tables are **data
 * the program reads**, and no `match*` would ever find them missing,
 * because every measurement starts from a dump of the original's memory —
 * the same trap as the robots' programs (§26) and the search glyphs (§27).
 */


/** the sample rate of the speech: CIA 2 timer B, latch $0064, so 101 cycles */
var SPEECH_CYCLES = 101;

/** the buffer `$0800`, a page of it; the player's windows live in $00-$9F */
var SPEECH_BUFFER = 0x100;

/** `$0CF4` of a pause, and what phase C puts out */
var SPEECH_PAUSE = 0x80, SPEECH_SILENCE = 0x0E;

/** the phases, by the low byte the player writes into `$FFFA` */
var SP_A = 0x83, SP_B = 0xA4, SP_C = 0xC3, SP_D = 0xD9, SP_END = 0xE1;

/** the handlers `$092F` picks between, and the `$0911` targets */
var SP_ONE = 0x8C, SP_TWO = 0x8F, SP_TWOI = 0x92, SP_FOUR = 0x98,
    SP_PAUSE = 0x81, SP_STOP = 0x7B;
var SP_NOTHING = 0x37, SP_SMOOTH = 0x39, SP_SHRINK = 0x51;

/**
 * The game's own waiting loop while a sentence plays (`$BF7E`: `LDA #$FF`,
 * `JSR $0880`, `LSR A`, `BCS`), instruction by instruction — the driver's
 * `$FF` command walks through `$0C2F`, `$0C52` and back. Nothing here
 * changes the player; what it decides is **where the instruction
 * boundaries are** when an interrupt arrives, and that is worth a few
 * cycles of jitter on every sample.
 */
var SPEECH_WAIT = [2, 6, 3, 2, 3, 3, 2, 2, 2, 2, 4, 2, 6, 2, 3];

function spByte(v) { return v & 0xFF; }

/**
 * A player, from `data/speech.json`: the words and the driver's tables.
 *
 * @param {Object} data - The parsed `data/speech.json`.
 * @returns {Object} The state the rest of this file works on.
 */
function speechMachine(data) {
  var driver = data.driver;
  return {
    /** `IM.WORDS`, 6 016 bytes, as they sit at `$E000` */
    words: speechBytes(data.file.data),
    /** `$0AD5`: four tables of four, and the first of them is code (§32) */
    amplitudes: speechBytes(driver.amplitudes.data),
    /** `$0B63`: the contour's increments, with a sign */
    steps: speechBytes(driver.steps.data),
    /** `$0A47`: the frame lengths of modes 2 and 3 */
    pads: speechBytes(driver.pads.data),
    /** `$0CF1`-`$0CFF` as the file leaves them */
    defaults: speechBytes(driver.defaults.data),
    /** the buffer page `$0800` */
    buffer: new Uint8Array(SPEECH_BUFFER),
    /** the clock, in cycles of the 6510 */
    cycle: 0,
    /** when CIA 2's timer B underflows next, and whether it runs at all */
    underflow: 0, timerOn: false,
    /** the CIA's interrupt flag (the NMI line held low) and the edge waiting */
    icr: false, pending: false,
    /** the handlers that are running, innermost last — the nesting itself */
    handlers: [],
    /** where the waiting loop is */
    waitAt: 0,
    /** how many times the player has refilled — a block of samples each */
    refills: 0,
    /**
     * ★ **An interrupt forced into a refill.** The six cycles of jitter
     * this model cannot have are the ones the VIC-II steals from the
     * processor (a bad line is forty of them), and they decide whether a
     * nested interrupt lands in one of the refill's four windows. So
     * `tools/matchsound.mjs` does not guess: where the recording has one
     * sample more than the model, it asks for an interrupt at each window
     * in turn and takes the one that reproduces the recording exactly —
     * and if none does, the difference is unexplained.
     * `{sample: spot}` — see {@link spInject} for the five spots.
     */
    inject: null,
    /**
     * ★ **Cycles the VIC-II took from the processor**, `{sample: cycles}`.
     * A bad line costs about forty of them and a line of sprites a few
     * more, and where they fall decides whether an interrupt nests inside
     * a refill. The model has no video chip, so `tools/matchsound.mjs`
     * looks for the stall that reproduces the recording rather than
     * pretending the difference is not there.
     */
    stall: null,
    /**
     * ★ **The bad lines**, `{phase, period, cost}`: once every eight
     * raster lines (504 cycles on PAL) the VIC-II takes the bus for the
     * row of characters and the processor stands still for about 43
     * cycles. Where in that rhythm a sentence starts is not observable
     * from memory — it is the initial state `tools/matchsound.mjs`
     * derives from the recording, in the sense of `ZADANI.md` §10.7.
     */
    badline: null,
    /** stop after this many samples — a tool looking for a stall needs no more */
    until: 0,
    /** what came out: `{tag, value, cycle}` a sample, tag `D` writing nothing */
    out: [],
    running: false
  };
} // speechMachine

/**
 * base64 to bytes, in a worker or under Node alike.
 * @param {string} text - The base64.
 * @returns {Uint8Array}
 */
function speechBytes(text) {
  var raw = (typeof atob === 'function')
    ? atob(text)
    : Buffer.from(text, 'base64').toString('binary');
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) { out[i] = raw.charCodeAt(i); }
  return out;
} // speechBytes

/**
 * A byte of `IM.WORDS` by its address on the machine (`$E000` and up).
 * @param {Object} s - The player.
 * @param {number} addr - The address.
 * @returns {number} A byte.
 */
function speechWord(s, addr) {
  var i = (addr-0xE000) & 0xFFFF;
  return i < s.words.length ? s.words[i] : 0;
} // speechWord

// ------------------------------------------------------------------ the clock

/**
 * Runs the machine for `cycles` cycles, letting CIA 2's timer B underflow
 * as it goes. An underflow pulls the NMI line low and **that edge** is
 * what the processor sees; while the line is already low — the flag not
 * read yet — further underflows pass unnoticed, which is why a long
 * handler loses samples rather than piling them up.
 * @param {Object} s - The player.
 * @param {number} cycles - How many.
 */
function spCycles(s, cycles) {
  if (s.badline) {
    // ★ the VIC-II halts the processor for a bad line's worth of cycles,
    // once every eight raster lines; the CIA counts on regardless
    var b = s.badline;
    var crossed = Math.floor((s.cycle+cycles-b.phase)/b.period)-Math.floor((s.cycle-b.phase)/b.period);
    if (crossed > 0) {
      cycles += crossed*b.cost;
    }
  }
  var end = s.cycle+cycles;
  while (s.timerOn && s.underflow <= end) {
    if (!s.icr) {
      s.icr = true;
      s.pending = true;
    }
    s.underflow += SPEECH_CYCLES;
  }
  s.cycle = end;
} // spCycles

/** reading `$DD0D` clears the flag and lets the line go up again */
function spAck(s) { s.icr = false; }

/**
 * ★ **An interrupt forced in at a named spot** — see `inject` in
 * {@link speechMachine}. The spots are the places where one instruction
 * more or less decides what a nested handler sees:
 *
 * | spot | where | what a nested handler then does |
 * |---|---|---|
 * | `ack` | right after a phase's `CMP $DD0D` | runs **the phase again**, and counts down with it |
 * | `switch` | after the `DEC` that ended the phase | runs the phase **once more than it was counted for** |
 * | `old` | in the refill, before `STA $FFFA` | the **old** phase once more |
 * | `phase` | after `STA $FFFA` | the **new** phase with the old window |
 * | `ptr` | after `STA $0885` | the new window, but the old counts |
 * | `count` | after `STA $AE` | the counts, but not the pad |
 *
 * @param {Object} s - The player.
 * @param {string} spot - One of the five.
 */
function* spStall(s) {
  var n = s.stall ? s.stall[s.out.length-1] : 0;
  if (n) {
    yield n;                                       // ★ cycles the VIC-II took
  }
} // spStall

function spInject(s, spot) {
  if (s.inject && s.inject[s.out.length-1] === spot) {
    s.pending = true;
  }
} // spInject

/**
 * An instruction boundary: if an edge is waiting the processor takes the
 * interrupt here — **even inside a handler**, which is the whole of §32.
 * @param {Object} s - The player.
 */
function spBoundary(s) {
  if (s.pending) {
    s.pending = false;
    s.handlers.push(spHandler(s));
  }
} // spBoundary

/**
 * One instruction of whatever is running: the innermost handler, or the
 * game's waiting loop when none is.
 * @param {Object} s - The player.
 */
function spInstruction(s) {
  var n = s.handlers.length;
  if (n) {
    var step = s.handlers[n-1].next();
    if (step.done) {
      s.handlers.pop();
    } else {
      spCycles(s, step.value);
    }
  } else {
    spCycles(s, SPEECH_WAIT[s.waitAt]);
    s.waitAt = (s.waitAt+1) % SPEECH_WAIT.length;
  }
  spBoundary(s);
} // spInstruction

/** one sample out: which phase made it, what went to `$D418`, when, and from which refill */
function spOut(s, tag, value) {
  s.out.push({tag: tag, value: value, cycle: s.cycle, refill: s.refills});
} // spOut

// ----------------------------------------------------------------- the phases

/** the interrupt itself (7 cycles) and then the phase `$FFFA` points at */
function* spHandler(s) {
  yield 7;
  switch (s.phase) {
    case SP_A: yield* spPhaseA(s); return;
    case SP_B: yield* spPhaseB(s); return;
    case SP_C: yield* spPhaseC(s); return;
    case SP_D: yield* spPhaseD(s); return;
    default: yield* spPhaseEnd(s); return;
  }
} // spHandler

/** `$0883` — a sample, then the operand walks up; at the end phase B takes over. */
function* spPhaseA(s) {
  yield 3;                                         // PHA
  var v = s.buffer[s.playAt];
  yield 4;                                         // LDA $0865
  v >>= 1;
  yield 2;                                         // LSR A
  spOut(s, 'A', v);
  yield 4;                                         // STA $D418
  spAck(s);
  yield 4;                                         // CMP $DD0D
  yield* spStall(s);
  spInject(s, 'ack');
  s.ad = spByte(s.ad-1);
  yield 5;                                         // DEC $AD
  spInject(s, 'switch');
  if (s.ad !== 0) {
    yield 2;                                       // BEQ, not taken
    yield 6;                                       // INC $0885
    s.playAt = spByte(s.playAt+1);
    yield 4;                                       // PLA
    yield 6;                                       // RTI
    return;
  }
  yield 3;                                         // BEQ $0897
  yield 2;                                         // LDA #$A4
  s.phase = SP_B;
  yield 4;                                         // STA $FFFA
  yield 4;                                         // LDA $0885
  s.backAt = s.playAt;
  yield 4;                                         // STA $08A6
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spPhaseA

/** `$08A4` — the same window backwards; at the end the pad, or the refill. */
function* spPhaseB(s) {
  yield 3;                                         // PHA
  var v = s.buffer[s.backAt];
  yield 4;                                         // LDA $0800
  v >>= 1;
  yield 2;                                         // LSR A
  spOut(s, 'B', v);
  yield 4;                                         // STA $D418
  spAck(s);
  yield 4;                                         // CMP $DD0D
  yield* spStall(s);
  spInject(s, 'ack');
  s.ae = spByte(s.ae-1);
  yield 5;                                         // DEC $AE
  spInject(s, 'switch');
  if (s.ae !== 0) {
    yield 2;                                       // BEQ, not taken
    yield 6;                                       // DEC $08A6
    s.backAt = spByte(s.backAt-1);
    yield 4;                                       // PLA
    yield 6;                                       // RTI
    return;
  }
  yield 3;                                         // BEQ $08B8
  var af = s.af;
  yield 3;                                         // LDA $AF
  if (af === 0) {
    yield 3;                                       // BEQ $08F2
    yield* spRefill(s);
    return;
  }
  yield 2;                                         // BEQ, not taken
  yield 2;                                         // LDA #$C3
  s.phase = SP_C;
  yield 4;                                         // STA $FFFA
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spPhaseB

/** `$08C3` — one sample of silence, and then the phase that holds it. */
function* spPhaseC(s) {
  yield 3;                                         // PHA
  yield 2;                                         // NOP
  yield 2;                                         // LDA #$0E
  yield 2;                                         // LSR A
  spOut(s, 'C', SPEECH_SILENCE >> 1);
  yield 4;                                         // STA $D418
  spAck(s);
  yield 4;                                         // CMP $DD0D
  yield* spStall(s);
  spInject(s, 'ack');
  s.af = spByte(s.af-1);
  yield 5;                                         // DEC $AF
  spInject(s, 'switch');
  if (s.af === 0) {
    yield 3;                                       // BEQ $08F2
    yield* spRefill(s);
    return;
  }
  yield 2;                                         // BEQ, not taken
  yield 2;                                         // LDA #$D9
  s.phase = SP_D;
  yield 4;                                         // STA $FFFA
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spPhaseC

/** ★ `$08D9` — no write at all: the level the chip has is the level it keeps. */
function* spPhaseD(s) {
  spOut(s, 'D', null);
  spAck(s);
  yield 4;                                         // CMP $DD0D
  yield* spStall(s);
  spInject(s, 'ack');
  s.af = spByte(s.af-1);
  yield 5;                                         // DEC $AF
  spInject(s, 'switch');
  if (s.af !== 0) {
    yield 2;                                       // BEQ, not taken
    yield 6;                                       // RTI
    return;
  }
  yield 3;                                         // BEQ $08F1
  yield 3;                                         // PHA
  yield* spRefill(s);
} // spPhaseD

/** `$08E1` — the timer stops and `$07` is left behind. */
function* spPhaseEnd(s) {
  yield 3;                                         // PHA
  yield 2;                                         // LDA #$90
  s.timerOn = false;
  yield 4;                                         // STA $DD0F
  yield 2;                                         // LDA #$07
  spOut(s, 'E', SPEECH_SILENCE >> 1);
  yield 4;                                         // STA $D418
  spAck(s);
  yield 4;                                         // CMP $DD0D
  yield* spStall(s);
  spInject(s, 'ack');
  yield 4;                                         // PLA
  yield 6;                                         // RTI
  s.running = false;
} // spPhaseEnd

// ------------------------------------------------------------------ refilling

/**
 * `$08F2` — the window is reloaded from `$0CF2`/`$0CF3`, the pad from
 * `$0CF4`, and then either the next frame is unpacked (`$0913`) or the
 * repeat does its work (`$0911`).
 *
 * ★ The eleven cycles between `STA $FFFA` and `STA $AF` are the crack an
 * extra sample falls through: a nested interrupt in there runs the **new**
 * phase against the **old** counts.
 */
function* spRefill(s) {
  s.refills++;
  spInject(s, 'old');
  yield 4;                                         // LDA $0CF1
  s.phase = s.cf1;
  yield 4;                                         // STA $FFFA
  spInject(s, 'phase');
  yield 4;                                         // LDA $0CF2
  s.playAt = s.cf2;
  yield 4;                                         // STA $0885
  spInject(s, 'ptr');
  yield 4;                                         // LDA $0CF3
  s.ad = s.cf3;
  yield 3;                                         // STA $AD
  s.ae = s.cf3;
  yield 3;                                         // STA $AE
  spInject(s, 'count');
  yield 4;                                         // LDA $0CF4
  s.af = s.cf4;
  yield 3;                                         // STA $AF
  yield 2;                                         // CLD
  s.cf7 = spByte(s.cf7+1);
  yield 6;                                         // INC $0CF7
  if (s.cf7 === 0) {
    yield 3;                                       // BEQ $0913
    yield* spNewFrame(s);
    return;
  }
  yield 2;                                         // BEQ, not taken
  yield 3;                                         // JMP $0911
  if (s.after === SP_SHRINK) {
    yield* spShrink(s);
  } else if (s.after === SP_SMOOTH) {
    yield* spSmooth(s);
  } else {
    yield 4;                                       // $0937 PLA
    yield 6;                                       // RTI
  }
} // spRefill

/** `$0951` — the window walks up and shrinks, and at `$10` starts over. */
function* spShrink(s) {
  var len = s.cf3;
  yield 4;                                         // LDA $0CF3
  yield 2;                                         // CMP #$10
  if (len === 0x10) {
    yield 3;                                       // BEQ $096B
    yield 4;                                       // LDA $0CF2
    yield 2;                                       // AND #$40
    s.cf2 &= 0x40;
    yield 4;                                       // STA $0CF2
    yield 4;                                       // LDA $0CF8
    s.cf3 = s.cf8;
    yield 4;                                       // STA $0CF3
    yield 4;                                       // PLA
    yield 6;                                       // RTI
    return;
  }
  yield 2;                                         // BEQ, not taken
  yield 2;                                         // SEC
  yield 4;                                         // SBC $0CF9
  s.cf3 = spByte(len-s.cf9);
  yield 4;                                         // STA $0CF3
  yield 4;                                         // LDA $0CF2
  yield 2;                                         // CLC
  yield 4;                                         // ADC $0CF9
  s.cf2 = spByte(s.cf2+s.cf9);
  yield 4;                                         // STA $0CF2
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spShrink

/** `$0939` — the smoothing of a repeat, and a step of the contour. */
function* spSmooth(s) {
  yield 2;                                         // TXA
  yield 3;                                         // PHA
  yield 2;                                         // TYA
  yield 3;                                         // PHA
  var cfa = s.cfa;
  yield 4;                                         // LDA $0CFA
  yield 4;                                         // CMP $0CF2
  if (cfa === s.cf2) {
    yield 3;                                       // BEQ $0947
  } else {
    yield 2;                                       // BEQ, not taken
    yield 6;                                       // JSR $0BFD
    yield* spInterpolate(s);
  }
  yield 6;                                         // JSR $0B1D
  yield* spContour(s);
  yield 4;                                         // PLA
  yield 2;                                         // TAY
  yield 4;                                         // PLA
  yield 2;                                         // TAX
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spSmooth

/**
 * `$0913` — a new frame: the record's own counter, and then the handler
 * the record picked, unpacking into the half that is not being played.
 */
function* spNewFrame(s) {
  yield 2;                                         // TXA
  yield 3;                                         // PHA
  yield 2;                                         // TYA
  yield 3;                                         // PHA
  s.cf5 = spByte(s.cf5+1);
  yield 6;                                         // INC $0CF5
  if (s.cf5 === 0) {
    yield 3;                                       // BNE, not taken
    yield 6;                                       // JSR $09B6
    yield* spNextRecord(s);
  } else {
    yield 3;                                       // BNE $091F
  }
  yield 4;                                         // LDA $0CF6
  s.cf7 = s.cf6;
  yield 4;                                         // STA $0CF7
  var x = s.cf2;
  yield 4;                                         // LDA $0CF2
  x &= 0x40;
  yield 2;                                         // AND #$40
  x ^= 0x40;
  yield 2;                                         // EOR #$40
  yield 2;                                         // TAX
  yield 2;                                         // CLC
  yield 6;                                         // JSR $098C
  switch (s.handler) {
    case SP_PAUSE: yield* spPauseHandler(s); break;
    case SP_STOP: yield* spStopHandler(s); break;
    case SP_ONE: yield 3; yield* spUnpackOne(s, x); break;
    case SP_TWO: yield 3; yield* spUnpackTwoDirect(s, x); break;
    case SP_TWOI:
      yield 6;                                     // JSR $0A68
      yield* spUnpackTwo(s, x);
      yield 3;                                     // JMP $099B
      yield* spAfterUnpack(s);
      break;
    case SP_FOUR:
      yield 6;                                     // JSR $0AE5
      yield* spUnpackFour(s, x);
      yield* spAfterUnpack(s);
      break;
  }
  yield 4;                                         // PLA
  yield 2;                                         // TAY
  yield 4;                                         // PLA
  yield 2;                                         // TAX
  yield 4;                                         // PLA
  yield 6;                                         // RTI
} // spNewFrame

/** `$0981` — a pause: the ramp phase and a pad of `$80`. */
function* spPauseHandler(s) {
  yield 2;                                         // LDA #$C3
  s.cf1 = SP_C;
  yield 4;                                         // STA $0CF1
  yield 2;                                         // LDA #$80
  s.cf4 = SPEECH_PAUSE;
  yield 4;                                         // STA $0CF4
  yield 6;                                         // RTS
} // spPauseHandler

/** `$097B` — the end of the sentence: the closing phase. */
function* spStopHandler(s) {
  yield 2;                                         // LDA #$E1
  s.cf1 = SP_END;
  yield 4;                                         // STA $0CF1
  yield 6;                                         // RTS
} // spStopHandler

/**
 * `$09B6` — the byte 3 of the record last read is the operand of an `LDA
 * #`, and its bit 7 is the end of the sentence.
 */
function* spNextRecord(s) {
  var b7 = s.b7;
  yield 2;                                         // LDA #<$09B7>
  if (b7 & 0x80) {
    yield 2;                                       // BPL, not taken
    yield 2;                                       // LDA #$7B
    s.handler = SP_STOP;
    yield 4;                                       // STA $092F
    yield 6;                                       // RTS
    return;
  }
  yield 3;                                         // BPL $09C0
  yield* spRecord(s);
} // spNextRecord

/** `$09C0` — one record of the script, four bytes, and everything it sets. */
function* spRecord(s) {
  yield 2;                                         // LDY #$00
  var b0 = speechWord(s, s.script);
  yield 5;                                         // LDA ($A5),Y
  yield 2;                                         // ORA #$C0
  s.cf5 = b0 | 0xC0;
  yield 4;                                         // STA $0CF5
  yield 2;                                         // INY
  var b1 = speechWord(s, s.script+1);
  yield 5;                                         // LDA ($A5),Y
  yield 2; yield 2; yield 2;                       // LSR, LSR, LSR
  yield 2;                                         // ORA #$E0
  s.cf6 = (b1 >> 3) | 0xE0;
  yield 4;                                         // STA $0CF6
  if (b1 & 0x04) {                                 // ★ a pause: no pointer here
    yield 3;                                       // BCS $0A4B
    yield 2;                                       // LDY #$03
    s.b7 = speechWord(s, s.script+3);
    yield 5;                                       // LDA ($A5),Y
    yield 4;                                       // STA $09B7
    yield 2;                                       // LDA #$37
    s.after = SP_NOTHING;
    yield 4;                                       // STA $0911
    yield 2;                                       // LDA #$81
    s.handler = SP_PAUSE;
    yield 4;                                       // STA $092F
    yield* spAdvance(s);
    return;
  }
  yield 2;                                         // BCS, not taken
  yield 2;                                         // INY
  var b2 = speechWord(s, s.script+2);
  yield 5;                                         // LDA ($A5),Y
  yield 4;                                         // ADC $0CFE
  yield 3;                                         // STA $A9
  yield 2;                                         // INY
  var b3 = speechWord(s, s.script+3);
  yield 5;                                         // LDA ($A5),Y
  s.b7 = b3;
  yield 4;                                         // STA $09B7
  yield 2;                                         // AND #$3F
  yield 4;                                         // ADC $0CFF
  s.frame = s.base+(b2 | ((b3 & 0x3F) << 8));
  yield 3;                                         // STA $AA
  yield 2;                                         // LDA #$83
  s.cf1 = SP_A;
  yield 4;                                         // STA $0CF1
  yield 2;                                         // LDY #$01
  var mode = speechWord(s, s.script+1) & 0x03;
  yield 5;                                         // LDA ($A5),Y
  yield 2;                                         // AND #$03
  yield 2;                                         // TAX
  yield 2;                                         // CMP #$02
  if (mode >= 2) {
    yield 3;                                       // BPL $0A24
    yield 2;                                       // LDY #$00
    yield 5;                                       // LDA ($A5),Y
    yield 2; yield 2; yield 2;                     // ROL, ROL, ROL
    yield 2;                                       // AND #$03
    yield 2;                                       // TAY
    yield 4;                                       // LDA $0A47,Y
    s.cf3 = s.pads[(b0 >> 6) & 0x03];
    yield 4;                                       // STA $0CF3
    yield 2;                                       // LDA #$39
    s.after = SP_SMOOTH;
    yield 4;                                       // STA $0911
    yield 2;                                       // TXA
    yield 2;                                       // LSR A
    yield 2;                                       // LDA #$92
    yield (mode & 1) ? 3 : 2;                      // BCS $0A41
    if (!(mode & 1)) { yield 2; }                  // LDA #$98
    s.handler = (mode & 1) ? SP_TWOI : SP_FOUR;
    yield 4;                                       // STA $092F
    yield 3;                                       // JMP $0A5C
    yield* spAdvance(s);
    return;
  }
  yield 2;                                         // BPL, not taken
  yield 2;                                         // LDY #$00
  yield 5;                                         // LDA ($A5),Y
  yield 2;                                         // AND #$40
  var size = (b0 & 0x40) ? 0x40 : 0x20;
  if (b0 & 0x40) {
    yield 3;                                       // BNE $0A05
  } else {
    yield 2;                                       // BNE, not taken
    yield 2;                                       // LDA #$20
  }
  s.cf8 = size;
  yield 4;                                         // STA $0CF8
  yield 2; yield 2; yield 2;                       // LSR, LSR, LSR
  s.cf9 = size >> 3;
  yield 4;                                         // STA $0CF9
  yield 2;                                         // LDA #$51
  s.after = SP_SHRINK;
  yield 4;                                         // STA $0911
  s.cf4 = 0;                                       // `STY $0CF4` with Y = 0
  yield 4;                                         // STY $0CF4
  yield 2;                                         // TXA
  yield 2;                                         // LSR A
  yield 2;                                         // LDA #$8C
  yield (mode & 1) ? 3 : 2;                        // BCS $0A1E
  if (!(mode & 1)) { yield 2; }                    // LDA #$8F
  s.handler = (mode & 1) ? SP_ONE : SP_TWO;
  yield 4;                                         // STA $092F
  yield 3;                                         // JMP $0A5C
  yield* spAdvance(s);
} // spRecord

/** `$0A5C` — the script pointer steps on by four. */
function* spAdvance(s) {
  yield 3;                                         // LDA $A5
  yield 2;                                         // CLC
  yield 2;                                         // ADC #$04
  var low = (s.script & 0xFF)+4;
  s.script += 4;
  yield 3;                                         // STA $A5
  if (low > 0xFF) {
    yield 2;                                       // BCC, not taken
    yield 5;                                       // INC $A6
  } else {
    yield 3;                                       // BCC $0A67
  }
  yield 6;                                         // RTS
} // spAdvance

/**
 * `$099B` — after an unpacker that interpolates: bit 6 of byte 3 says
 * **play the raw frame this once**, and clears itself, so the repeats that
 * follow smooth it.
 */
function* spAfterUnpack(s) {
  var a = s.b7;
  yield 4;                                         // LDA $09B7
  yield 2;                                         // ASL A
  if (a & 0x40) {
    yield 2;                                       // BPL, not taken
    yield 2;                                       // ROR A
    yield 2;                                       // EOR #$40
    s.b7 = a ^ 0x40;
    yield 4;                                       // STA $09B7
    yield 4;                                       // LDA $0CFA
    s.cf2 = s.cfa;
    yield 4;                                       // STA $0CF2
    yield 3;                                       // JMP $0B1D
  } else {
    yield 3;                                       // BPL $09B0
    yield 6;                                       // JSR $0BFD
    yield* spInterpolate(s);
    yield 3;                                       // JMP $0B1D
  }
  yield* spContour(s);
} // spAfterUnpack

/**
 * `$0BFD` — the frame just unpacked averaged with the one being played,
 * `(a + b + 1)/2` byte by byte, into the other interpolation buffer.
 */
function* spInterpolate(s) {
  yield 2;                                         // LDX #$00
  yield 4;                                         // LDA $0CF2
  var old = s.cf2;
  yield 4;                                         // STA $0C1C
  yield 4;                                         // LDA $0CFA
  var src = s.cfa;
  yield 4;                                         // STA $0C18
  yield 4;                                         // LDA $0CF2
  yield 2;                                         // AND #$40
  yield 2;                                         // EOR #$40
  yield 2;                                         // ORA #$20
  var dst = (((s.cf2 & 0x40) ^ 0x40) | 0x20) & 0xFF;
  yield 4;                                         // STA $0C20
  var x = 0;
  do {
    var a = s.buffer[spByte(src+x)];
    yield 4;                                       // LDA $0800,X
    yield 2;                                       // SEC
    var sum = a+s.buffer[spByte(old+x)]+1;
    yield 4;                                       // ADC $0860,X
    yield 2;                                       // ROR A
    s.buffer[spByte(dst+x)] = ((sum & 0x100) >> 1) | ((sum & 0xFF) >> 1);
    yield 5;                                       // STA $0820,X
    x = spByte(x+1);
    yield 2;                                       // INX
    yield 4;                                       // CPX $0CF3
    yield x === s.cf3 ? 2 : 3;                     // BNE $0C17
  } while (x !== s.cf3);
  yield 4;                                         // LDA $0C20
  s.cf2 = dst;
  yield 4;                                         // STA $0CF2
  yield 6;                                         // RTS
} // spInterpolate

/**
 * `$0B1D` and `$0B31` — one step of the pitch contour: the value walks by
 * the increment for as many refills as the pair says, and then the next
 * pair of the stream is read. `$0CF4`, the pad, is the value halved.
 */
function* spContour(s) {
  s.cfb = spByte(s.cfb+1);
  yield 6;                                         // INC $0CFB
  if (s.cfb !== 0) {
    yield 2;                                       // BEQ, not taken
    yield 4;                                       // LDA $0CFC
    yield 2;                                       // CLC
    yield 4;                                       // ADC $0CFD
    s.cfc = spByte(s.cfc+s.cfd);
    yield 4;                                       // STA $0CFC
    yield 2;                                       // LSR A
    s.cf4 = s.cfc >> 1;
    yield 4;                                       // STA $0CF4
    yield 6;                                       // RTS
    return;
  }
  yield 3;                                         // BEQ $0B31
  yield 2;                                         // LDY #$00
  var b0 = speechWord(s, s.envelope);
  yield 5;                                         // LDA ($A7),Y
  yield 2;                                         // TAX
  yield 2;                                         // AND #$FE
  s.cfc = b0 & 0xFE;
  yield 4;                                         // STA $0CFC
  yield 2;                                         // TXA
  yield 2;                                         // LSR A
  s.envelope++;
  yield 5;                                         // INC $A7
  var b1 = speechWord(s, s.envelope);
  yield 5;                                         // LDA ($A7),Y
  yield 2; yield 2; yield 2; yield 2;              // ROR × 4
  yield 2;                                         // ORA #$E0
  s.cfb = 0xE0 | ((b0 & 1) << 4) | (b1 >> 4);
  yield 4;                                         // STA $0CFB
  yield 5;                                         // LDA ($A7),Y
  yield 2;                                         // AND #$0F
  yield 2;                                         // TAY
  yield 4;                                         // LDA $0B63,Y
  s.cfd = s.steps[b1 & 0x0F];
  yield 4;                                         // STA $0CFD
  var low = (s.envelope & 0xFF)+1;
  s.envelope++;
  yield 5;                                         // INC $A7
  if (low > 0xFF) {
    yield 2;                                       // BNE, not taken
    yield 5;                                       // INC $A8
  } else {
    yield 3;                                       // BNE $0B5B
  }
  yield 4;                                         // LDA $0CFC
  yield 2;                                         // LSR A
  s.cf4 = s.cfc >> 1;
  yield 4;                                         // STA $0CF4
  yield 6;                                         // RTS
} // spContour

// --------------------------------------------------------------- the unpackers

/**
 * `$0A75` — the body the two-bit unpackers share: four samples a byte, out
 * of the table `$AB` points at. ★ The first byte gives the table in its
 * bits 0-1 and its sample of bits 2-3 **twice**, because `$0A8F` jumps
 * into the middle of the next store.
 */
function* spTwoBody(s, x, first, end) {
  yield 4;                                         // STA $0AA3
  yield 2;                                         // AND #$03
  yield 2; yield 2;                                // ASL, ASL
  yield 2;                                         // CLC
  yield 2;                                         // ADC #$D5
  var table = (first & 0x03) << 2;
  yield 3;                                         // STA $AB
  yield 4;                                         // LDA $0AA3
  yield 2; yield 2;                                // LSR, LSR
  yield 2;                                         // AND #$03
  yield 2;                                         // TAY
  var v = s.amplitudes[table+((first >> 2) & 3)];
  yield 5;                                         // LDA ($AB),Y
  s.buffer[x] = v;
  yield 5;                                         // STA $0800,X
  x = spByte(x+1);
  yield 2;                                         // INX
  yield 3;                                         // JMP $0AAB
  for (;;) {
    s.buffer[x] = v;
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    yield 4;                                       // LDA $0AA3
    yield 2; yield 2; yield 2; yield 2;            // LSR × 4
    yield 2;                                       // AND #$03
    yield 2;                                       // TAY
    yield 5;                                       // LDA ($AB),Y
    s.buffer[x] = s.amplitudes[table+((first >> 4) & 3)];
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    yield 4;                                       // LDA $0AA3
    yield 2; yield 2; yield 2;                     // ROL × 3
    yield 2;                                       // AND #$03
    yield 2;                                       // TAY
    yield 5;                                       // LDA ($AB),Y
    s.buffer[x] = s.amplitudes[table+((first >> 6) & 3)];
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    var low = (s.frame & 0xFF)+1;
    s.frame++;
    yield 5;                                       // INC $A9
    if (low > 0xFF) {
      yield 2;                                     // BNE, not taken
      yield 5;                                     // INC $AA
    } else {
      yield 3;                                     // BNE $0AD4
    }
    yield 2;                                       // CPX #end
    if (x === end) {
      yield 2;                                     // BNE, not taken
      yield 6;                                     // RTS
      return;
    }
    yield 3;                                       // BNE $0A92
    yield 2;                                       // LDY #$00
    first = speechWord(s, s.frame);
    yield 5;                                       // LDA ($A9),Y
    yield 4;                                       // STA $0AA3
    yield 2;                                       // AND #$03
    yield 2;                                       // TAY
    yield 5;                                       // LDA ($AB),Y
    v = s.amplitudes[table+(first & 3)];
    s.buffer[x] = v;
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    yield 2;                                       // LDA #<$0AA3>
    yield 2; yield 2;                              // LSR, LSR
    yield 2;                                       // AND #$03
    yield 2;                                       // TAY
    v = s.amplitudes[table+((first >> 2) & 3)];
    yield 5;                                       // LDA ($AB),Y
  }
} // spTwoBody

/** `$0A68` — mode 3: two bits a sample, and the frame is interpolated after. */
function* spUnpackTwo(s, x) {
  yield 4;                                         // ADC $0CF3
  var end = spByte(x+s.cf3);
  s.amplitudes[0] = end;                           // ★ `$0AD5` is the `CPX` operand
  yield 4;                                         // STA $0AD5
  s.cfa = x;
  yield 4;                                         // STX $0CFA
  yield 2;                                         // LDY #$00
  var first = speechWord(s, s.frame);
  yield 5;                                         // LDA ($A9),Y
  yield* spTwoBody(s, x, first, end);
} // spUnpackTwo

/**
 * `$0BE3` — mode 0: the same body, but the table is forced to the first
 * one and the frame is played straight out of the buffer.
 * ★ It does **not** set `$0CFA`, because it jumps in past the `STX`.
 */
function* spUnpackTwoDirect(s, x) {
  s.cf2 = x;
  yield 4;                                         // STA $0CF2
  yield 4;                                         // ADC $0CF8
  var end = spByte(x+s.cf8);
  s.amplitudes[0] = end;
  yield 4;                                         // STA $0AD5
  yield 4;                                         // LDA $0CF8
  s.cf3 = s.cf8;
  yield 4;                                         // STA $0CF3
  yield 2;                                         // LDY #$00
  var first = speechWord(s, s.frame);
  yield 5;                                         // LDA ($A9),Y
  yield 2;                                         // AND #$FC
  yield 2;                                         // ORA #$01
  yield 3;                                         // JMP $0A75
  yield* spTwoBody(s, x, (first & 0xFC) | 0x01, end);
} // spUnpackTwoDirect

/**
 * `$0AE5` — mode 2: four bits a sample, a nibble doubled, low then high;
 * ★ and the first byte gives its **high** nibble twice, its low one never.
 */
function* spUnpackFour(s, x) {
  yield 4;                                         // ADC $0CF3
  var end = spByte(x+s.cf3);
  yield 4;                                         // STA $0B19
  s.cfa = x;
  yield 4;                                         // STX $0CFA
  yield 2;                                         // LDY #$00
  var b = speechWord(s, s.frame);
  yield 5;                                         // LDA ($A9),Y
  yield 2; yield 2; yield 2;                       // LSR × 3
  yield 2;                                         // AND #$1E
  var v = (b >> 3) & 0x1E;
  s.buffer[x] = v;
  yield 5;                                         // STA $0800,X
  x = spByte(x+1);
  yield 2;                                         // INX
  yield 3;                                         // JMP $0B0E
  for (;;) {
    s.buffer[x] = v;
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    var low = (s.frame & 0xFF)+1;
    s.frame++;
    yield 5;                                       // INC $A9
    if (low > 0xFF) {
      yield 2;                                     // BNE, not taken
      yield 5;                                     // INC $AA
    } else {
      yield 3;                                     // BNE $0B18
    }
    yield 2;                                       // CPX #end
    if (x === end) {
      yield 2;                                     // BNE, not taken
      yield 6;                                     // RTS
      return;
    }
    yield 3;                                       // BNE $0AFE
    b = speechWord(s, s.frame);
    yield 5;                                       // LDA ($A9),Y
    yield 2;                                       // ASL A
    yield 2;                                       // AND #$1E
    s.buffer[x] = (b << 1) & 0x1E;
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    yield 5;                                       // LDA ($A9),Y
    yield 2; yield 2; yield 2;                     // LSR × 3
    yield 2;                                       // AND #$1E
    v = (b >> 3) & 0x1E;
  }
} // spUnpackFour

/**
 * `$0BC4` — the chain of stores at the end of `$0BAF`: each one puts out
 * the value it was handed and then takes the next bit out of `Y`, so there
 * is one bit less than there are stores.
 * @param {Object} s - The player.
 * @param {number} x - Where in the buffer.
 * @param {number} v - The value the first store puts out.
 * @param {number} bits - What is left in `Y`.
 * @param {number} stores - Four from `$0BAF`, three from `$0BC4`.
 * @returns {{x: number, bits: number}}
 */
function* spChain(s, x, v, bits, stores) {
  for (var i = 0; i < stores; i++) {
    s.buffer[x] = v;
    yield 5;                                       // STA $0800,X
    x = spByte(x+1);
    yield 2;                                       // INX
    if (i === stores-1) {
      break;
    }
    yield 2;                                       // TYA
    yield 2;                                       // LSR A
    yield 2;                                       // TAY
    yield 2;                                       // LDA #$0E
    yield (bits & 1) ? 2 : 3;                      // BCC
    if (bits & 1) { yield 2; }                     // LDA #$10
    v = (bits & 1) ? 0x10 : 0x0E;
    bits >>= 1;
  }
  yield 6;                                         // RTS
  return {x: x, bits: bits};
} // spChain

/**
 * `$0BAF` — four samples out of the low four bits of `A`, `$0E` for a zero
 * and `$10` for a one.
 * @param {Object} s - The player.
 * @param {number} x - Where in the buffer.
 * @param {number} a - The bits.
 * @returns {{x: number, bits: number}} Where it stopped and what is left.
 */
function* spBits(s, x, a) {
  yield 2;                                         // LSR A
  yield 2;                                         // TAY
  yield 2;                                         // LDA #$0E
  yield (a & 1) ? 2 : 3;                           // BCC $0BB7
  if (a & 1) { yield 2; }                          // LDA #$10
  return yield* spChain(s, x, (a & 1) ? 0x10 : 0x0E, a >> 1, 4);
} // spBits

/**
 * `$0B73` — mode 1: **one bit a sample**, eight to a byte; ★ and the first
 * byte starts at its bit 1, which it gives twice, so its bit 0 is never
 * heard.
 */
function* spUnpackOne(s, x) {
  s.cf2 = x;
  yield 4;                                         // STA $0CF2
  yield 4;                                         // ADC $0CF8
  var end = spByte(x+s.cf8);
  yield 4;                                         // STA $0BAB
  yield 4;                                         // LDA $0CF8
  s.cf3 = s.cf8;
  yield 4;                                         // STA $0CF3
  yield 2;                                         // LDY #$00
  var b = speechWord(s, s.frame);
  yield 5;                                         // LDA ($A9),Y
  yield 2; yield 2;                                // LSR, LSR
  yield 2;                                         // TAY
  yield 2;                                         // LDA #$0E
  var v = (b & 0x02) ? 0x10 : 0x0E;
  yield (b & 0x02) ? 2 : 3;                        // BCC $0B8F
  if (b & 0x02) { yield 2; }                       // LDA #$10
  s.buffer[x] = v;
  yield 5;                                         // STA $0800,X
  x = spByte(x+1);
  yield 2;                                         // INX
  yield 6;                                         // JSR $0BC4
  var r = yield* spChain(s, x, v, b >> 2, 3);
  x = r.x;
  yield 3;                                         // JMP $0BA0
  for (;;) {
    yield 2;                                       // TYA
    yield 6;                                       // JSR $0BAF
    r = yield* spBits(s, x, r.bits);
    x = r.x;
    var low = (s.frame & 0xFF)+1;
    s.frame++;
    yield 5;                                       // INC $A9
    if (low > 0xFF) {
      yield 2;                                     // BNE, not taken
      yield 5;                                     // INC $AA
    } else {
      yield 3;                                     // BNE $0BAA
    }
    yield 2;                                       // CPX #end
    if (x === end) {
      yield 2;                                     // BNE, not taken
      yield 6;                                     // RTS
      return;
    }
    yield 3;                                       // BNE $0B99
    yield 2;                                       // LDY #$00
    b = speechWord(s, s.frame);
    yield 5;                                       // LDA ($A9),Y
    yield 6;                                       // JSR $0BAF
    r = yield* spBits(s, x, b);
    x = r.x;
  }
} // spUnpackOne

// ---------------------------------------------------------------- starting up

/**
 * `$0C2F` with a sentence's index in `A`, through `$0CAB` and `$0C89`:
 * the pointers of the sentence, the decoder rearmed and the timer started.
 *
 * ★ The base of the data comes from `$0CFE`/`$0CFF`, which the file leaves
 * at `$E000` and which nothing in the game ever changes (the `$FD` command
 * that would is never used).
 *
 * ★ And the very first period of the timer is **not observable**: `$0C71`
 * writes `$DD0F` before it writes the latch, so the force load reloads
 * whatever was in there from before. The model starts a full period after
 * the interrupt is enabled — the one unobservable initial state of the
 * speech, in the sense of `ZADANI.md` §10.7.
 *
 * @param {Object} s - The player.
 * @param {number} index - 0-7.
 */
function speechStart(s, index) {
  var d = s.defaults;
  var base = d[0x0CFE-0x0CF1] | (d[0x0CFF-0x0CF1] << 8);
  var entry = base+index*4;                        // `$0CAB`: index*4 + the base
  s.base = base;
  s.envelope = base+(speechWord(s, entry) | (speechWord(s, entry+1) << 8));
  s.script = base+(speechWord(s, entry+2) | (speechWord(s, entry+3) << 8));
  s.b7 = 0;                                        // `$09B7` cleared by `$0CE5`
  s.cf1 = SP_C;                                    // `$0C93` calls `$0981`
  s.cf4 = SPEECH_PAUSE;
  s.cf2 = d[0x0CF2-0x0CF1];
  s.cf3 = d[0x0CF3-0x0CF1];
  s.cf5 = 0xFE;                                    // `$0C89`: three counters at $FE
  s.cf6 = 0xFE;
  s.cf7 = 0xFE;
  s.cf8 = d[0x0CF8-0x0CF1];
  s.cf9 = d[0x0CF9-0x0CF1];
  s.cfa = d[0x0CFA-0x0CF1];
  s.cfb = d[0x0CFB-0x0CF1];
  s.cfc = d[0x0CFC-0x0CF1];
  s.cfd = d[0x0CFD-0x0CF1];
  s.after = SP_NOTHING;                            // `$0911` = $37
  s.handler = SP_PAUSE;                            // `$092F` = $81
  s.phase = SP_C;                                  // `$FFFA` = $08C3
  s.ad = 0; s.ae = 0; s.af = 1;                    // `$AF` = 1: the first NMI refills
  s.playAt = 0; s.backAt = 0;
  s.frame = 0;                                     // `$A9`/`$AA`
  s.out.length = 0;
  s.refills = 0;
  s.handlers.length = 0;
  s.waitAt = 0;
  s.icr = false;
  s.pending = false;
  s.timerOn = true;
  s.underflow = s.cycle+SPEECH_CYCLES;
  s.running = true;
} // speechStart

/**
 * Runs the sentence to its end: instruction by instruction, with the timer
 * underflowing on its own and the interrupt taken where the machine would
 * take it.
 * @param {Object} s - The player.
 * @param {number} [limit] - A ceiling on the instructions, so a broken script cannot hang.
 */
function speechRun(s, limit) {
  var max = limit || 60000000;
  while (s.running && max-- > 0) {
    if (s.until && s.out.length >= s.until) {
      return;
    }
    spInstruction(s);
  }
} // speechRun

/**
 * A whole sentence, as the game hears it.
 *
 * @param {Object} data - The parsed `data/speech.json`.
 * @param {number} index - The sentence, 0-7.
 * @returns {{samples: Uint8Array, holds: Array, out: Array, cycles: number}}
 *   `samples` are the four-bit values as the chip sees them, with the level
 *   held where a phase writes nothing; `out` is every step with its phase
 *   and cycle, which is what `tools/matchsound.mjs` compares.
 */
function speechSentence(data, index, options) {
  var s = speechMachine(data);
  speechStart(s, index);
  options = options || {};
  s.inject = options.inject || null;
  s.stall = options.stall || null;
  s.badline = options.badline || null;
  s.until = options.until || 0;
  speechRun(s);
  var held = SPEECH_SILENCE >> 1;
  var samples = new Uint8Array(s.out.length);
  for (var i = 0; i < s.out.length; i++) {
    if (s.out[i].value !== null) { held = s.out[i].value; }
    samples[i] = held;
  }
  return {samples: samples, out: s.out, cycles: s.cycle};
} // speechSentence

if (typeof self !== 'undefined') {
  self.speechMachine = speechMachine;
  self.speechStart = speechStart;
  self.speechRun = speechRun;
  self.speechSentence = speechSentence;
  self.SPEECH_CYCLES = SPEECH_CYCLES;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {speechMachine: speechMachine, speechStart: speechStart,
                    speechRun: speechRun, speechSentence: speechSentence,
                    SPEECH_CYCLES: SPEECH_CYCLES};
}
