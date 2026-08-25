// Runs the spike page in a real browser and prints what it found.
//
// The page is served from a subdirectory on purpose: this console deploys to
// sylx.github.io/fantasy-msx/, and the whole point of question 2 is whether
// hechima's worker, wasm and dictionary survive a prefix. The server also
// counts what it serves, which is question 3's other half.
//
//   node spike/hechima/run.mjs            # cold, uncompressed
//   node spike/hechima/run.mjs --gzip     # cold, with the pre-compressed dictionary
//
// Each run uses a fresh browser profile, so the cache is always cold.

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved rather than imported: playwright is worth having for a spike and
// not worth adding to the console's own dependencies. Point PLAYWRIGHT at an
// installed copy, or `npm i -D playwright && npx playwright install chromium`.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright").catch(() => {
    console.error("playwright not found. Either install it:\n"
        + "  npm i -D playwright && npx playwright install chromium\n"
        + "or point PLAYWRIGHT at a copy:\n"
        + "  PLAYWRIGHT=~/.npm/_npx/*/node_modules/playwright node spike/hechima/run.mjs\n"
        + "or just open spike/hechima/index.html through any static server.");
    process.exit(1);
});

const here = fileURLToPath(new URL(".", import.meta.url));
/** The prefix the real site is served under, so the spike is not served at the root. */
const PREFIX = "/fantasy-msx/spike";
const withGzip = process.argv.includes("--gzip");

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".data": "application/octet-stream",
    ".gz": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8"
};

let served = 0;
const log = [];

const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    if (!path.startsWith(PREFIX)) return notFound(response, path);

    let relative = normalize(path.slice(PREFIX.length)).replace(/^\/+/, "");
    if (relative === "" || relative.endsWith("/")) relative += "index.html";

    const file = join(here, relative);
    if (!file.startsWith(here) || !existsSync(file) || statSync(file).isDirectory()) {
        // A 404 on .gz is expected and is how the worker falls back, so it is
        // logged rather than treated as a failure.
        return notFound(response, path);
    }

    const size = statSync(file).size;
    served += size;
    log.push(`  200  ${String(size).padStart(10)}  ${path}`);
    response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": size
    });
    createReadStream(file).pipe(response);
});

function notFound(response, path) {
    log.push(`  404  ${" ".repeat(10)}  ${path}`);
    response.writeHead(404).end("not found");
}

// The dictionary's pre-compressed twin is hidden unless asked for, so the two
// runs measure the same thing with and without it.
if (!withGzip) {
    const gz = join(here, "vendor/hechima-wasm/mozc.data.gz");
    if (existsSync(gz)) {
        const { renameSync } = await import("node:fs");
        renameSync(gz, gz + ".off");
        process.on("exit", () => renameSync(gz + ".off", gz));
    }
} else {
    const off = join(here, "vendor/hechima-wasm/mozc.data.gz.off");
    if (existsSync(off)) {
        const { renameSync } = await import("node:fs");
        renameSync(off, off.replace(/\.off$/, ""));
    }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}${PREFIX}/`;
console.log(`serving ${here} at ${url}  (${withGzip ? "with" : "without"} mozc.data.gz)\n`);

const browser = await chromium.launch();
const page = await browser.newPage();

let report = null;
page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("SPIKE_REPORT ")) report = JSON.parse(text.slice("SPIKE_REPORT ".length));
    else if (message.type() === "error") console.log(`  [browser error] ${text}`);
});
page.on("pageerror", (error) => console.log(`  [page error] ${error.message}`));

const started = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__spike !== undefined, null, { timeout: 180000 })
    .catch(() => console.log("  timed out waiting for the spike to finish"));
if (!report) report = await page.evaluate(() => window.__spike ?? null);
const wall = (Date.now() - started) / 1000;

await browser.close();
server.close();

console.log("requests");
console.log(log.join("\n"));
console.log(`\nserved ${(served / 1048576).toFixed(1)}MB over ${log.length} requests, ${wall.toFixed(1)}s wall\n`);
console.log("report");
console.log(JSON.stringify(report, null, 2));
