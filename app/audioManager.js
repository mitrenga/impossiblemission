const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { AudioChipHandler } = await import('./svision/js/audio/audioChipHandler.js?ver='+window.srcVersion);
const { AudioSilentHandler } = await import('./svision/js/audio/audioSilentHandler.js?ver='+window.srcVersion);
const { SID } = await import('./svision/js/audio/chip/sid.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
// begin code

/**
 * The sound of Impossible Mission: one bus, **`sid`**, which is the
 * machine's own chip (svision `audio/chip/sid.js`, the 6581 at the PAL
 * clock) driven by the register writes the worker reports frame by frame
 * (`frame.sid`, WORKER-PROTOCOL.md) — ★ what the original writes into
 * `$D400`-`$D418` where it writes it (`app/sound.js`, M6). The stream runs
 * in an AudioWorklet (svision `AudioChipHandler`, `ChipStream`): the
 * writes keep their place in the frame, the audio thread keeps its clock.
 *
 * ★ **And the speech rides on the same bus**, because on the machine it
 * rides on the same register: a sentence arrives as one **block of
 * samples** (`frame.speech`), 9 755 four-bit values a second into `$D418`,
 * and the stream unpacks it as it renders instead of being handed tens of
 * thousands of writes (`ChipStream.block`, `app/speech.js` §32). That is
 * also why pausing has to silence the speech — it is not a sample the
 * browser is playing, it is the chip being driven, so stopping the bus
 * stops it.
 *
 * One slider for the one bus (R-024: the volume cookie of the siblings,
 * `audioBusSoundsLevel`); the menu is silent and the bus opens in the game
 * behind the user's gesture. A browser without AudioWorklet gets the silent
 * handler.
 */
export class AudioManager extends AbstractAudioManager {

  /**
   * ★ The bus of the chip: the 6581 at 985 248 Hz, fifty frames a second,
   * and the unit a write is placed by is **a cycle of the 6510** — 19 656
   * of them in a PAL frame (R-038) — because the speech is timed in cycles
   * and not in raster lines. The writes are placed 60 ms ahead of the audio
   * thread. `gain` 3 brings the chip's own scale up to the loudness of the
   * sibling remakes at the same slider.
   */
  static get SID_OPTIONS() {
    return {chip: 'SID', chipSource: 'audio/chip/sid.js', clock: SID.CLOCK_PAL,
            rate: 50, lines: 19656, latency: 0.06, maxLead: 0.25, gain: 3};
  } // SID_OPTIONS

  constructor(app) {
    super(app);
    this.id = 'AudioManager';
    this.volume = {};
    this.volume.sid = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusSoundsLevel', 5)))));
  } // constructor

  /**
   * The handler of the `sid` bus: the chip in a worklet at the slider's
   * level, or the silent one at 0 (unless the volume dialog says otherwise)
   * or when the worklet is not supported.
   * @param {string} bus - The bus asked for.
   * @param {Object} options - The bus options, which the chip's are put into.
   * @returns {Object|boolean} The handler, or false for a bus that is not ours.
   */
  createAudioHandler(bus, options) {
    if (bus != 'sid') {
      return false;
    }
    var volume = this.volumeLevel(this.volume.sid);
    if (options.audioSilentHandler != 'disable' && volume == 0.0) {
      return new AudioSilentHandler(this.app);
    }
    if (this.unsupportedAudioBus === false) {
      this.unsupportedAudioBus = Tool.readCookie('unsupportedAudioBus', false);
    }
    if (this.unsupportedAudioBus !== false) {
      Tool.writeCookie('unsupportedAudioBus', 'AudioChipHandler');
      return new AudioSilentHandler(this.app);
    }
    Object.assign(options, AudioManager.SID_OPTIONS);
    var handler = new AudioChipHandler(this.app);
    handler.setBusVolume(volume);
    return handler;
  } // createAudioHandler

  /** the slider's ten steps as a gain, the table of the sibling remakes */
  volumeLevel(volume) {
    var levels = [0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.14, 0.18, 0.23, 0.29];
    return levels[volume];
  } // volumeLevel

  /**
   * The sample of the volume dialog: ★ **the lift**, because it is the
   * first thing anybody hears in this game and it is two voices at once —
   * a sawtooth and a noise whose pitch walks with the frame counter
   * (`$85B3`, `app/sound.js`). A second of it, then silence.
   * @param {string} bus - The bus.
   * @param {string} sound - Which sample.
   * @param {Object} options - Unused.
   * @returns {Object|boolean} `{script: [[…writes], …]}` or false.
   */
  audioData(bus, sound, options) {
    var data = super.audioData(bus, sound, options);
    if (data !== false) {
      return data;
    }
    if (bus == 'sid' && sound == 'exampleSound') {
      var frames = [];
      var tone1 = 0, tone2 = 0;
      for (var f = 0; f < 50; f++) {
        var writes = [];
        if (f == 0) {
          writes.push([0, 0x18, 0x0F]);            // the volume the game runs at
        }
        if (tone1 < 0x20) { tone1 += 4; }
        if (tone2 < 0x18) { tone2 += 3; }
        // `$85C7` with the frame counter, two steps of the lift a frame
        for (var step = 0; step < 2; step++) {
          var counter = (f*2+step) & 0xFF;
          var at = step*9828;
          var high = counter >> 2;
          var low = ((counter & 1) << 7) | (counter >> 1);
          low = (((counter >> 1) & 1) << 7) | (low >> 1);
          writes.push([at, 0x01, high ^ tone1], [at, 0x08, high ^ tone2],
                      [at, 0x00, low & 0xFF], [at, 0x07, low & 0xFF],
                      [at, 0x05, 0], [at, 0x0C, 0],
                      [at, 0x06, 0x8F], [at, 0x0D, 0x8F],
                      [at, 0x04, 0x21], [at, 0x0B, 0x81]);
        }
        frames.push(writes);
      }
      frames.push([[0, 0x04, 0x08], [0, 0x0B, 0x08], [0, 0x12, 0x08]]);
      return {script: frames};
    }
    return false;
  } // audioData

} // AudioManager
