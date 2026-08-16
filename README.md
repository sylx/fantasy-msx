# Fantasy MSX

A fantasy console with real MSX2 hardware inside, programmed in TypeScript.

PICO-8 and Pyxel invent their constraints. This one inherits them: the display is
an actual V9938 emulation, the sound is an actual AY-3-8910 and YM2413. What is
replaced is the Z80 - your game logic is TypeScript sitting in the CPU's seat.

The chip emulators come from [WebMSX](https://github.com/ppeccin/WebMSX) by Paulo
Augusto Peccin, vendored under `src/core/vendor/`.

## Demo

https://sylx.github.io/fantasy-msx/

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
| host  | canvas blit, keyboard, gamepads, audio, 60Hz clock | done |
| L0 core | VDP, PSG, OPLL (vendored from WebMSX) | done |
| L1 API | typed register/VRAM/port access | done |
| L2 BIOS | drawing and sprites | done |
| L2 BIOS | music: MML and a frame-driven driver | done |
| app | `init` / `update` / `draw` | done |

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


## Examples

```bash
npm run dev
```

The page is a launcher: each example gets a machine of its own, and the one on
screen is in the URL fragment. `examples/registry.ts` is the list.

### INK

A game, because the machine's oddities only make sense once something is built
out of them.

You fly a ship and throw paint. A shot leaves in the direction you are flying,
carries about ninety pixels, and bursts where it lands into a splat laid down as
a gradient - five discs of the ink ramp, outside in, from a dark red edge to a
pale yellow core. Painted ground kills the drifters, but a splat arrives over
several frames, so you shoot at where a drifter is *going* and it has to be in
flight before that. The drifters scrub the ground they cross. The framebuffer is
not a picture of the game - it *is* the game state, read back with
`gfx.getPixel`. The ink gauge in the status bar is `gfx.work`: the blitter's
backlog, doubling as your reload, and a gradient splat costs it a little over
twice a flat one.

Every actor is a hardware sprite, shots included, so none of them cost anything.
The music is MML on the PSG and OPLL, and firing borrows a PSG channel for the
shot and its burst.

### WIRE

A demo, showing the machine at its widest. SCREEN 7 is 512x212 in 16 colours out
of 512, with two 64KB pages to flip between. An icosahedron, a ground plane and
thirty edges are redrawn whole every frame, on the page that is not being shown.

Nothing here is a sprite. **X** hands the same picture to the V9938's blitter
instead of drawing it in software, which is the comparison worth having: a
whole SCREEN 7 page cleared and thirty 512-pixel edges pulled across it takes
the chip about twelve frames, so sixty pictures a second becomes five.

Either way it draws on the page nobody is looking at and swaps the finished one
in, which is what the second page is for and what MSX programs did with it. The
blitter does not show you a half-drawn picture; it shows you a picture five
times a second. Four FM voices hold the chords over a PSG bass.

Its pixels are not square. The V9938 paints the same picture width whatever the
mode, so SCREEN 6 and 7 get their 512 columns by halving the pixel rather than
widening the screen - `screen.pixelAspect` is 0.5 there and 1 everywhere else.
Hosts scale by the picture's true width, so both modes fill the same space and
neither comes out stretched; anything doing its own geometry has to divide by
it, which is why WIRE projects through `1 / screen.pixelAspect`.

### HAZE

The other end of the machine. SCREEN 3 is the mode nobody used: 64x48 blocks of
4x4 pixels, sixteen colours, no diagonals. What it has instead is smallness -
the whole picture is 2048 bytes, so every block of it is recomputed and
rewritten every frame, which is roughly what a Z80 could have managed too.

Nothing here is queued, and `gfx` never appears: it draws into the bitmap
modes' nibble-per-pixel framebuffer, and SCREEN 3 has not got one. Its pixels
live in a pattern generator table, four blocks to the byte, in the order the
VDP fetches them rather than the order they appear.

Five patterns take turns, and around them are the three things a mode this
coarse is good at. The palette rotates under the picture, which moves it
without touching a byte. R23 scrolls the display by scanlines rather than
blocks, so the field is 64 rows tall, 48 of them on screen, and it slides a
quarter of a block at a time for free. And the palette flashes on the beat
without being told where the beat is: a quarter note at tempo 150 is exactly 24
frames, because the driver resolves tempo to whole frames.

The readout is four hardware sprites, which in this mode is not a layout choice
- SCREEN 3 gets MSX1 sprites, four to a line and the fifth dropped, so eight
characters is the whole width of text the chip will show. It has no colours of
its own either: each frame it asks the palette which entry is currently the
darkest, lays its bar in that, and writes on it in the brightest.

```bash
npm run play -- out.png     # INK, headless, with a scripted controller
npm run wire -- out.png     # WIRE, four frames of it
npm run haze -- out.png     # HAZE, one frame of each of its five patterns
```

## Writing a game

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

## Sound

Both chips are wired and clocked from the same scanline events the VDP hands
out, so audio advances with the picture rather than alongside it.

```ts
const { psg, opll } = createSystem();

psg.setTone(0, 440);                    // Hz, converted to the chip's period
psg.setVolume(0, 13);
psg.setMixer([true, false, false]);     // tone on channel A only

opll.play(0, 220, INSTRUMENT.ORGAN);    // instrument, pitch and key-on at once
opll.setRhythmMode(true);
opll.triggerRhythm(RHYTHM.BASS_DRUM | RHYTHM.HI_HAT);
```

The PSG generates at 112005 Hz and the OPLL at 49780, neither of which any
sound card wants, so `AudioMixer` pulls a frame from each, resamples by
averaging - picking one sample of two would alias the PSG's squares badly - and
sums them. In a browser `BrowserHost` opens an AudioWorklet and feeds it a
frame at a time; the worklet is only a sink, since the emulator has to stay on
the main thread.

The mixer also strips DC. A PSG channel with its mixer bit off still drives its
amplitude out as a steady level - that is how the chip was made to play
samples - and on a real MSX the capacitor on the output removes it.

```bash
npm run sound -- out.wav        # both chips put through their paces
```

### Music

Tunes are written in MML, the notation MSX BASIC's `PLAY` used, and driven the
way an MSX music driver was: once per frame, on the vertical interrupt, writing
whatever registers changed. Nothing is scheduled ahead.

```ts
const theme = compile([
    { voice: psgVoice(0), mml: "t150 v12 q7 l8 o5 [eagaece4 fagafcf4]2" },
    { voice: psgVoice(1), mml: "t150 v10 q6 l4 o2 [aaaa ffff]2" },
    { voice: opllVoice(0), mml: "t150 @8 v11 l1 o3 [af]2" },
    { voice: rhythmVoice(), mml: "t150 v11 l8 [{cg}g{dg}g]4" }
]);

bgm.play(theme, { loop: true });
bgm.effect(psgVoice(2), "t150 v15 l32 o6 >c< bagfedc");   // borrows a channel
```

`cdefgab` with `+`/`#`/`-`, `r` rests, `o` `<` `>` octaves, `l` default length
and dots, `t` tempo, `v` volume, `q` gate in eighths, `@` instrument, `s`/`m`
the PSG envelope, `w` noise, `&` ties, `[ ... ]n` repeats. Rhythm tracks spell
drums as letters - c kick, d snare, e tom, f cymbal, g hi-hat - and brace the
ones that land together: `{cg}8`.

There are no spare channels on an MSX, so `bgm.effect` takes one away from the
music and gives it back when the effect ends, which is what games did.

Note lengths rarely fall on whole frames - an eighth at tempo 150 is 12.8 of
them - so the compiler rounds the running total rather than each note. Tracks
written in different subdivisions still come out exactly the same length, and a
loop stays a loop.

```bash
npm run music -- out.wav        # eight bars, five voices
```

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

## Deploying

`npm run build` writes a self-contained `dist/` with relative asset paths, so it
works from any subpath. `.github/workflows/pages.yml` builds it on every push to
`main` - typecheck, tests, then build - and publishes to GitHub Pages. The
WebMSX submodule is not checked out there: its core is vendored into the repo,
and the submodule only exists so `npm run vendor` can refresh it.

The workflow turns Pages on itself, through `enablement: true` on
`configure-pages`. Without that the first run fails with `Get Pages site
failed`, because the repository has no Pages site yet and the action will not
create one by default.

Pages on a private repository needs a paid plan; on a free one the repository
has to be public.

## Credit and licensing

The chip emulation is WebMSX by **Paulo Augusto Peccin**, vendored under
`src/core/vendor/` and copied verbatim so its provenance stays visible in the
diff. Every file keeps its original copyright header.

Those headers refer to a `license.txt` that is not present in the WebMSX
repository, so the terms of reuse are unconfirmed. This is fine for something
shared privately, which is what this is. Anyone thinking of putting it in front
of a wider audience should settle the terms with the author first.
