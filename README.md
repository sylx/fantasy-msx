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
| host  | canvas blit, keyboard, gamepads, audio, file drops, 60Hz clock | done |
| L0 core | VDP, PSG, OPLL (vendored from WebMSX) | done |
| L1 API | typed register/VRAM/port access | done |
| L2 BIOS | drawing and sprites | done |
| L2 BIOS | music: MML and a frame-driven driver | done |
| L2 BIOS | images: a URL in, VRAM out, reduced to the mode | done |
| L2 BIOS | text: the host's fonts, rasterised outside and carried in | done |
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

## Loading a picture

A V9938 has no idea what a PNG is. What it has is a framebuffer of indices -
four bits of them in SCREEN 5 and 7, two in SCREEN 6, and in SCREEN 8 a byte
that *is* the colour: three bits of green, three of red, two of blue. So all
the work between a URL and VRAM is a reduction, and the mode decides how
severe it is.

```ts
const { screen, image } = createBios();

await image.show("title.png");                   // fetch, reduce, centre, show
```

That is the whole of it for a backdrop. The longer form separates the steps,
which is what you want when the picture deserves its own palette:

```ts
screen.setMode("G4");

// A palette chosen for this picture, keeping entry 0 for transparency.
screen.setPalette(await image.loadPalette("sprites.png", { reserve: 1 }));

const art = await image.load("sprites.png", { dither: "ordered", exclude: [0] });
image.draw(art, 40, 24, { transparent: true });  // queued, like any other drawing
image.drawNow(art, 40, 24);                      // or straight into VRAM
```

**The palette is an input, not an output.** Loading a picture never repaints
the sixteen registers underneath everything already on screen: it reduces to
the colours the VDP is showing. `image.palette()` is the separate step that
picks new ones - a 5-bit histogram, median cut for the first guess, then a few
rounds of k-means to pull each entry onto the middle of what actually chose it.
It hands back all sixteen entries with the reserved ones untouched, so
`setPalette` disturbs nothing you meant to keep.

Two of everything, then: `load` and `loadPalette` take a URL and are async,
`reduce` and `palette` take pixels you already have and are not. `image.decode`
is the half in between - fetch a picture and stop there, at full colour, which
is what you want when the same picture has to be reduced more than once.

Three ways to fake the colours a mode does not have:

| `dither` | what it looks like |
|----------|--------------------|
| `none` | nearest colour, and the banding that comes with it |
| `ordered` | a 4x4 Bayer crosshatch: fixed, so it holds still when the picture moves |
| `floyd-steinberg` | error pushed into the neighbours - more detail, and a grain that crawls if the source is animated (the default) |

Sizing follows the mode too. Art that already fits is left at the size it was
drawn; anything bigger is fitted to the screen, averaging the pixels it drops
rather than picking one of them. In the 512-wide modes the pixels are half as
wide as they are tall, and `fit` does that arithmetic for you - a square
picture comes out square, at twice the pixel count across.

In the browser the decoding is the browser's own, so any format it can display
works, `data:` URLs included. Outside one, hand `image.decoder` something that
turns a URL into RGBA; `tools/png.ts` exports `nodeDecoder()` for exactly that.

## Text in a real typeface

`gfx.text` draws the machine's own 6x8 font - five pixels wide, seven rows, the
shapes an MSX had in ROM. `text` is the other kind: a real typeface, laid out
and rasterised by the browser on a canvas the machine never sees, then carried
into VRAM one byte per pixel like any other picture.

```ts
const { text, gfx } = createBios();

text.style = { font: "'Georgia', serif", size: 20 };   // chosen once

text.drawNow(12, 12, "CHAPTER ONE", { color: 15 });    // straight into VRAM
text.draw(12, 40, "and what\nbecame of it", {          // queued, like any drawing
    color: 10, align: "center", lineHeight: 22
});

const box = text.measure("CHAPTER ONE");               // width, height, baseline, lines
```

A face the page does not already have is fetched first, and one still loading
rasterises as the fallback - silently, and at the fallback's metrics - so an
`await` in `init` is worth it:

```ts
await text.load("Press Start 2P", "fonts/press-start.woff2");
text.style = { font: "'Press Start 2P', monospace", size: 8 };
await text.ready();                                    // faces named in CSS, too
```

What crosses the boundary is **coverage**: how much of each pixel the glyphs
cover, 0 to 255. The machine has no such quantity - a pixel is an index into
sixteen registers and nothing in between - so the coverage has to be spent on
indices that already exist, and `shades` is where you say which:

```ts
screen.setColor(8, 3, 3, 3);                           // a grey between the two

text.drawNow(12, 12, "CHAPTER ONE", { shades: [8, 15] });   // one soft step
text.drawNow(12, 40, "and what became of it", { color: 15 });  // a hard edge
```

The ramp runs palest to fullest, and the coverage is divided into as many bands
as it is long plus one: the bottom band is the background and the rest take the
ramp in order. A ramp of one is exactly a threshold - which is what `color` is -
so the antialiased path and the hard-edged one are the same arithmetic, and
`threshold` (128 by default) slides a ramp of any length towards the ink or
away from it. Lower it to fatten every stroke; raise it to thin them.

**The palette is an input, as it is for pictures.** Nothing here picks a
colour, searches for a near one, or repaints a register: every entry of the
ramp is one you set, and one the type has taken off whatever else is on screen.
Three shades is usually the most a sixteen-colour mode can afford, and small
text should stay at one - at ten pixels an em there is no flank to resolve,
only a blur where the stem was. `background` is the index behind the glyphs,
and leaving it out makes the box transparent so only the glyphs land.

The 512-wide modes are handled for you. A SCREEN 6 or 7 pixel is half as wide
as it is tall, so a line set the way SCREEN 5 sets it would come out condensed
to half its width; `text` draws the em twice as wide instead, and the same
style gives type of the same shape with twice the detail across it. `stretch`
overrides that - 1 to work in the mode's own pixels, anything else to condense
or extend deliberately.

Rendering is the expensive half, so the last hundred or so results are kept:
a caption redrawn every frame costs one layout and then nothing. `text.forget()`
drops them, which is what a late-arriving font needs (`load` and `ready` do it
for you).

In the browser the layout is the browser's own, so any font the page can see
works. Outside one there is nothing to ask, and `text.rasteriser` is the seam:
give it a function from a string to coverage and everything above it works
unchanged.

## Files dropped on the screen

The screen is a drop target. A file dropped on it reaches the app as a URL,
which is the same thing `image.load` takes, so a picture from the desktop takes
the path a bundled one takes:

```ts
run({
    update(ctx) { ... },
    async drop({ image }, files) {
        picture = await image.load(files[0].url);
    }
}, { canvas });
```

`files[0]` also carries `name`, `type`, `size`, and `bytes()` / `text()` for
anything that is not a picture. The URL is an object URL the host owns: it is
readable until your handler settles, and released the moment it does - which is
why `drop` may return a promise and why the one above awaits rather than
leaving the load running.

The host swallows drops that miss the screen too, since the browser's own
answer to a dropped file is to navigate away from the page and take whatever
was running with it. While a file is over the screen the canvas carries
`data-drop="over"`, for a page that wants to say so. Pass `drop: false` to
`BrowserHost` to have none of it.


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

### TONE

The picture-loading path, run through every bitmap mode the chip has.
**Left** and **right** switch between them, and the same source lands in each:

| | | |
|---|---|---|
| SCREEN 5 | 256x212, 16 of 512 | the workhorse |
| SCREEN 6 | 512x212, 4 of 512 | twice the pixels, a quarter of the palette |
| SCREEN 7 | 512x212, 16 of 512 | both, and half of VRAM gone |
| SCREEN 8 | 256x212, 256 fixed | no palette at all: GRB 3-3-2 |

Fetched and decoded once. Everything after that is `image.reduce` against the
palette in the registers, which is why a mode change is a job for one frame
rather than another round trip. **Up** and **down** change the dither, and
**Z** switches between a palette chosen for the picture and the sixteen the
machine boots with - the pair that shows what the palette registers are worth:
the stock colours have nothing near a dusk sky, and it comes out red.

Two entries are held back for the readout in the sixteen-colour modes, so the
picture gets fourteen. SCREEN 6 has four colours and cannot spare two, so there
the readout takes the darkest and brightest of whatever the picture chose.

**Drop an image on the screen** and it joins the two the demo ships with: the
same reduction, on a picture the demo has never seen.

**X** switches to a colour chart generated in the demo rather than fetched -
the same reduction, on pixels that never went near a URL. It is the clearest
look at what each mode can reach: SCREEN 8 holds the hue field nearly whole
where SCREEN 5 breaks it into sixteen bands.

The picture arrives through the blitter rather than being written, so you watch
it land at the rate the chip pushes pixels in from outside - about 120 VDP
cycles a pixel, which is a dozen frames for a SCREEN 5 screenful and nearer
thirty for SCREEN 7. The bar along the bottom is `gfx.work` draining.

### TYPE

A specimen sheet, set in the host's fonts. The machine's own font is five
pixels wide inside an 8x8 cell and stops at ASCII 126; this sets the same words
in the browser's, rasterised outside the machine and carried in a byte a pixel.
The strip near the bottom is the ROM font saying the same thing - and on the
Japanese specimen it says `??????????`, because those glyphs were never in it.

**Up** and **down** walk the ramp, which is the knob worth playing with: a
solid edge, then two, three and four shades. What arrives from the host is
coverage - how much of each pixel the glyphs cover - and the machine has no
such quantity, so it is spent on palette entries the demo set aside for it. The
swatches in the readout are those registers, which is the honest way to price
the smoothing: it comes out of the sixteen colours everything else on screen is
drawing from. A specimen sheet can afford three; a game with artwork usually
cannot.

**Z** switches between SCREEN 5 and SCREEN 7 - the same sheet, and twice the
pixels across it. It is the one thing this machine can do for small type that
no ramp can, and the strip at the foot of the page shows the other side of the
bargain: the ROM font in SCREEN 7 is the same 6x8 cell over half-width pixels,
so it comes out condensed exactly as an MSX's own SCREEN 7 text did.

**Left** and **right** change the face - the CSS generic families rather than
anything fetched, with a bold and an italic among them, so whatever the machine
running the page calls its serif is what gets set. **X** changes the specimen.

Both sizes on the sheet are fitted to the measure with `text.measure` before
anything is drawn, and the body is wrapped on the same measurements the
rasteriser will use. The display line is queued rather than written, so you
watch it lay down; everything under it is `drawNow`, since a specimen sheet
that arrived in instalments would be unreadable while it did.

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
