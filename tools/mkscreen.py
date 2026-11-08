#!/usr/bin/env python3
"""mkscreen — obrazovka originálu z paměti běžícího stroje do data/screen.json.

Podklad pro M1: aplikace má ukázat **obraz postavený z paměti originálu**,
ne dokreslený. Nástroj zastaví emulátor na N-tém přerušení hry (`$838C`,
`disasm_notes.md` §1), vytáhne obrazovou paměť, Color RAM, znakovou sadu,
registry VIC a sprajty a uloží je jako JSON.

    ./tools/mkscreen.py --irq 1000 --name elevator
    ./tools/mkscreen.py --irq 14000 --walk 400 --entropy 42 --name room

Pozor: Color RAM a registry se čtou přes `bank io` monitoru VICE, obrazová
paměť a sada přes `bank ram` — jinak by se pod `$D000` četla ROM znaků.
"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from c64emu import C64Emu

from c64emu import GAME_IRQ as IRQ


# ★ všech 18 míst, kde hra čte joystick (`disasm_notes.md` §12) — se dvěma
# (§7) agent ze šachty nevyjde, takže by se obrazovka místnosti nezachytila
JOY_SITES = (0x3A3C, 0x3A7C, 0x3A85, 0x3AA4, 0x3B1E, 0x3E17, 0x7263, 0x81EA,
             0x81F1, 0x87F1, 0x8849, 0x98B8, 0x99C7, 0x9F5D, 0x9F68, 0x9F89,
             0xA808, 0xACCF)
RIGHT = 0x77                 # joystick doprava, aktivní v nule
ENTROPY_SITE = 0x82E3        # `EOR $D012` v míchačce (§8)


def capture(image, irq, name, cycles, outdir='build/screen', walk=0, idle=0, entropy=None):
    """Zastaví hru na `irq`-tém přerušení a vytáhne paměť a registry.

    ★ Obrazovka hry je **dělená**: obsluha `$82E8` mění registry dvakrát za
    snímek (rastr 171 a 256, `disasm_notes.md` §5, §6). Proto se registry
    čtou u **dvou po sobě jdoucích** přerušení — první sada platí pro to,
    co je nad předělem, druhá pro to pod ním.

    S `walk` se hra po `irq` snímcích ještě rozejde **doprava**, dokud
    agent nevejde do místnosti — tím se zachytí obrazovka místnosti,
    ne šachty. S `entropy` je pevnost pokaždé tatáž, takže i ta místnost.
    """
    os.makedirs(outdir, exist_ok=True)
    e = C64Emu(image)
    if entropy is not None:
        e.cmd('break exec $3855')
        e.go()
        e.cmd('> %04x 49 %02x ea' % (ENTROPY_SITE, entropy))
        e.cmd('del 1')
    e.frames_after(IRQ, irq)
    if walk:
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, RIGHT))
        e.ignore(1, walk*2)
        e.go()
    if idle:
        # ★ páčka zpátky do klidu: agent se zastaví, a tím se z porovnání se
        # snímkem ztratí to, co dělá jeho chůze mezi dumpem a snímkem
        for site in JOY_SITES:
            e.cmd('> %04x a9 %02x ea' % (site, 0x7F))
        e.ignore(1, idle*2)
        e.go()
    e.cmd('registers')
    e.cmd('bank ram')
    e.bsave('%s/%s_ram.bin' % (outdir, name), 0x0000, 0xFFFF)      # celých 64 KB: všechny banky VIC
    e.cmd('bank io')
    e.bsave('%s/%s_vic.bin' % (outdir, name), 0xD000, 0xD02E)
    e.bsave('%s/%s_color.bin' % (outdir, name), 0xD800, 0xDBFF)
    e.bsave('%s/%s_cia.bin' % (outdir, name), 0xDC00, 0xDD0F)
    e.go()                                   # další přerušení = druhá půlka
    e.cmd('bank io')
    e.bsave('%s/%s_vic2.bin' % (outdir, name), 0xD000, 0xD02E)
    r = e.run(cycles=cycles, screenshot='%s/%s.png' % (outdir, name),
              monlog='%s/%s.log' % (outdir, name), moncmds='%s/%s.cmds' % (outdir, name))
    return r


def register_set(vic, bank):
    """Jedna sada registrů dělené obrazovky."""
    d018 = vic[0x18]
    return {
        'raster': vic[0x12],
        'd018': d018,
        'screenAddr': bank*0x4000 + ((d018 >> 4) & 0x0F)*0x0400,
        'charsetAddr': bank*0x4000 + ((d018 >> 1) & 0x07)*0x0800,
        'background0': vic[0x21] & 15, 'background1': vic[0x22] & 15,
        'background2': vic[0x23] & 15,
    }


def build_json(name, outdir='build/screen', irq=None):
    ram = open('%s/%s_ram.bin' % (outdir, name), 'rb').read()
    vic = open('%s/%s_vic.bin' % (outdir, name), 'rb').read()
    color = open('%s/%s_color.bin' % (outdir, name), 'rb').read()
    cia = open('%s/%s_cia.bin' % (outdir, name), 'rb').read()

    bank = 3 - (cia[0x100] & 3)      # ★ $DD00 (CIA2), ne $DC00 — dump začíná na $DC00
    d018 = vic[0x18]
    screen_addr = bank*0x4000 + ((d018 >> 4) & 0x0F)*0x0400
    charset_addr = bank*0x4000 + ((d018 >> 1) & 0x07)*0x0800
    d016, d011 = vic[0x16], vic[0x11]

    # ★ dělená obrazovka: dvě sady registrů, seřazené podle rastru
    vic2_path = '%s/%s_vic2.bin' % (outdir, name)
    sets = [register_set(vic, bank)]
    if os.path.exists(vic2_path):
        sets.append(register_set(open(vic2_path, 'rb').read(), bank))
    sets.sort(key=lambda x: x['raster'])
    # sada naměřená na rastru R platí pro pruh **pod** předchozím předělem
    splits = []
    for i, st in enumerate(sets):
        splits.append(dict(st, fromRaster=(sets[i-1]['raster'] if i else 0)))

    def slice_ram(addr, length):
        if addr + length > len(ram):
            raise SystemExit('adresa $%04X mimo dump RAM ($0000-$%04X)' % (addr, len(ram)-1))
        return list(ram[addr:addr+length])

    out = {
        'name': name,
        'source': 'paměť běžící hry, %s. přerušení obsluhy $82E8' % (irq if irq is not None else '?'),
        'bank': bank, 'screenAddr': screen_addr, 'charsetAddr': charset_addr,
        'multicolor': bool(d016 & 0x10), 'columns': 40 if (d016 & 0x08) else 38,
        'rows': 25 if (d011 & 0x08) else 24, 'displayOn': bool(d011 & 0x10),
        'scrollX': d016 & 7, 'scrollY': d011 & 7,
        'registers': {('$D0%02X' % i): vic[i] for i in range(0x2F)},
        'note': ('$D018 se čte s nepoužitým bitem 0 jako 1: zapsané $02/$06 '
                 'se přečte jako $03/$07 (disasm_notes §6)'),
        'colors': {'border': vic[0x20] & 15, 'background0': vic[0x21] & 15,
                   'background1': vic[0x22] & 15, 'background2': vic[0x23] & 15,
                   'background3': vic[0x24] & 15,
                   'spriteMulti0': vic[0x25] & 15, 'spriteMulti1': vic[0x26] & 15,
                   'sprites': [vic[0x27+i] & 15 for i in range(8)]},
        'splits': splits,
        'screen': slice_ram(screen_addr, 1000),
        'charsets': {('$%04X' % st['charsetAddr']): slice_ram(st['charsetAddr'], 2048)
                     for st in splits},
        'colorRAM': [b & 15 for b in color[:1000]],
        'sprites': {'enabled': vic[0x15], 'multicolor': vic[0x1C],
                    'expandX': vic[0x1D], 'expandY': vic[0x17],
                    'priority': vic[0x1B], 'msbX': vic[0x10],
                    'x': [vic[2*i] for i in range(8)], 'y': [vic[2*i+1] for i in range(8)],
                    'pointers': slice_ram(screen_addr + 0x03F8, 8)},
        'spriteBlocks': {('sprite%d' % i): slice_ram(bank*0x4000 + p*64, 64)
                         for i, p in enumerate(ram[screen_addr+0x03F8:screen_addr+0x0400])},
    }
    # ★ Poloha sprajtů o **půl snímku později**: dump paměti je z jednoho
    # zásahu obsluhy, snímek obrazovky z chvíle po tom dalším (§5, obsluha
    # běží dvakrát za snímek). Co se mezi nimi pohne — roboti, koule — by
    # jinak vypadalo jako rozdíl vykreslení. `matchscreen.mjs` proto zkouší
    # obě polohy a pixel počítá za rozdílný, jen když nesedí ani jedna.
    if os.path.exists(vic2_path):
        v2 = open(vic2_path, 'rb').read()
        out['spritesNext'] = {'msbX': v2[0x10],
                              'x': [v2[2*i] for i in range(8)],
                              'y': [v2[2*i+1] for i in range(8)]}
    return out


def title_json(disk):
    """Titulka staticky: zavaděč ji rozbalí na $C000-$CFFF a nastaví registry
    sám (viz disasm_notes §4), takže k ní není potřeba emulátor."""
    from unpack import build
    mem = build(disk, verbose=False, stop_after='title')
    return {
        'name': 'title',
        'source': 'rozbalený obraz hned po titulce (tools/unpack.py --stop-after title); registry z kódu zavaděče $B000-$B07D',
        'bank': 3, 'screenAddr': 0xC400, 'charsetAddr': 0xC800,
        'multicolor': True, 'columns': 40, 'rows': 25, 'displayOn': True,
        'scrollX': 0, 'scrollY': 3,
        'colors': {'border': 0, 'background0': 6, 'background1': 0x0F, 'background2': 0x0C,
                   'background3': 0, 'spriteMulti0': 0, 'spriteMulti1': 0,
                   'sprites': [0]*8},
        'screen': list(mem[0xC400:0xC400+1000]),
        'charset': list(mem[0xC800:0xC800+2048]),
        'colorRAM': [b & 15 for b in mem[0xC000:0xC000+1000]],
        'sprites': {'enabled': 0, 'multicolor': 0, 'expandX': 0, 'expandY': 0,
                    'priority': 0, 'msbX': 0, 'x': [0]*8, 'y': [0]*8,
                    'pointers': list(mem[0xC7F8:0xC800])},
    }


def main():
    global ARGS
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--image', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--irq', type=int, default=1000, help='kolikáté přerušení hry')
    ap.add_argument('--name', default='screen')
    ap.add_argument('--cycles', type=int, default=500_000_000)
    ap.add_argument('-o', default=None)
    ap.add_argument('--title', action='store_true',
                    help='titulka staticky z rozbaleného obrazu, bez emulátoru')
    ap.add_argument('--walk', type=int, default=0, metavar='SNÍMKŮ',
                    help='po --irq snímcích jít doprava, dokud agent nevejde do místnosti')
    ap.add_argument('--idle', type=int, default=0, metavar='SNÍMKŮ',
                    help='po --walk pustit páčku, ať agent stojí')
    ap.add_argument('--entropy', metavar='HEX',
                    help='pevná entropie místo rastru ($82E3) — pevnost je pak pokaždé táž')
    ARGS = ap.parse_args()

    if ARGS.title:
        data = title_json(ARGS.image)
        out = ARGS.o or 'data/title.json'
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        json.dump(data, open(out, 'w'), indent=1)
        open(out, 'a').write('\n')
        print('%s: banka 3, obrazovka $C400, sada $C800, multicolor' % out)
        return

    r = capture(ARGS.image, ARGS.irq, ARGS.name, ARGS.cycles, walk=ARGS.walk,
                idle=ARGS.idle, entropy=int(ARGS.entropy, 16) if ARGS.entropy else None)
    print('zastaveno na $838C: %s' % r.hit(), file=sys.stderr)
    if not r.hit():
        sys.exit('emulátor se nezastavil — víc cyklů, nebo menší --irq')
    data = build_json(ARGS.name, irq=ARGS.irq)
    out = ARGS.o or 'data/%s.json' % ARGS.name
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    json.dump(data, open(out, 'w'), indent=1)
    open(out, 'a').write('\n')
    print('%s: banka %d, obrazovka $%04X, sada $%04X, multicolor %s, %d sprajtů'
          % (out, data['bank'], data['screenAddr'], data['charsetAddr'],
             data['multicolor'], bin(data['sprites']['enabled']).count('1')))


if __name__ == '__main__':
    main()
