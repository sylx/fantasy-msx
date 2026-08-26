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
| host  | canvas blit, keyboard, gamepads, mouse, audio, file drops, 60Hz clock | done |
| L0 core | VDP, PSG, OPLL (vendored from WebMSX) | done |
| L1 API | typed register/VRAM/port access | done |
| L2 BIOS | drawing and sprites | done |
| L2 BIOS | music: MML and a frame-driven driver | done |
| L2 BIOS | images: a URL in, VRAM out, reduced to the mode | done |
| L2 BIOS | text: the host's fonts, rasterised outside and carried in | done |
| L2 BIOS | console: a character grid, repainted a changed cell at a time | done |
| L2 BIOS | atlas: the host's glyphs cached in VRAM, in place of a kanji ROM | done |
| L2 BIOS | ime: kana-kanji conversion, drawn by the machine | done |
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

**`snap` is for a face that is already a bitmap.** Such a face is only crisp
where its own grid lands on the machine's, and at the size it was drawn for two
things stop that. The face may hang its rows off the baseline - JF Dot K12x10
puts its dots 0.41 of a dot low, so at ten pixels an em every row of them
straddles two of ours. And the browser grid-fits: that face's `gasp` asks for
it above eight pixels, so the rasteriser rounds the straddle onto the pixels,
outwards, and one row of dots arrives as two. That is a bitmap face rendered
bold with its dense characters filled in solid, and no threshold downstream can
undo it - by then both rows are honestly covered. So `snap: true` cuts the face
at four times the size, where a rounding of that kind moves an edge a quarter
of one of our pixels, and folds it back four rows to one on the seam that lands
the face's grid on ours. Only a bitmap face wants it; an outline face is grey
by design.

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


## Putting the picture on the page

`present` scales by the picture's **true width** rather than its pixel count: a
512-wide mode fills the same screen as a 256-wide one, so both come out the same
size on the page and neither is stretched. Smoothing is off, so a pixel is a
pixel.

That leaves one case worth knowing about, because it is the one that makes small
type look bold. A 512-wide mode's pixels are half as wide, and a canvas sized in
whole 256-wide pixels has an odd number of them to give a 544-pixel frame - 816
across 544 is one and a half each. Nearest neighbour at one and a half keeps
every other column twice, so a stroke comes out two pixels wide in one place and
three in the next, and the flank the atlas so carefully thresholded is either
promoted to full ink or dropped. Measured over a page of 12-pixel type: runs of
solid ink 1, 2 and 3 pixels long in roughly equal numbers, for a face whose stems
are all the same width. At a whole magnification every run is even.

So where the magnification does not divide, the vertical - which always does - is
done first and nearest, and the horizontal is left to a filter. Which is what the
mode is anyway: columns finer than the display can resolve, resolved rather than
picked. Every square-pixel mode, and a 512-wide one on a canvas sized for it, goes
straight to the screen untouched.


## The CRT

None of the above is the whole of what a picture looked like in 1988. There is
an optional tube in front of it: scanlines, bloom on the bright parts, a
badly-converged RGB fringe, a curve to the glass, a vignette and a mains
flicker. It is a WebGL2 fragment shader over one quad, so the machine pays
nothing for it - the V9938 has finished with the frame before the shader sees
it, and the pixels underneath are exactly the ones it drew.

```ts
const runtime = run(app, { canvas, crt: true });
```

`crt: true` takes the defaults; an object sets any of them to start with. Every
one of them is live afterwards, on `runtime.crt` and on `ctx.crt`, which are
the same object:

```ts
update({ crt, input }) {
    if (!crt) return;                              // no tube on this host
    if (input.pressed(BUTTON.A)) crt.enabled = !crt.enabled;
    crt.set({ curvature: 0.2, scanlineIntensity: 0.5 });
    crt.params.yOffset += 0.01;                    // roll the picture
    crt.reset();                                   // back to the defaults
}
```

| | | |
|---|---|---|
| `enabled` | | Off passes the frame through untouched. Free to flip. |
| `smoothing` | | Magnify with a plain filter instead of keeping pixel edges hard. |
| `scanlineIntensity` | 0 – 1 | How dark the gaps go. |
| `scanlineCount` | `"auto"` | Lines to lay down. `"auto"` is the frame's own height. |
| `adaptiveIntensity` | 0 – 1 | Varies the scanline depth down the screen. |
| `brightness` | 0.6 – 1.8 | Before contrast, and on the bloom tap. |
| `contrast` | 0.6 – 1.8 | Around mid grey. |
| `saturation` | 0 – 2 | 0 is greyscale, 1 leaves it, 2 is lurid. |
| `bloomIntensity` | 0 – 1.5 | How far the bright parts bleed. |
| `bloomThreshold` | 0 – 1 | What counts as bright. |
| `rgbShift` | 0 – 1 | Red and blue pulled apart, as a misconverged tube does. |
| `vignetteStrength` | 0 – 2 | How far the corners fall off. |
| `curvature` | 0 – 0.5 | How far the glass bulges. Past the edge is black. |
| `flickerStrength` | 0 – 0.15 | Mains hum in the brightness. |
| `yOffset` | | Scanline phase. Wind it to roll the picture. |

Three things are worth knowing before turning it on.

**The canvas is decided at boot.** A canvas has one kind of context for its
whole life, and the tube needs WebGL2 where the flat path needs 2D. So `crt`
is a `boot` option and not a switch: `enabled` turns the effect off, but the
canvas keeps its WebGL context and goes on drawing the quad. To go back to the
flat path you have to boot on a fresh canvas, which is what the launcher's CRT
button does. Where WebGL2 is missing the host says so on the console, draws the
frames itself, and leaves `crt` null - which is why the examples above check.

**The magnification moves to the GPU.** What goes up as a texture is the VDP's
own canvas, which is 544x456 whatever the mode and has the picture in a corner
of it - 272x228 for SCREEN 5 and 8, 544x228 for SCREEN 6 and 7. The shader is
told where that corner is and how far each axis is being stretched, and works
in the picture's own coordinates from there. So the modes come out the way they
should: SCREEN 5 magnified the same amount across as down, SCREEN 7 half as far
across as down, because its columns really are half as wide.

That leaves the same odd-magnification problem the flat path has, and the
shader deals with it rather better. `smoothing` off - the default - lands on
texel centres wherever the magnification is a whole number, so the pixels are
hard; where it is not, it crosses from one column to the next over exactly one
screen pixel instead of keeping every other column twice. Per axis, so a
SCREEN 7 frame at 1.5 across and 3 down is resolved across and hard down. The
sampler is filtering either way: the hard edges are the shader picking centres,
which is what lets the same code do both. `smoothing` on gives that up for a
plain filter, which is softer and is the look the shader was written for.

**The mouse does not follow the curve.** `ctx.pointer` undoes the CSS scaling
and the letterboxing, but not the curvature: that bends what is shown, not
where the machine thinks its pixels are. At `curvature: 0.08` the corners are
out by a pixel or two and nobody notices. Wind it up and the cursor and the
picture part company.

The shader is [gingerbeardman's WebGL CRT
shader](https://github.com/gingerbeardman/webgl-crt-shader), MIT licensed. See
[Credit and licensing](#credit-and-licensing).


## The mouse

`ctx.pointer` is where the mouse is, in the machine's own pixels - the ones
`gfx` draws in, whatever size the canvas happens to be on the page. The host
undoes the two transforms between them: the CSS scaling of the canvas, and the
letterboxing `present` applies to fit the picture inside it. The border the VDP
draws around the active display comes off too, so 0,0 is the top left of the
screen and not of the signal.

```ts
update({ pointer, gfx }) {
    if (pointer.pressed() && pointer.inside) select(pointer.x, pointer.y);
    if (pointer.down()) fader = pointer.x;               // still held: a drag
    gfx.now.pixel(pointer.x, pointer.y, 15);
}
```

It is latched once a frame like the joystick is, so `pressed` and `released`
mean "since the last update" no matter how many events the browser delivered in
between, and `dx` / `dy` are the movement over that frame. `inside` says
whether the position is on the screen or beside it, and `present` whether a
pointer has reported at all - a touch screen may never move one, and a cursor
drawn for a device that has not got one is a lie.

A press captures the pointer, so a drag that leaves the screen keeps being
delivered until the button comes up. The events are pointer events rather than
mouse events, which means a finger works as well as a mouse. Pass
`pointer: false` to `BrowserHost` to bind none of it.

Nothing about this is how an MSX read a mouse - that was two bits of relative
movement at a time through a joystick port, integrated by the program itself.
This is the host's own pointer, handed over in the machine's coordinates.


## Typing, and a screen made of characters

`input` is the joystick: six buttons, two ports, latched once a frame so
`btnp` means "since the last update". That shape is right for a game and wrong
for text. A key held down is a level; a key *typed* is an event, and two of
them in one frame are two characters that both have to arrive, in the order
they were struck. So `ctx.keyboard` is a queue rather than a latch - the third
sibling of `input` and `pointer` rather than a part of either.

```ts
update({ keyboard }) {
    keyboard.capturing = true;               // said once: this app is typed into

    for (const event of keyboard.take()) {   // in the order they were struck
        if (event.key === "Backspace") backspace();
        else if (event.key.length === 1) insert(event.key);
    }
}
```

`key` is the character the key produced - already shifted, already through the
host's layout - and a name like `"Enter"` or `"ArrowLeft"` when it produced
none. `code` is the physical key underneath it, which is what a game binds.
Anything not read is dropped at the end of the frame, so an app that ignores
the keyboard does not accumulate one.

`capturing` says the machine is being typed into rather than played, and two
things follow. The joystick keymap goes quiet, so Z and X are letters again.
And the host stops the page acting on the keys itself - no scrolling on space,
no going back on backspace - except for anything held with ctrl, alt or the
platform key, which is left to the browser so its own shortcuts survive being
typed at. F1 to F4 are swallowed too, which is what leaves an app being typed
into any commands at all; F5 is deliberately not, because taking a page's reload
away from someone is worse than being one key short.

Auto-repeat is made here rather than taken from the browser: half a second,
then thirty a second, counted in frames. A headless run and a browser run
therefore produce the same keystrokes from the same keys, which is what lets
`keyboard.type("hello")` stand in for a keyboard in a test.

**Nothing here composes.** There is no preedit and no candidate list at this
layer, on purpose: what a host hands over is keystrokes, and the conversion
happens above it in `ctx.ime`, inside the machine, where the V9938 draws the
candidates in the palette everything else is drawn in and a gamepad could pick
from them.

### The console

`ctx.console` is a grid of characters laid over the bitmap. Not a V9938 text
mode - those are pattern-based and have only the glyphs in a ROM, which is
exactly the wall a Japanese text screen runs into. A Japanese MSX2 answered
that with a kanji ROM and a driver that copied patterns out of it into VRAM,
and the same answer works here with the host's fonts in the ROM's place.

```ts
const term = ctx.console;                  // 85x26 in SCREEN 7, 42x26 in SCREEN 5

term.color(15, 0);
term.cls();
term.writeln("READY");                     // streaming: wraps, scrolls, knows \n and \t
term.text(0, 25, status, 15, 4);           // addressed: no wrap, no scroll, no cursor move
term.locate(col, row);
term.cursorOn = frame % 32 < 20;
term.flush();                              // and only now does anything reach VRAM

term.measure("日本語");                        // 6 cells in the atlas, 3 in the ROM font
```

What makes it a console rather than a loop calling `gfx.text` is the shadow
buffer. Every cell's character and colours are kept, writes go into that, and
`flush` paints only the cells that actually changed. An app can therefore
re-emit its whole visible page every frame and pay for what moved:
`term.repainted` is the count, and on an idle screen it is zero.

Anything laying text out has to count in cells rather than characters, and to
ask the console for the count rather than assume it - `term.measure` answers for
the font it is actually holding, which is two cells for a kanji in the atlas and
one in the ROM font, where a kanji is a question mark. Writing a cell with what
it already holds is free, full-width characters included, which is what makes
re-emitting the page an honest way to draw.

Scrolling is the other half of that bargain. `term.scroll(lines, fromRow,
rowCount)` moves a band of rows with one VRAM-to-VRAM copy - the cheapest thing
the chip does, and why text screens scrolled as fast as they did - and leaves
only the row the copy uncovered needing paint.

Painting goes through `gfx.now` rather than the blitter, deliberately. A caret
that arrives three frames after the key was struck is a broken caret, and this
is the case `gfx.now` exists for.

The glyphs come from a `GlyphSource`, which is where the next step goes in: the
ROM font is one implementation, and a cache of host-rasterised glyphs living in
a spare VRAM page - this machine's answer to a kanji ROM - is the other.
Nothing above that interface knows which it is talking to.


### Kanji, and the page they live in

The ROM font stops at ASCII 126, and the glyphs a Japanese screen needs were
never in it. A Japanese MSX2 answered that with a **kanji ROM** and a driver
that copied the bitmaps it needed out of it into VRAM, so the screen could then
be built out of VRAM-to-VRAM copies. `VramAtlas` is that arrangement with the
ROM replaced by the host's own typefaces - the same bargain `text` strikes for
display type, applied to a grid.

```ts
const atlas = new VramAtlas(bios.system.vdp, screen, text, {
    page: 1,                                  // a page nothing is drawn on
    cellHeight: 16,                           // what a kanji ROM's glyphs were
    style: { font: "'Noto Sans Mono CJK JP', monospace" }
});
console.setFont(atlas);
console.text(0, 0, "日本語");                 // two cells each, and cached after the first
```

The browser's rasteriser is asked for a character **once, ever**. What it gives
back lands in a page of VRAM, and every appearance after that is a copy inside
video memory. The point of that is not speed - the console paints immediately,
so nothing is being paced - it is that **the budget becomes real**: a page holds
512 half-width slots, a kanji takes two, and past 256 of them something has to
go. `atlas.stats` reports `used`, `misses` and `evictions`, which is a number an
MSX programmer would have recognised.

**Levels, not colours.** Storing a glyph in the colours it will be drawn in
would mean one entry per colour pair, and the 512 would go four times as fast.
So the page holds *coverage levels* - 0 for the paper, 1 upward for the ink -
and the colour is applied on the way out by a 256-entry table that recolours a
whole byte of packed pixels at once. One entry per character, any colours, and
the copy stays byte-at-a-time, which is what `HMMM` does on the chip.

That table is also where antialiasing lives, and the palette is an input as
everywhere else: `levels: 3` stores a flank, and `ramp` says which registers it
is spent on.

```ts
new VramAtlas(vdp, screen, text, { levels: 3, ramp: (ink) => [13, 14, ink] });
```

**The cell decides the size, not the style.** A CJK face declares an ascent and
descent coming to nearly one and a half times its em, so a 16-pixel cell asked
for "16px" comes back holding ten pixels of type with air round it. So the atlas
measures the *ink* - it rasterises a glyph that fills its em square, finds the
covered pixels, and scales until they fill the cell. `stats.size` is the em it
settled on, which is rarely the one asked for.

**Unless the face is a bitmap, in which case it decides everything.** A pixel
font is drawn for exactly one size and scaling it is what ruins it, so `fit:
false` turns the search off and `style.size` is taken literally. `cellWidth` is
there for the same reason: a bitmap grid is rarely half its own height.

```ts
new VramAtlas(vdp, screen, text, {
    style: { font: "'JF Dot K12x10', monospace", size: 10, stretch: 1, snap: true },
    cellWidth: 6, cellHeight: 12,     // the grid the face was drawn on
    fit: false, levels: 1             // one size, one coverage level
});
```

Three measured facts about that particular face, because they are the sort that
cost an afternoon. Its full-width advance is **1.2 em** - twelve dots across an
em ten tall - so the size that gives twelve pixels is 10, not 12. `stretch`
has to be 1, which **rules out the 512-wide modes**: their pixels are half as
wide, so `text` draws the em twice as wide to keep type the right shape, and
doubling an outline is not doubling a bitmap. A bitmap face cannot spend finer
pixels on anything; it has one size, and that size wants square ones. And its
rows do not land on the machine's by themselves - they sit 0.41 of a dot below
the baseline and the browser grid-fits them outwards, which is one row of dots
arriving as two. That is what `snap: true` is doing up there; without it the
whole face comes out a stroke too heavy and the dense kanji fill in solid.

**Two cells for the wide ones.** `charCells` is Unicode's East Asian Width: the
kana and kanji take two, half-width katakana take one. The console counts in
cells throughout - the caret cannot land inside a kanji, a wrap moves a whole
character to the next line, and writing over half of one turns the stranded half
into a space rather than leaving a fragment.

How many characters fit is arithmetic, not a layout decision. A 16x16 glyph
leaves room for sixteen to a line of a 256-pixel screen, which is what Japanese
MSX software had to work with and why it always felt cramped; the 12x12 cell of
a dot font gives twenty-one, and fits 882 half-width slots in a page against
512. Small type buys both, which is the other reason a machine this size used
it.


### Japanese input

The browser has an input method and this does not use it. Its candidate window
floats over the canvas in the system's typeface at the system's size, and on a
screen of sixteen colours and 16x16 cells that is not a candidate window - it is
a browser drawn on top of a machine.

So the conversion happens inside. The engine is
[hechima](https://github.com/msonrm/hechima): Mozc built with Emscripten, in a
worker, behind a session layer that has no UI of its own. What comes back is a
preedit and a list of candidates **as data**, and where they go is the machine's
business.

```ts
const hechima = await connectHechima({
    onProgress: (loaded, total) => drawProgress(loaded / total)   // about 15MB, once
});
ime.attach(hechima.session);
ime.enabled = true;

update({ ime, keyboard }) {
    // The engine gets first refusal; what it does not want comes back.
    for (const event of ime.feed(keyboard.take())) edit(event);
    document += ime.takeText();          // whatever it settled since last frame
}

draw({ ime, console }) {
    for (const segment of ime.segments) {
        // "yomi" is the raw reading, "focus" the clause being chosen, "other" the rest
    }
    ime.candidates.forEach((text, i) => console.text(...));   // and ime.selected
}
```

`ime.feed` is given a frame's keystrokes and hands back the ones the engine
refused - a cursor key with nothing being composed belongs to whatever the app
is editing. Committed text arrives through `takeText`, which is a mailbox rather
than a return value: the worker answers between frames, not inside the one that
asked. `ime.select(n)` takes a candidate outright, which is what a bar you can
point a joystick at needs.

**The engine is a seam.** `ImeSession` is three methods, hechima's `FepSession`
satisfies it as shipped, and a test supplies its own - so the conversion
behaviour is testable without a dictionary anywhere near it. `host/hechima.ts`
is the only file that knows hechima exists.

**It runs headless.** hechima ships as a Web Worker script, which node has no
notion of, but `HechimaWorkerLike` is structural - `postMessage` and
`addEventListener` - so a faked worker global scope is enough to bring the whole
engine up outside a browser. `spike/hechima/node-probe.mjs` does exactly that in
about forty lines, which means a conversion is a thing a test can look at.

Three things follow from doing it this way that a host IME cannot give:

| | |
|---|---|
| the candidate bar | in the palette everything else is in, in the same glyphs |
| a gamepad | it is a list and an index, so anything can pick from it |
| a screenshot | of a conversion, headless, reproducible |

#### What it costs, and where the files are

About 15MB over the wire, nearly all of it Mozc's dictionary, fetched once and
cached by the browser thereafter. Nothing is fetched until `connectHechima` is
called, so an app that never asks for Japanese never pays.

The bundles are not vendored into this repository - they are 21.9MB and belong
to another project that is explicit about breaking across its own layer
boundaries. `scripts/fetch-hechima.sh` puts a pinned set (the combination
hechima's own `VENDOR.md` calls verified) under `public/hechima/`, which vite
copies into the build; the Pages workflow runs it before building. Without it
the editor still loads and says it cannot convert.

Paths given to the worker are resolved relative to **the worker script**, not to
the page, which is what lets the whole thing work under a subpath like
`sylx.github.io/fantasy-msx/`. The single-thread wasm build needs no COOP/COEP
headers, which is what lets it work on Pages at all.

Conversion is powered by Mozc (BSD-3-Clause + NAIST License + Public Domain);
`scripts/fetch-hechima.sh` writes the attribution alongside the files.

#### What is not there yet

Key **releases** are not passed to the engine. The chord layouts hechima ships -
NICOLA, and the naginata arrangement - decide what a key means by what is held
with it, so they need them; the romaji path does not, and `Keyboard` does not
queue them yet.


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

### EDITOR

A Japanese text editor, with nothing on screen the V9938 did not draw. Three
things that were once separate demos live in it, because they are one thing: a
text screen with no text mode underneath it, a font cache in a spare VRAM page
standing in for the kanji ROM this machine never had, and a conversion engine
whose candidate list is drawn in cells like everything else.

The grid is 42 by 17 - nineteen full-width characters to a line once the line
numbers have theirs, which is what a Japanese word processor on a machine this
size looked like, and the reason it looked like that is arithmetic rather than
taste: 212 lines divided by a twelve-dot cell is seventeen rows and there is no
more screen.

Type into it. The number worth watching is **EDIT** in the status bar. The whole
visible page is re-emitted every frame and only the cells the shadow buffer
disagrees about reach VRAM: adding a character to the end of a line is worth a
handful, inserting one in the middle is worth the rest of that line, because the
rest of that line moved. Scrolling is worth a row rather than a page - the band
between the bars is moved with one VRAM-to-VRAM copy and only the uncovered row
is drawn. An idle screen costs nothing at all.

**F1 switches the face, which switches the mode with it.** OUTLINE is the
default and runs in SCREEN 7, where an outline face gets twice as many columns
to put the stroke in - which is what keeps M and W apart at this size, and what
a 256-wide mode cannot do. It is cut at **three coverage levels**, which is two
palette entries spent on antialiasing: an outline this small has no edge a
threshold can find, so the flank goes into two shades of the paper's own blue
and the stroke keeps its weight along its length. Two of sixteen registers is
what that costs, and saying so is the point. DOT is JF Dot K12x10 and runs in
SCREEN 5, because it cannot do anything else: a bitmap face is drawn for exactly one size on exactly
one grid, and a mode with finer pixels has nothing to spend them on. So the face
decides the mode rather than the other way round, and the switch lays the same
document out on the same 42 by 17 grid either way. One of them is the machine's
own kind of picture and the other is a photograph of type.

**F2 puts the font page itself on the display.** You are then looking at the
cache, laid out in the order the characters were first asked for - not a diagram
of it, the actual memory the text on the other page is copied from. It is dark
until it is lent a colour, which is the honest part: the page holds coverage
levels rather than palette indices, so the levels have to borrow exactly the
entries the text on the other page is drawn in, and give them back afterwards.

**Ctrl+Space is the kana key**, and the first press of it fetches the dictionary
- about 15MB of Mozc, and nothing is fetched before it is asked for. Every press
after that turns conversion on and off, and the status bar says which of the two
the next one will do, because that key is the only thing in the editor that
cannot be found by looking at the screen.

What comes back is a preedit and a list of candidates as data, so the preedit
sits inline where the caret is - the clause being chosen inverted, the rest on a
colour of their own, as a FEP marked them - and the candidate list is the bar
along the foot of the screen. It is at the foot rather than under the caret
because a line is nineteen full-width characters and a popup would cover the
sentence it is about, which is where Japanese MSX software put it for the same
reason. **Space** converts and then cycles, **1 to 9** take a candidate straight
off the bar, and **Enter** settles it.

The commands are on function keys because everything else is text: the keyboard
is captured, so Z and X are letters, and keys held with ctrl or the platform key
are left to the browser. An MSX had a row of function keys and a row of labels
for them along the foot of the screen, which is where these are.

```
 UNTITLED.TXT *                 173/882 M106
```

Slots taken of slots there are, and the times the host's rasteriser had to be
asked. On a page of Japanese the first number climbs to a few hundred and stops.

Outside a browser there is nothing to ask for a glyph at all, so it falls back
to the machine's own 6x8 ROM font and says ROM in the bar. The Japanese comes
out as question marks - which is exactly what a ROM font has to say about it,
and the reason the atlas exists.


### LOOM

A composing machine, and a mixing desk to hear it through. There is no MML in
the demo and no `bgm.play`: the chords come out of a Markov chain over scale
degrees, the tune is a motif walked across them, and a sequencer of its own
writes the chips a sixteenth at a time - on the vertical interrupt, which is
the only clock a music driver on this machine ever had.

Diatonic harmony falls out of one rule: stack thirds on a scale degree by
taking every other degree of the mode. The qualities look after themselves -
the chord on the second degree comes out minor in a major key and major in
dorian without anything in the file knowing that - and the chain that picks the
degrees is functional harmony written down as a table of weights, with the last
bar forced to a dominant so the loop leans back into the tonic it began on.

Nine parts, over two chips and the OPLL's rhythm mode:

| part | voices | |
|------|--------|-|
| PAD  | OPLL 0-3 | the chord, voice-led so each part moves as little as it can |
| LEAD | OPLL 4 | a motif, landing on chord tones where the beat is strong |
| BASS | OPLL 5 | roots, fifths, and a step into the chord that is coming |
| DRUM | OPLL 6-8 | rhythm mode, which trades three FM voices for five drums |
| ARP  | PSG A | the chord again, one note at a time |
| ECHO | PSG B | the lead three steps late and quieter, which is a delay made of notes |
| HAT  | PSG C | the noise generator |

The desk along the bottom is the chips' own controls rather than a mixer laid
over them. An OPLL level is the four-bit attenuation that shares a register
with the instrument number, and the driver rewrites it every frame - so a fader
moved during a note reaches that note. A PSG level is four bits with no useful
envelope behind them, so the voices there are what MSX drivers actually did: a
table of levels, one written per frame, which is where PLUCK and SWELL come
from. The rhythm channels need a pitch of their own, since the drums are built
from the same phase generators as the melody voices and a channel left at
F-number zero never advances.

Everything is drawn with `gfx.now`. A control that has to be under the mouse
this frame cannot wait for the blitter, and the roll is kept as a byte-a-pixel
model besides, so the playhead can put back exactly what it swept over. The
cursor is two sprites - the arrow, and the same arrow a pixel down and across
in the panel colour, because a sprite is one colour to a line and a white arrow
over a white fader needs a shadow.

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
npm run loom -- out.png     # LOOM, with the desk worked by a scripted mouse
npm run editor -- out.png   # EDITOR, typed into by a scripted keyboard
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
./scripts/fetch-hechima.sh       # the conversion engine, 21.9MB, for the editor
npm run vendor                   # re-copy the WebMSX core (only after a submodule bump)
npm test
npm run dev                      # the example, in a browser
npm run demo -- out.png          # four frames of the blitter working, tiled
npm run play -- out.png          # the example, headless, with scripted input
```

`src/core/vendor/` is generated. Edit `scripts/vendor.sh`, never the files it
writes - the copies are verbatim so upstream changes stay reviewable as a diff.

`public/fonts/JF-Dot-k12x10.woff2` is the bitmap face the Japanese examples are
set in; `examples/fonts.ts` holds the measurements it insists on, the outline
face it falls back to, and why the choice between them is a choice of screen
mode.

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

The CRT shader under `src/host/crt.ts` is [WebGL CRT
Shader](https://github.com/gingerbeardman/webgl-crt-shader) by **Matt
Sephton**, MIT licensed, and itself a conversion of a LOVE2D shader. The GLSL
here is his; what is different is that it is written as WebGL2 directly rather
than assembled at runtime out of the three.js version, and that it samples the
picture out of the corner of the VDP's canvas at that canvas's own size, per
axis, instead of a canvas already scaled up to fit.

The chip emulation is WebMSX by **Paulo Augusto Peccin**, vendored under
`src/core/vendor/` and copied verbatim so its provenance stays visible in the
diff. Every file keeps its original copyright header.

Those headers refer to a `license.txt` that is not present in the WebMSX
repository, so the terms of reuse are unconfirmed. This is fine for something
shared privately, which is what this is. Anyone thinking of putting it in front
of a wider audience should settle the terms with the author first.
