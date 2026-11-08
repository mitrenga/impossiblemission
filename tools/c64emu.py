#!/usr/bin/env python3
"""c64emu — Impossible Mission's view of the shared VICE wrapper.

The emulator wrapper itself lives in the library since 2026-10-18:
`svision/tools/retro/c64/c64emu.py` (R-008 — `r-type` was the second
consumer and moved it there). This file keeps for the tools here what was
specific to this game, so that none of them had to change:

- the ROMs come from **this project's** `sources/rom/` (R-041), whatever
  the current directory is;
- `GAME_IRQ` / `IRQ_PER_FRAME` — ★ the game's raster handler `$82E8` runs
  **twice a frame** (a split interrupt, 9 829 cycles a hit against 19 656
  cycles of a PAL frame, disasm_notes §1), so a frame is two hits;
- `frames_after(irq, frames, checknum=1, per_frame=IRQ_PER_FRAME)` in the
  argument order the tools call it with;
- the CLI steps by game frames (`--irq 82e8`) unless told otherwise.

    from c64emu import C64Emu
    e = C64Emu('sources/disk/impossible_mission_clean.d64')
    e.brk(0x0810)
    e.bsave('build/mem.bin', 0x0800, 0xAA7F)
    r = e.run(cycles=90_000_000, screenshot='build/boot.png')

CLI:
    ./tools/c64emu.py IMAGE --cycles 90000000 --screenshot build/boot.png
    ./tools/c64emu.py IMAGE --irq '' --break 0810 --dump 0800:aa7f:build/mem.bin
    ./tools/c64emu.py IMAGE --irq '' --watch-store 0314 --cycles 20000000   # kdo bere IRQ
"""
import importlib.util, os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
# loaded by path under another name: `import c64emu` would return this very
# file, which the tools already have in `sys.modules` under that name
_spec = importlib.util.spec_from_file_location(
    'svision_c64emu', os.path.join(PROJECT, 'app', 'svision', 'tools', 'retro', 'c64', 'c64emu.py'))
_shared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shared)

ROMS = _shared.ROMS
ROM = os.path.join(PROJECT, 'sources', 'rom')
CYCLES_PER_FRAME_PAL = _shared.CYCLES_PER_FRAME_PAL
CYCLES_PER_FRAME_NTSC = _shared.CYCLES_PER_FRAME_NTSC
Result = _shared.Result
# ★ obsluha přerušení hry a kolikrát za snímek běží (disasm_notes §1)
GAME_IRQ = 0x82E8
IRQ_PER_FRAME = 2


class C64Emu(_shared.C64Emu):
    def __init__(self, image=None, project=None, **kw):
        super().__init__(image, project=project or PROJECT, **kw)

    def frames_after(self, irq_addr, frames, checknum=1, per_frame=IRQ_PER_FRAME):
        return super().frames_after(irq_addr, frames, per_frame, checknum)


def main():
    _shared.main(emu=C64Emu, default_irq=GAME_IRQ, default_per_frame=IRQ_PER_FRAME,
                 default_project=PROJECT)


if __name__ == '__main__':
    main()
