#!/usr/bin/env python3
"""scanhw — statický průzkum bajtů: která místa programu sahají na hardware.

Obdoba toho, co u Boulder Dashe udělal `sources/diskette/README.md` („žádné
čtení PAL, 14× RANDOM, HSCROL i VSCROL…"). Projde obraz paměti lineárně
a najde instrukce s absolutní adresou v I/O oblasti $D000-$DFFF a přístupy
na zeropage $00/$01 (přepínání ROM). **Je to heuristika** — data, která
vypadají jako kód, dají falešné nálezy; autorita je až disassembly z běhu
(`dis6502.py` + pokrytí). Slouží k tomu, aby M0 věděla, co hledat.

    ./tools/scanhw.py                     # clean obraz, všechny soubory
    ./tools/scanhw.py --pc                # vypsat i adresy instrukcí
"""
import argparse, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imlib import D64, program_image
from unpack import build

# opcode -> (jméno, délka, režim)  jen to, co sahá na absolutní adresu
ABS = {0xAD:'LDA',0x8D:'STA',0xAE:'LDX',0x8E:'STX',0xAC:'LDY',0x8C:'STY',
       0xEE:'INC',0xCE:'DEC',0x0D:'ORA',0x2D:'AND',0x4D:'EOR',0x6D:'ADC',
       0xED:'SBC',0xCD:'CMP',0xEC:'CPX',0xCC:'CPY',0x2C:'BIT',0x0E:'ASL',
       0x4E:'LSR',0x2E:'ROL',0x6E:'ROR',0x4C:'JMP',0x20:'JSR'}
ABSX = {0xBD:'LDA',0x9D:'STA',0xBC:'LDY',0xFE:'INC',0xDE:'DEC',0x1D:'ORA',
        0x3D:'AND',0x5D:'EOR',0x7D:'ADC',0xFD:'SBC',0xDD:'CMP',0x1E:'ASL',
        0x5E:'LSR',0x3E:'ROL',0x7E:'ROR'}
ABSY = {0xB9:'LDA',0x99:'STA',0xBE:'LDX',0x19:'ORA',0x39:'AND',0x59:'EOR',
        0x79:'ADC',0xF9:'SBC',0xD9:'CMP'}
ZP   = {0xA5:'LDA',0x85:'STA',0xA6:'LDX',0x86:'STX',0xA4:'LDY',0x84:'STY',
        0xE6:'INC',0xC6:'DEC',0x05:'ORA',0x25:'AND',0x45:'EOR',0x65:'ADC',
        0xE5:'SBC',0xC5:'CMP',0x24:'BIT',0x06:'ASL',0x46:'LSR',0x26:'ROL',0x66:'ROR'}

def chip(a):
    if 0xD000 <= a <= 0xD02E: return 'VIC'
    if 0xD400 <= a <= 0xD41C: return 'SID'
    if 0xD800 <= a <= 0xDBFF: return 'ColorRAM'
    if 0xDC00 <= a <= 0xDC0F: return 'CIA1'
    if 0xDD00 <= a <= 0xDD0F: return 'CIA2'
    if 0xD000 <= a <= 0xDFFF: return 'I/O jinde'
    return None

VIC = {0xD000:'sprajt 0 X',0xD001:'sprajt 0 Y',0xD010:'X bit 8',0xD011:'řízení 1 (rastr, režim)',
       0xD012:'rastr',0xD015:'sprajty zapnuté',0xD016:'řízení 2 (multicolor, scroll X)',
       0xD017:'zdvojení Y',0xD018:'paměť (sada, screen)',0xD019:'přerušení',0xD01A:'maska přerušení',
       0xD01B:'priorita sprajt-pozadí',0xD01C:'multicolor sprajtů',0xD01D:'zdvojení X',
       0xD01E:'kolize sprajt-sprajt',0xD01F:'kolize sprajt-pozadí',0xD020:'rámeček',0xD021:'pozadí 0',
       0xD022:'pozadí 1',0xD023:'pozadí 2',0xD024:'pozadí 3',0xD025:'multicolor 0',0xD026:'multicolor 1'}
SID = {0xD418:'hlasitost a filtr (**vzorky řeči**)',0xD41B:'oscilátor 3 (náhoda)',0xD41C:'obálka 3'}
CIA = {0xDC00:'port A (joystick 2)',0xDC01:'port B (joystick 1, klávesnice)',0xDC04:'časovač A lo',
       0xDC05:'časovač A hi',0xDC06:'časovač B lo',0xDC0D:'přerušení',0xDD00:'VIC banka',0xDD0D:'přerušení NMI'}

def label(a):
    if a in VIC: return VIC[a]
    if a in SID: return SID[a]
    if a in CIA: return CIA[a]
    if 0xD400 <= a <= 0xD416: return 'hlas %d, registr %d' % (1 + (a-0xD400)//7, (a-0xD400) % 7)
    if 0xD000 <= a <= 0xD00F: return 'sprajt %d %s' % ((a-0xD000)//2, 'YX'[(a & 1) ^ 1])
    return ''

def scan(mem, spans, want_pc=False):
    hits = {}
    ranges = [(lo, hi) for _, lo, hi in spans]
    for lo, hi in ranges:
        pc = lo
        while pc <= hi-2:
            op = mem[pc]
            if op in ABS or op in ABSX or op in ABSY:
                a = mem[pc+1] | mem[pc+2] << 8
                c = chip(a)
                if c:
                    name = (ABS.get(op) or ABSX.get(op) or ABSY.get(op))
                    idx = ',X' if op in ABSX else ',Y' if op in ABSY else ''
                    hits.setdefault((c, a), []).append((pc, name+idx))
                pc += 3
                continue
            if op in ZP and mem[pc+1] in (0x00, 0x01):
                hits.setdefault(('banking', mem[pc+1]), []).append((pc, ZP[op]+' zp'))
                pc += 2
                continue
            pc += 1
    return hits

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('image', nargs='?', default='sources/disk/impossible_mission_clean.d64')
    ap.add_argument('--pc', action='store_true', help='vypsat adresy instrukcí')
    ap.add_argument('--naive', action='store_true', help='skenovat naivní nahrání (ukáže, proč nestačí)')
    a = ap.parse_args()
    # ★ POZOR: `program_image` je jen naivní nahrání souborů, a to u téhle
    # hry **není** obraz programu — zavaděč data rozbaluje (disasm_notes §4).
    # Průzkum nad ním hlásil nesmysly (žádná čtení $DC04), proto se skenuje
    # rozbalený obraz.
    mem = bytearray(build(a.image, verbose=False))
    spans = [('rozbalený program', 0x0880, 0xCFFF), ('řeč', 0xE000, 0xF77F)]
    if a.naive:
        mem, spans = program_image(D64(a.image))
    print('obraz: %s%s' % (a.image, ' (naivní nahrání)' if a.naive else ' → rozbaleno tools/unpack.py'))
    for n, lo, hi in spans:
        print('  %-18s $%04X-$%04X  %6d B' % (n, lo, hi, hi-lo+1))
    print('\n(heuristika — data, která vypadají jako kód, dávají falešné nálezy)\n')
    hits = scan(mem, spans, a.pc)
    for c in ('VIC', 'SID', 'CIA1', 'CIA2', 'ColorRAM', 'I/O jinde', 'banking'):
        rows = sorted((k, v) for k, v in hits.items() if k[0] == c)
        if not rows: continue
        total = sum(len(v) for _, v in rows)
        print('%s — %d míst na %d adresách' % (c, total, len(rows)))
        for (_, addr), lst in rows:
            name = label(addr) if c != 'banking' else ('$01 přepínání ROM' if addr == 1 else '$00 směr portu')
            ops = sorted({o for _, o in lst})
            print('   $%04X  %3d×  %-28s %s' % (addr, len(lst), name, ' '.join(ops)))
            if a.pc:
                print('          ' + ' '.join('$%04X' % pc for pc, _ in lst[:24]) + (' …' if len(lst) > 24 else ''))
        print()

if __name__ == '__main__':
    main()
