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
| host  | canvas blit, keyboard, gamepads, 60Hz clock | M5 done |
| L0 core | VDP, PSG, OPLL (vendored from WebMSX) | M0 done |
| L1 API | typed register/VRAM/port access | M2 done |
| L2 BIOS | drawing and sprites | M3 done |
| L2 BIOS | BGM library | M4 |
| app | `init` / `update` / `draw` | M5 done |

### Drawing takes time, and you can see it

A real V9938 does not fill a screen between two frames. It grinds through the
rectangle while the raster keeps sweeping, so you watch the fill arrive. That
is half the character of the machine, and this console keeps it.

WebMSX's own command engine writes the whole result the instant a command is
issued and then merely holds its busy flag up - the slowness is real but
invisible. So `gfx` runs its own blitter instead: calls queue jobs, and the
queue is advanced from the CPU's time slices, about ten per scanline. Costs
per pixel are measured against the emulated chip and land close to the V9938's
published figures.

| what you draw | how long it takes |
|---------------|------------------|
| `fillRect` over the whole screen, even coordinates | 3 frames, 50ms |
| `fillRect` over the whole screen, odd coordinates | 17 frames, 283ms |
| `fillCircle` radius 100 | 10 frames, 167ms |
| `fillCircle` radius 36 | 2 frames |
| `fillCircle` radius 12, a line of text, a circle outline | 1 frame |

Even coordinates cost an eighth of odd ones, because the chip can move whole
bytes instead of reading, masking and writing each pixel. It is worth
arranging your rectangles to land on them.

Note the bottom of that table. Anything under about a quarter of the screen
finishes inside a single frame, and since `draw` queues before the frame runs,
it is complete before it is ever shown - true to the hardware, but it hides the
hardware working. Draw big if you want the machine's pace to read, or turn
`gfx.speed` down: it multiplies the chip's rate, 1 being authentic. That knob
is the one thing here that is not the V9938.

Jobs run in the order they were queued, and each one pins the page and clip it
was queued with, so a later page flip cannot make an unfinished fill paint over
the wrong buffer.

When something must land before the next frame - a HUD, a menu, the boot
screen - `gfx.now` is the same set of primitives written straight into VRAM at
no cost. It is the exception, not the default.

Three clocks, then, and they do not fight:

| | rate | cost |
|---|------|------|
| game logic | every frame | free |
| sprite movement | every frame | free, the VDP composites per scanline |
| blitter jobs | **spread across frames** | hardware speed |

Which is why the framebuffer is persistent state here rather than something
cleared every frame. Moving objects belong in the 32 hardware sprites.

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

## Using the BIOS

```ts
import { createBios } from "./src/bios/index.js";

const { screen, gfx, sprites } = createBios();   // SCREEN 5, sprites enabled

screen.useDoubleBuffer();                        // draw on page 1, show page 0

gfx.now.clear(1);                                // instant: the boot screen
gfx.fillCircle(128, 106, 40, 10);                // queued: arrives over a few frames
gfx.rect(8, 8, 240, 196, 15);
gfx.text(12, 12, "HELLO", 15);
// gfx.busy / gfx.pending / gfx.work report what is still owed

sprites.setPatternFromBitmap(0, [
    "..####..",
    ".######.",
    "########",
    "########",
    "########",
    "########",
    ".######.",
    "..####.."
]);
sprites.set(0, { x: 100, y: 60, pattern: 0, color: [15, 15, 11, 11, 9, 9, 6, 6] });
sprites.setActiveCount(1);

screen.flip();
screen.frame();
```

Sprite colours may be given per line, which is a V9938 feature with no
equivalent on an MSX1: one sprite, shaded, instead of two stacked.


## Writing a game

```bash
npm run dev
```

```ts
import { BUTTON, run, type Context } from "./src/index.js";

run({
    init({ screen, gfx, sprites }: Context) {
        gfx.now.clear(1);                       // the boot screen cannot wait
        sprites.setPatternFromBitmap(0, [...]);
        sprites.setActiveCount(1);
    },

    update({ input, sprites }: Context) {
        const { x, y } = input.axis();          // arrows, WASD, or a gamepad
        sprites.move(0, ship.x += x * 3, ship.y += y * 3);
    },

    draw({ gfx }: Context) {
        gfx.fillCircle(120, 100, 30, 8);        // queued: arrives over a few frames
        gfx.now.text(2, 1, `QUEUE ${gfx.pending}`, 15);
    }
}, { canvas: document.querySelector("canvas") });
```

`draw` does not repaint the screen. It adds to the blitter's queue, which is
still working through what earlier frames asked for. Nothing drops work, so a
game that queues faster than the chip draws will fall behind - watch
`gfx.pending` and hold off, the way the example does.

The runtime steps at a fixed 60Hz whatever the display refreshes at, and will
run up to three frames to catch up before it gives up on the lost time.

`examples/game.ts` is the whole thing: a sprite moving at 60Hz for free, blooms
big enough that the blitter visibly grinds them out, a full-screen wipe on odd
coordinates that takes most of a third of a second, and a readout drawn
immediately so it never lags behind what it is reporting.

## Machine profile

Fixed, and not configurable: **MSX2, V9938, NTSC 60Hz, 128KB VRAM**.

## Development

```bash
git submodule update --init      # fetch WebMSX
npm install
npm run vendor                   # re-copy the WebMSX core (only after a submodule bump)
npm test
npm run dev                      # the example, in a browser
npm run demo -- out.png          # four frames of the blitter working, tiled
npm run play -- out.png          # the example, headless, with scripted input
```

`src/core/vendor/` is generated. Edit `scripts/vendor.sh`, never the files it
writes - the copies are verbatim so upstream changes stay reviewable as a diff.

## License

The vendored WebMSX sources carry `Copyright 2015 by Paulo Augusto Peccin` and
refer to a `license.txt` that is **not present in the WebMSX repository**. The
terms of reuse are therefore unconfirmed, and must be settled with the author
before this project is distributed.
