import { describe, expect, it } from "vitest";
import { BUTTON, Keyboard, boot, type Context, type KeyEvent } from "../src/index.js";

/** Presses and releases a key, the way a host would. */
function tap(keyboard: Keyboard, code: string, key = code): void {
    keyboard.press({ code, key });
    keyboard.release(code);
}

describe("Keyboard", () => {
    it("keeps keystrokes in the order they arrived", () => {
        const keyboard = new Keyboard();
        keyboard.type("hi");
        tap(keyboard, "Enter");

        expect(keyboard.take().map((event) => event.key)).toEqual(["h", "i", "Enter"]);
    });

    it("empties on being taken, so nothing is read twice", () => {
        const keyboard = new Keyboard();
        keyboard.type("ab");
        expect(keyboard.take()).toHaveLength(2);
        expect(keyboard.take()).toHaveLength(0);
    });

    it("carries the modifiers, and whether it is a repeat", () => {
        const keyboard = new Keyboard();
        keyboard.press({ code: "KeyS", key: "s", ctrlKey: true });

        const [event] = keyboard.take();
        expect(event).toMatchObject({ code: "KeyS", key: "s", ctrl: true, shift: false, repeat: false });
    });

    it("repeats a held key after a delay, then steadily", () => {
        const keyboard = new Keyboard();
        keyboard.press({ code: "KeyA", key: "a" });
        keyboard.take();

        // Nothing for the first half second.
        for (let i = 0; i < 29; ++i) keyboard.tick();
        expect(keyboard.take()).toHaveLength(0);

        keyboard.tick();
        const first = keyboard.take();
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ key: "a", repeat: true });

        // Then one every other frame.
        for (let i = 0; i < 10; ++i) keyboard.tick();
        expect(keyboard.take()).toHaveLength(5);
    });

    it("stops repeating when the key comes up", () => {
        const keyboard = new Keyboard();
        keyboard.press({ code: "KeyA", key: "a" });
        for (let i = 0; i < 40; ++i) keyboard.tick();
        expect(keyboard.take().length).toBeGreaterThan(0);

        keyboard.release("KeyA");
        for (let i = 0; i < 40; ++i) keyboard.tick();
        expect(keyboard.take()).toHaveLength(0);
    });

    it("never repeats a modifier on its own", () => {
        const keyboard = new Keyboard();
        keyboard.press({ code: "ShiftLeft", key: "Shift" });
        keyboard.take();
        for (let i = 0; i < 60; ++i) keyboard.tick();
        expect(keyboard.take()).toHaveLength(0);
    });

    it("drops the oldest rather than growing without limit", () => {
        const keyboard = new Keyboard();
        for (let i = 0; i < 200; ++i) tap(keyboard, "KeyA", "a");

        const events = keyboard.take();
        expect(events.length).toBeLessThanOrEqual(64);
    });

    it("claims the keys a page would act on, but only while capturing", () => {
        const keyboard = new Keyboard();
        expect(keyboard.claims({ code: "Space", key: " " })).toBe(false);

        keyboard.capturing = true;
        expect(keyboard.claims({ code: "Space", key: " " })).toBe(true);
        expect(keyboard.claims({ code: "Backspace", key: "Backspace" })).toBe(true);
        expect(keyboard.claims({ code: "KeyA", key: "a" })).toBe(true);
        // The browser's own shortcuts survive being typed at.
        expect(keyboard.claims({ code: "KeyR", key: "r", ctrlKey: true })).toBe(false);
        expect(keyboard.claims({ code: "F5", key: "F5" })).toBe(false);
    });
});

describe("a keyboard on a running machine", () => {
    it("hands the app one frame's keystrokes and drops what it did not read", () => {
        const seen: KeyEvent[][] = [];
        const runtime = boot();
        runtime.run({ update: ({ keyboard }: Context) => { seen.push([...keyboard.take()]); } });

        runtime.keyboard.type("ok");
        runtime.step(1);
        expect(seen[0].map((event) => event.key)).toEqual(["o", "k"]);

        runtime.step(1);
        expect(seen[1]).toEqual([]);

        // Nobody reads this one, and it does not turn up later.
        const quiet = boot();
        quiet.run({ update: () => {} });
        quiet.keyboard.type("lost");
        quiet.step(2);
        expect(quiet.keyboard.pending).toBe(0);
    });

    it("quiets the joystick keymap while the keyboard is being typed on", () => {
        const runtime = boot();
        runtime.run({ update: () => {} });

        runtime.input.setKey("KeyZ", true);
        expect(runtime.input.btn(BUTTON.A)).toBe(true);

        // Capturing lets go of what the keymap was holding, since the key that
        // pressed it may never be seen coming up.
        runtime.keyboard.capturing = true;
        expect(runtime.input.typing).toBe(true);
        expect(runtime.input.btn(BUTTON.A)).toBe(false);

        runtime.input.setKey("KeyZ", true);
        expect(runtime.input.btn(BUTTON.A)).toBe(false);
        // Raw keys go on being recorded: which keys are down does not change.
        expect(runtime.input.key("KeyZ")).toBe(true);

        runtime.keyboard.capturing = false;
        runtime.input.setKey("KeyZ", true);
        expect(runtime.input.btn(BUTTON.A)).toBe(true);
    });

    it("makes its repeats before the app looks", () => {
        const counts: number[] = [];
        const runtime = boot();
        runtime.run({ update: ({ keyboard }: Context) => { counts.push(keyboard.take().length); } });

        runtime.keyboard.press({ code: "ArrowLeft", key: "ArrowLeft" });
        runtime.step(40);

        expect(counts[0]).toBe(1);                                  // the strike
        expect(counts.slice(1, 29).every((n) => n === 0)).toBe(true);   // the delay
        expect(counts.slice(30).some((n) => n === 1)).toBe(true);       // the repeats
    });
});
