import { describe, expect, it, vi } from "vitest";
import {
    Ime, Keyboard, boot,
    type ImeCallbacks, type ImeSegment, type ImeSession, type KeyTap
} from "../src/index.js";

/**
 * A conversion session standing in for hechima's. Letters pile up as a reading,
 * space converts it into two clauses with candidates, and Enter settles the
 * first. Everything the machine cares about is in that shape; the dictionary is
 * not part of it, which is the point of the seam.
 */
function stubSession() {
    const taps: KeyTap[] = [];
    let reading = "";
    let converted: string[] | null = null;
    let chosen = 0;
    let active = false;
    let callbacks: ImeCallbacks | null = null;

    const CANDIDATES = ["日本", "二本", "にほん"];

    const publish = () => {
        if (reading === "" && !converted) return callbacks!.hide();
        const segments: ImeSegment[] = converted
            ? [
                { text: CANDIDATES[chosen], kind: "focus", candidates: CANDIDATES, candidateIndex: chosen },
                { text: "ご", kind: "other", candidates: ["ご", "語"], candidateIndex: 0 }
            ]
            : [{ text: reading, kind: "yomi" }];
        callbacks!.show(segments);
    };

    const factory = (cb: ImeCallbacks): ImeSession => {
        callbacks = cb;
        return {
            feed(tap) {
                taps.push(tap);
                if (!active) return false;
                if (tap.key === "Enter" && (reading || converted)) {
                    // Note what is *not* here: hechima does not call `hide` on a
                    // commit, and this stands in for hechima.
                    cb.commit(converted ? CANDIDATES[chosen] + "ご" : reading);
                    reading = ""; converted = null; chosen = 0;
                    return true;
                }
                if (tap.key === " " && reading) {
                    if (converted) chosen = (chosen + 1) % CANDIDATES.length;
                    else converted = CANDIDATES;
                    publish();
                    return true;
                }
                if (tap.key.length === 1 && /[a-z]/.test(tap.key)) {
                    reading += tap.key;
                    converted = null;
                    publish();
                    return true;
                }
                // Anything else with nothing being composed belongs to the app.
                return reading !== "" || converted !== null;
            },
            setActive(on) { active = on; if (!on) { reading = ""; converted = null; } return on; },
            reset() { reading = ""; converted = null; chosen = 0; },
            selectCandidate(index) {
                if (!converted || index < 0 || index >= CANDIDATES.length) return false;
                chosen = index;
                publish();
                return true;
            }
        };
    };
    return { factory, taps };
}

/** Keystrokes the way `Keyboard` hands them out. */
function keys(text: string) {
    const keyboard = new Keyboard();
    keyboard.type(text);
    return keyboard.take();
}

function named(key: string, modifiers: Partial<{ ctrl: boolean; meta: boolean }> = {}) {
    const keyboard = new Keyboard();
    keyboard.press({ code: key, key, ctrlKey: modifiers.ctrl, metaKey: modifiers.meta });
    return keyboard.take();
}

describe("Ime", () => {
    it("passes everything through until an engine is attached", () => {
        const ime = new Ime();
        expect(ime.attached).toBe(false);
        expect(ime.feed(keys("abc"))).toHaveLength(3);
        expect(ime.composing).toBe(false);
    });

    it("passes everything through while it is switched off", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        expect(ime.enabled).toBe(false);
        expect(ime.feed(keys("abc"))).toHaveLength(3);
    });

    it("takes the keys it wants and hands back the ones it does not", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;

        expect(ime.feed(keys("nihon"))).toHaveLength(0);
        expect(ime.text).toBe("nihon");
        expect(ime.composing).toBe(true);

        // Nothing is being composed after a commit, so the next arrow is the
        // app's business rather than the engine's.
        ime.feed(named("Enter"));
        expect(ime.feed(named("ArrowLeft"))).toHaveLength(1);
    });

    it("never hands a platform shortcut to the engine", () => {
        const { factory, taps } = stubSession();
        const ime = new Ime();
        ime.attach(factory);
        ime.enabled = true;

        expect(ime.feed(named("KeyS", { meta: true }))).toHaveLength(1);
        expect(taps).toHaveLength(0);
    });

    it("reports the preedit as the engine divided it", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;

        ime.feed(keys("nihon"));
        expect(ime.segments).toEqual([{ text: "nihon", kind: "yomi" }]);
        expect(ime.candidates).toEqual([]);

        ime.feed(keys(" "));
        expect(ime.text).toBe("日本ご");
        expect(ime.focus?.text).toBe("日本");
        expect(ime.candidates).toEqual(["日本", "二本", "にほん"]);
        expect(ime.selected).toBe(0);
    });

    it("cycles candidates, and takes one outright when asked", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;
        ime.feed(keys("nihon "));
        expect(ime.selected).toBe(0);

        ime.feed(keys(" "));
        expect(ime.selected).toBe(1);
        expect(ime.focus?.text).toBe("二本");

        expect(ime.select(2)).toBe(true);
        expect(ime.focus?.text).toBe("にほん");
        expect(ime.select(99)).toBe(false);
    });

    it("hands over settled text once, and only once", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;

        ime.feed(keys("nihon "));
        expect(ime.takeText()).toBe("");

        ime.feed(named("Enter"));
        expect(ime.takeText()).toBe("日本ご");
        expect(ime.takeText()).toBe("");
        expect(ime.composing).toBe(false);
    });

    it("clears the preedit on a commit, though the engine never says hide", () => {
        // The bug this is here for: hechima calls `commit` and nothing else, so
        // a preedit left standing showed the settled string twice - once as
        // text and once inverted, until the next keystroke happened to replace
        // it. `commit` is the end of a preedit whether or not it is announced.
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;

        ime.feed(keys("nihon "));
        expect(ime.composing).toBe(true);

        ime.feed(named("Enter"));
        expect(ime.composing).toBe(false);
        expect(ime.segments).toEqual([]);
        expect(ime.candidates).toEqual([]);
    });

    it("keeps the clauses a partial commit leaves behind", () => {
        // Settling one clause and going on to the next reports `commit` and
        // then `show` with what is left, so clearing on commit must not eat it.
        const ime = new Ime();
        const rest: ImeSegment[] = [{ text: "語", kind: "focus", candidates: ["語"], candidateIndex: 0 }];
        ime.attach((cb) => ({
            feed: () => { cb.commit("日本"); cb.show(rest); return true; },
            setActive: (on) => on,
            reset: () => {}
        }));
        ime.enabled = true;

        ime.feed(named("Enter"));
        expect(ime.takeText()).toBe("日本");
        expect(ime.segments).toEqual(rest);
    });

    it("throws the reading away when it is switched off", () => {
        const ime = new Ime();
        ime.attach(stubSession().factory);
        ime.enabled = true;
        ime.feed(keys("nihon"));
        expect(ime.composing).toBe(true);

        ime.enabled = false;
        expect(ime.composing).toBe(false);
        // And the document is left alone: an abandoned reading is not text.
        expect(ime.takeText()).toBe("");
    });

    it("measures where the focused clause starts, in cells", () => {
        const ime = new Ime();
        const factory = (cb: ImeCallbacks): ImeSession => {
            cb.show([
                { text: "ab", kind: "other" },
                { text: "日本", kind: "other" },
                { text: "語", kind: "focus", candidates: ["語"], candidateIndex: 0 }
            ]);
            return { feed: () => true, setActive: (on) => on, reset: () => {} };
        };
        ime.attach(factory);
        // Two half-width cells and two full-width ones.
        expect(ime.focusOffset()).toBe(6);
    });

    it("is on the context, inert, on every machine that boots", () => {
        const runtime = boot();
        runtime.run({ update: () => {} });
        runtime.step(1);
        expect(runtime.ime.attached).toBe(false);
        expect(runtime.ime.enabled).toBe(false);
    });

    it("does not reach for a session that is not there", () => {
        const ime = new Ime();
        expect(() => ime.reset()).not.toThrow();
        expect(ime.select(0)).toBe(false);
        expect(ime.takeText()).toBe("");
    });

    it("tells the session when it is switched on, even if that was first", () => {
        const setActive = vi.fn((on: boolean) => on);
        const ime = new Ime();
        ime.enabled = true;                       // before anything is attached
        ime.attach(() => ({ feed: () => true, setActive, reset: () => {} }));
        expect(setActive).toHaveBeenCalledWith(true);
    });
});
