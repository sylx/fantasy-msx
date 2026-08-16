# Fantasy MSX

A fantasy console with real MSX2 hardware inside, programmed in TypeScript.

PICO-8 and Pyxel invent their constraints. This one inherits them: the display is
an actual V9938 emulation, the sound is an actual AY-3-8910 and YM2413. What is
replaced is the Z80 - your game logic is TypeScript sitting in the CPU's seat.

The chip emulators come from [WebMSX](https://github.com/ppeccin/WebMSX) by Paulo
Augusto Peccin, vendored under `src/core/vendor/`.

## How it works

In a real MSX - and in WebMSX - the VDP is the master clock. It walks 262
scanlines per frame and hands the CPU a few dozen cycles between each raster
event. We keep that structure intact and remove only the CPU:

```
VDP.videoClockPulse()          one frame = 262 scanlines
  -> lineEvents() x262
       cpuBusClockPulses(33)   -> a cycle counter, nothing executes
       audioClockPulse32()     -> PSG / OPLL sample generation
       renderLine()            -> pixels into the framebuffer
```

The cycle counter is not decorative: the V9938 command engine finishes a blit
when the elapsed VDP cycles pass the command's computed duration, so `HMMV`,
`LMMM` and `LINE` take the same time they take on hardware.

User code runs once per frame, before that frame's scanlines are rendered - the
same position an MSX program's VBlank handler occupies.

## Layers

| Layer | What it is | Status |
|-------|-----------|--------|
| host  | canvas blit, AudioWorklet, frame clock | M0 partial |
| L0 core | VDP, PSG, OPLL (vendored from WebMSX) | M0 done |
| L1 API | typed register/VRAM/port access | M2 done |
| L2 BIOS | drawing and BGM libraries | M3 / M4 |
| app | `init` / `update` / `draw` | M5 |

L2 drawing is built on the VDP's command engine rather than a software
rasteriser. That is the thing this console has that other fantasy consoles do not.

## Using the low-level API

```ts
import { createSystem, OP } from "./src/api/index.js";

const { vdp, psg, machine } = createSystem();

vdp.setMode("G4", 0);               // SCREEN 5: 256x212, 16 colours
vdp.setDisplayEnabled(true);
vdp.setPaletteEntry(15, 7, 4, 0);   // 3 bits per component, 512 colours to pick from

vdp.cmd.fill(16, 16, 64, 32, 15);   // the V9938 blitter, not a loop over pixels
vdp.cmd.lineTo(0, 0, 255, 211, 15, OP.XOR);

psg.setTone(0, 440);
psg.setVolume(0, 12);
psg.setMixer([true, false, false]);

machine.frame();                    // 262 scanlines, and everything above happens in them
```

Blits are not instant. `vdp.cmd.busy` stays true until the chip has worked
through the command, and a full-screen `fill` takes about 17 frames where the
byte-wise `fillBytes` takes 3 - the same trade a real V9938 imposes.

Registers stay reachable at all times: `vdp.write(9, 0x80)` and
`vdp.cmd.execute(...)` do exactly what a Z80 `OUT` would.

## Machine profile

Fixed, and not configurable: **MSX2, V9938, NTSC 60Hz, 128KB VRAM**.

## Development

```bash
git submodule update --init      # fetch WebMSX
npm install
npm run vendor                   # re-copy the WebMSX core (only after a submodule bump)
npm test
npx vite-node tools/screenshot.ts out.png
```

`src/core/vendor/` is generated. Edit `scripts/vendor.sh`, never the files it
writes - the copies are verbatim so upstream changes stay reviewable as a diff.

## License

The vendored WebMSX sources carry `Copyright 2015 by Paulo Augusto Peccin` and
refer to a `license.txt` that is **not present in the WebMSX repository**. The
terms of reuse are therefore unconfirmed, and must be settled with the author
before this project is distributed.
