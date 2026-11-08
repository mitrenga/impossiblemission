IMPOSSIBLE MISSION (Commodore 64, 1984) — remake
================================================

**Internal project until the operator decides otherwise.** Impossible
Mission is © Epyx 1984; the rights are believed to be held by System 3
today (to be confirmed in M0). This remake is not published, distributed
or deployed anywhere public. It is the second game on the Commodore 64
platform (`C64Platform`, `C64Layout`) of the **svision** library after
Bruce Lee, and the first svision game with sampled speech on an 8-bit
machine (the SID `$D418` volume-register trick), carried by the
`dump*` → `trace*` → `match*` method.

**Status: M0, M1, M2 and the first part of M3 done (2026-09-19).** The operator has decided how this
runs (2026-09-19): **internally**, as a test of the svision library against
its Commodore 64 platform, and any decision about using it will be taken
only after a letter has been sent to whoever holds the rights. What is left
of M0 is establishing who that is, since the letter needs an addressee; what is left of M1 is gamepad input,
key remapping and the pause panel. The application has been checked in a
browser: it switches the machine on, loads the way the manual says, shows
the original's title screen and moves on to the menu. The room of M2 has been looked at too: what
the browser shows is identical to the reference `tools/renderroom.mjs`
draws outside the browser into `build/rooms_png/`.

M2 shuffles a fortress with the original's own two shuffles and **builds**
a room with the original's own builder, in a worker: `R  A ROOM OF THE
FORTRESS` in the menu walks the 32 rooms (arrows change the room and the
side the agent comes in from, `N` shuffles another fortress). Nothing there
is drawn — the screen codes, the colours, the character set and the sprites
all come from the original, and both ways of building a room are measured:
`tools/matchrooms.mjs` (64 rooms against the machine, 4,246,144 checks, 0
differences) and `tools/matchrooms.mjs --data` (the same room built from
`data/rooms.json`, 131,008 checks, 0 differences). The speech is taken
apart too, but as an index rather than as sound: eight sentences, two
streams each and shared frames, played from a CIA2 timer B NMI every 101
cycles (`tools/dumpspeech.py`, 54 checks, 0 differences); making a sound
of it is M6.

M3 makes the agent move, and he moves **with the original's own code**.
The main loop turned out to be two loops — `$7249` in a room, `$3A15` in
the lift shaft, told apart by `$1A` — and both wait for the frame in
`$7F6B` while the raster interrupt counts frames in `$E0`
(`sources/docs/disasm_notes.md` §19). What is transcribed in
`app/player.js` is the walk (five pixels every **third pass of the loop**),
the somersault out of the five tables at `$8D05`, the collision with the
background **by characters** (`$8CC3`: column = (x − 24)/8, row =
(y − 50)/8, solid is `$45`-`$51`), falling with its drift and its landing,
the fall that kills, the sprite pointers with the mirroring that turns the
agent round, and the clock (a game second is **sixty frames**). The lift
ride, searching, terminals and the way from one room to the next are not
transcribed yet: the port recognises them and says so instead of guessing.

The measurement is `tools/traceplayer.py` against `tools/matchplayer.mjs`:
a **6502 harness in the original's own memory** — a 256-byte table of
joystick bytes, one a frame, a handler at `$0300` that all eighteen reads
of `$DC00` are routed to, a frame counter in the interrupt and a counter
of **passes of the main loop** — records the original frame by frame, and
the port is run on the same memory. **80 recordings, 2 442 frames, 215 322
checks, 0 differences.** One finding came out of the pass counter: in a
room with a lot of furniture **one pass does not fit into a frame**, so the
original's agent walks slower there; that is the speed of the 6510 rather
than the logic of the game, the remake does not reproduce it yet
(`ZADANI.md` §10.6), and those recordings are not measured past the frame
where it starts.

**Collisions are hardware.** `$94FA`, the one place the agent dies of a
touch, does not compare rectangles: it reads **`$D01E`**, the register the
VIC-II fills from the pixels it actually put out. The one distance
calculation above it is for **sprite 0 alone** — sprite 0 is shared between
the black ball and a robot's bolt, so the game measures `2·dX + dY` from the
middle of the agent (the average of his **four edges**) and lets the ball
vanish if any robot is nearer. Two things were measured rather than assumed
(`sources/docs/disasm_notes.md` §30): the latch is read **at two places** —
the interrupt every frame in a room, the agent's step every **third** pass
— which is what decides where the raster's sweep belongs in the port; and
**the border does not cut the collision off** although it cuts the picture
off, which is why the register class went into the library with the whole
raster as its window (`C64Collision`, R-043). The measurement is
`tools/traceplayer.py --collision`, which rewrites both `LDA $D01E` inside
`$94FA` to a stub because a register that clears itself on reading leaves
nothing in memory to find afterwards, against
`tools/matchcollision.mjs`: **26 recordings, 4,931 frames, 231,757 checks,
0 differences** — and in one of them the agent dies on the very frame the
original does.

**Dying is a build, not an animation.** When a robot's touch or a fall sets
`$43`, the game goes to `$95DA` and does a whole ceremony
(`sources/docs/disasm_notes.md` §31). ★ The agent's three sprites are
**copied into `$4D80` first** and his pointers redirected there, so what
dissolves is a copy and not the sprite data of the game; then 33 rounds of
49 bytes each have one bit knocked out of them, and which bit and where
comes from the same shuffler as everything else in the fortress. Then the
room is **built again without being drawn**: the lifts go back to where they
started (the same routine the security terminal's lift reset uses), robots,
ball and the agent's entry come out of the room's record through the same
routines the room builder calls — and the clock goes **ten minutes**
forward, through the same routine it ticks minutes with.

★ **A frame is not the unit here**: `SEI` holds from `$95E8` to `$96F5`, so
nothing in the world moves while it runs, and the recording is therefore
made of **stops** rather than frames (`tools/tracedeath.py`,
`tools/matchdeath.mjs`: **148 stops, 89,052 checks, 0 differences**). ★ And
`$9707` is already past the `CLI`, so the last thing the interrupt touched
is not the ceremony's — which is why there are five stops and not four.

**And the game can now end.** The clock runs from twelve to six, and when
`$83C2` rolls the hour over onto the sixth, `$83DF` puts `$FF` into `$43`
— the same byte that otherwise says how the agent died. The top of the main
loop asks about it (`$83EA`), the ceremony above asks first and therefore
never starts (`$95DC`), and what follows is `$83F2`: the border goes white,
the speech says its fifth sentence, the picture shakes for 128 rounds and
then dissolves for another 128, and the score board goes up
(`sources/docs/disasm_notes.md` §33, `app/endGame.js`).

★ There are exactly **two** ways into that board in the whole program —
time running out (`$84BF`) and the control room (`$AB64`) — and which one
it was is told by the clock alone. ★ The score is three BCD bytes at
`$D9`, and the manual's numbers are in the code to the last point, because
`$BB48` adds into the **middle** byte: a piece and a password are worth a
hundred, a solved puzzle five hundred, a completed mission a thousand, and
a remaining second one. Every line of the board is a little equation,
`n × 100 = n00`, laid over a thirteen-byte mask. ★ The hall of fame has
sixteen entries although it shows fifteen: the sixteenth is the overflow
bin the lowest pushed-out entry falls into.

★ A frame is not the unit here either — `$8401` holds `SEI` all the way to
the new game — so this too is measured in **stops**: `tools/traceend.py`
and `tools/matchend.mjs`, **7 recordings, 1,846 stops, 896,117 checks, 0
differences**. Two things are deliberately left out and both are named in
the tools: `$731C`, which redraws the shaft's lower panel and is really the
pocket computer, and `$BDFB`, which saves the hall of fame to the disk — in
the remake that is `localStorage`.

The application now boots the machine, types the manual's own `LOAD"*",8`
and `RUN`, and shows the original's title screen built out of its memory.
That screen is proved: the library paints it and `tools/matchscreen.mjs`
compares it with a screenshot of VICE, **64,000 pixels, 0 differences**.
The library grew multicolour character mode and a class for a game's own
character set to make it possible (`checkc64.mjs`, now 195 checks, 0 differences). The reference machine is
a **PAL C64 at 50 Hz** (operator, 2026-09-19), so a frame is 19,656 cycles
and every measurement is written per frame; the speech is the exception,
it runs outside the frame and is measured in cycles.

The program is proved. The game is built from its disk by the original's
own loader and unpacker, reimplemented in `tools/unpack.py` out of the
6502 code, and the result is compared with the memory of the running
machine byte for byte: **57,088 checks, 229 differences, 0 unexplained**.
The speech, 6,016 bytes living at `$E000` under the switched-out KERNAL
ROM, matches byte for byte. The two differing regions are named: the
game's entry routine at `$3855`, which wipes itself after running, and
the live variables at `$CF00`.

Also measured: the game's interrupt handler is at `$82E7` (`$838C` is only
the initialisation), its entry point
is `$3855`, it runs in multicolor character mode with sprites always in
front of the background, and the manual is transcribed as the primary
authority on the rules (`sources/docs/manual_transcript.md`).

## Running it

Nothing to run yet. From M1 on, like every svision project: `config/config.php`
out of `config/config.php.sample` (`$devMode = true`), serve the directory
with nginx + PHP; the browser loads `app/` directly, nothing is built.

Planned tools (M0, shared with `brucelee` in `svision/tools/retro/c64/`):
`c64emu.py` (VICE `x64sc` headless through its remote monitor, frame and
cycle stepping, memory dumps), `matchimage.py` (three independent images →
one program), `dumpvic.py` (VIC-II registers per frame →
`sources/docs/vic_state.md`), `dis6502.py` (C64 symbols). Project-specific
from M2: `dumprooms.py` / `tracerooms.py` / `matchrooms.mjs` (a room is not
a picture — the original builds it from a record, and so does
`app/roomBuild.js`), `tracefortressgen.py` / `matchfortressgen.mjs`
(the fortress is shuffled from a seed by the original's own code),
`dumpspeech.py`.

The original program images and the Commodore ROMs are copyrighted and are
**not** part of this directory; see `sources/README.md`.
