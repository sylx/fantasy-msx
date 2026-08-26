// Emmy's other half, borrowed from the browser.
//
// Chrome ships a small language model with the browser and hands it over
// through `LanguageModel` - the Prompt API. It is the same bargain the rest of
// this machine strikes with its host: the fonts come from the page, the
// pictures are decoded by the page, and the words Emmy says are thought by the
// page. Nothing crosses a network, and nothing here knows what a token is.
//
// https://developer.chrome.com/docs/ai/prompt-api
//
// ## Why waking her is a key you have to press
//
// The dictionary in this example is behind Ctrl+Space because it is 15MB and an
// app that never asks for Japanese should never pay for it. The model is behind
// F1 for the same reason and rather more of it: it is measured in gigabytes,
// and a demo that began fetching one because somebody typed a letter would be
// spending someone else's disk without asking. So `look` only asks whether the
// model is already on the machine - which costs nothing - and `wake` is the
// call that spends, with the progress it reports drawn on the bar like the
// dictionary's.
//
// Where the model is there already, waking is a session and no download at all,
// which is the usual case on a machine that has used the API before.
//
// ## One question, one answer
//
// A session carries its conversation, and this one deliberately does not. The
// built-in model's context is small and an eighties conversation game has no
// memory to speak of anyway, so every question is asked on a `clone` of a
// session holding nothing but the persona: the same character, and no
// recollection of the last thing you said. The clone is destroyed after it
// answers, which is what gives the quota back.
//
// The answer is streamed, because watching a reply arrive a few characters at a
// time is exactly what this machine looked like doing anything.

/** What the browser says about the model, before anything has been spent. */
type Availability = "unavailable" | "downloadable" | "downloading" | "available";

/**
 * Where Emmy is.
 *
 * `absent` is the interesting one: the API is there, the model is not, and the
 * difference between them is a download nobody has agreed to yet.
 */
export type MindState = "unsupported" | "absent" | "fetching" | "ready" | "thinking" | "failed";

/** As much of the Prompt API as this example uses. It is not in the DOM types. */
interface Session {
    promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
    clone(options?: { signal?: AbortSignal }): Promise<Session>;
    destroy(): void;
}

interface Monitor {
    addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

interface CreateOptions {
    initialPrompts?: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
    expectedInputs?: ReadonlyArray<{ type: string; languages?: readonly string[] }>;
    expectedOutputs?: ReadonlyArray<{ type: string; languages?: readonly string[] }>;
    monitor?: (monitor: Monitor) => void;
}

interface LanguageModelApi {
    availability(options?: CreateOptions): Promise<Availability>;
    create(options?: CreateOptions): Promise<Session>;
}

function api(): LanguageModelApi | null {
    return (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel ?? null;
}

/**
 * Who she is, and how much of it she is allowed to say.
 *
 * The length is not a stylistic preference: the balloon is a fixed rectangle to
 * the left of her face, eleven full-width characters across and six lines
 * down, and anything past that is drawn nowhere. Saying so here is
 * cheaper than truncating it afterwards - and a model told the shape of the
 * hole usually fills it rather than overflowing it.
 */
const PERSONA = [
    "あなたは「エミー」という名前の女性型アンドロイドです。",
    "1980年代の8ビットパソコンの中にいて、画面ごしに話しかけられています。",
    "返事は必ず日本語で、1文か2文、全角60文字以内におさめてください。",
    "落ち着いていて、少しそっけない話し方をしますが、相手には好意的です。",
    "自分が機械であることを隠しません。",
    "絵文字、記号、箇条書き、改行は使いません。"
].join("\n");

/** Japanese in, Japanese out - said to the browser rather than only to the model. */
const LANGUAGES: CreateOptions = {
    expectedInputs: [{ type: "text", languages: ["ja", "en"] }],
    expectedOutputs: [{ type: "text", languages: ["ja"] }]
};

export class Mind {
    state: MindState = "unsupported";
    /** How far the model has come down, 0 to 1, while `state` is `fetching`. */
    progress = 0;
    /** Whatever went wrong, short enough for the bar. */
    note = "";

    /** The persona and nothing else. Every question is asked on a clone of it. */
    private base: Session | null = null;

    /**
     * Asks whether the model is on the machine, which is the one question about
     * it that is free. Nothing here downloads anything.
     */
    async look(): Promise<void> {
        const model = api();
        if (!model) {
            this.state = "unsupported";
            this.note = "LanguageModel がない";
            return;
        }

        try {
            const availability = await model.availability(LANGUAGES);
            this.state = availability === "available" ? "ready"
                : availability === "unavailable" ? "unsupported"
                    : "absent";
            if (this.state === "unsupported") this.note = "日本語を扱えない";
        } catch (error) {
            this.state = "unsupported";
            this.note = message(error);
        }
    }

    /**
     * Brings the session up, fetching the model first where it is not here yet.
     *
     * This is the call that spends, and it wants a user gesture behind it: the
     * browser will not begin a download of this size on a page's say-so alone.
     */
    async wake(): Promise<void> {
        const model = api();
        if (!model || this.state === "fetching" || this.base) return;

        this.state = "fetching";
        this.progress = 0;
        this.note = "";

        try {
            this.base = await model.create({
                ...LANGUAGES,
                initialPrompts: [{ role: "system", content: PERSONA }],
                // Only ever called where there is something to fetch, which is
                // how the bar knows to draw a gauge rather than a word.
                monitor: (monitor) => {
                    monitor.addEventListener("downloadprogress", (event) => { this.progress = event.loaded; });
                }
            });
            this.state = "ready";
        } catch (error) {
            this.state = "failed";
            this.note = message(error);
        }
    }

    /**
     * One question, on a session that remembers only the persona, streamed back
     * as it is thought.
     *
     * `hear` is called with everything said so far rather than with the piece
     * that just arrived, because what the caller draws is the whole balloon.
     */
    async ask(question: string, hear: (reply: string) => void): Promise<void> {
        if (!this.base) return;

        this.state = "thinking";
        // A clone of a session that has only been told who it is starts with
        // the persona and no recollection of the last question - which is the
        // whole of the memory an eighties conversation game had.
        let session: Session | null = null;

        try {
            session = await this.base.clone();
            const reader = session.promptStreaming(question).getReader();
            let reply = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                reply += value;
                hear(reply);
            }
            this.state = "ready";
        } catch (error) {
            this.note = message(error);
            this.state = "failed";
            hear(`（${this.note}）`);
        } finally {
            // The quota is per session and this one has served its purpose.
            session?.destroy();
        }
    }
}

function message(error: unknown): string {
    return String(error instanceof Error ? error.message : error).slice(0, 48);
}
