// Boot the side panel in a real browser and see whether it survives.
//
// WHY THIS EXISTS. Every other suite tests pure logic. panel.js is ~2,400 lines of
// DOM wiring, and its most common failure mode is not a wrong answer — it is a
// TypeError during boot that leaves the panel half-wired. `boot()` is called
// unawaited with no `.catch`, so a throw in `wireSettings()` wires the first half
// of the panel, skips the rest, and reports nothing. Every button after the throw
// silently does nothing.
//
// That is not hypothetical: the 0.13.0 refactor removed the harvesting toggle from
// the HTML and left `$("#flag-recorder").addEventListener(...)` behind. Calling
// addEventListener on null throws, and the whole tab wiring after it would never
// have run. A static id sweep caught that one; this catches the general case.
//
// WHAT IT DOES NOT DO. It does not touch Instagram, and it never will — driving
// live Instagram is both unreliable and the exact automated-interaction pattern
// that gets user accounts banned. It stubs `chrome.*` and asserts the panel builds,
// switches tabs, and renders seeded data without throwing. That is the gap between
// "the file parses" and "the panel opens".
//
// OPTIONAL, like the extract suite: skips cleanly without playwright, because the
// repo's contract is that a fresh clone needs no install.
//
//     npm install --no-save playwright
//
// The container ships Chromium at PLAYWRIGHT_BROWSERS_PATH; do not run
// `playwright install`.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { createRequire } from "node:module";
import { eq, report } from "../helpers/assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const EXT = join(ROOT, "extension");
const require_ = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require_("playwright"));
} catch (_) {
  console.log("  skipped — playwright not installed (npm install --no-save playwright)");
  console.log("RESULT 0 0");
  process.exit(0);
}

// panel.html loads panel.js as an ES module with relative imports, and file://
// blocks those on CORS grounds. A four-line static server is the whole fix.
const missing = [];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  // The browser asks for /favicon.ico on any HTTP document, unprompted. That is an
  // artifact of serving the panel over HTTP for this test — a real extension page
  // is loaded from chrome-extension:// and never gets the request — so answering it
  // is correct rather than papering over a missing file. Everything else that 404s
  // IS a missing file and gets reported.
  if (req.url === "/favicon.ico") { res.writeHead(204).end(); return; }
  try {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const body = await readFile(join(EXT, rel));
    res.writeHead(200, { "Content-Type": MIME[extname(rel)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    missing.push(req.url);
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// A chrome.* stub rich enough for boot. Installed via addInitScript so it exists
// before any module evaluates — panel.js reads chrome at import time.
const CHROME_STUB = (seed) => `(() => {
  const DB = ${JSON.stringify(seed)};
  const dual = (fn) => (...a) => {
    const cb = typeof a[a.length - 1] === "function" ? a.pop() : null;
    const out = fn(...a);
    if (cb) { cb(out); return undefined; }
    return Promise.resolve(out);
  };
  window.__calls = [];
  globalThis.chrome = {
    runtime: {
      id: "smoke", lastError: undefined,
      getManifest: () => ({ permissions: ["storage", "unlimitedStorage"], version: "smoke" }),
      getURL: (p) => p,
      sendMessage: dual(() => ({ ok: false })),
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        QUOTA_BYTES: 10485760,
        get: dual((keys) => {
          const out = {};
          if (keys == null) return { ...DB };
          if (typeof keys === "string") return { [keys]: DB[keys] };
          for (const [k, d] of Object.entries(keys)) out[k] = k in DB ? DB[k] : d;
          return out;
        }),
        set: dual((obj) => { Object.assign(DB, obj); window.__calls.push(["set", Object.keys(obj)]); }),
        remove: dual((k) => { delete DB[k]; }),
        clear: dual(() => { for (const k of Object.keys(DB)) delete DB[k]; }),
        getBytesInUse: dual(() => 1234),
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: dual(() => [{ id: 1, url: "https://www.instagram.com/alice/", active: true }]),
      get: dual(() => ({ id: 1, url: "https://www.instagram.com/alice/" })),
      update: dual(() => ({})), create: dual(() => ({ id: 2 })), remove: dual(() => {}),
      sendMessage: dual(() => ({ ok: false, error: "smoke_stub" })),
      onUpdated: { addListener() {} }, onActivated: { addListener() {} },
    },
    scripting: { executeScript: dual(() => [{ result: true }]) },
    permissions: { contains: dual(() => false), request: dual(() => false) },
    identity: { getAuthToken: dual(() => undefined), launchWebAuthFlow: dual(() => "") },
    sidePanel: { setOptions: dual(() => {}) },
  };
})();`;

// Seeded so the render paths actually execute against data — an empty store would
// exercise only the "nothing here yet" branches, which is where bugs are not.
const SEED = {
  onboarded: true,
  // Auto-send is OFF by default in the product. Turn it on here so the batch bar
  // actually renders and its second gate — the segment — can be asserted at all.
  // With it off, "no send control" passes for the wrong reason everywhere.
  oneClickSend: true,
  icp: { keywords: ["founder", "agency"], description: "test" },
  prospects: {
    "id:1": { userId: "1", username: "queued_one", profileUrl: "https://www.instagram.com/queued_one/",
      status: "Captured", bio: "Founder of a small agency", followers: 4200, following: 300, posts: 120,
      capturedAt: "2026-07-01T00:00:00.000Z", outlierCount: 2, outlierTopRatio: 4.1,
      outlierTopUrl: "https://www.instagram.com/p/AAA/", outlierCheckedAt: "2026-07-02T00:00:00.000Z" },
    "id:2": { userId: "2", username: "queued_private", profileUrl: "https://www.instagram.com/queued_private/",
      status: "New", isPrivate: true, capturedAt: "2026-07-01T00:00:00.000Z" },
    "id:3": { userId: "3", username: "shortlisted_one", profileUrl: "https://www.instagram.com/shortlisted_one/",
      status: "Shortlisted", bio: "D2C brand owner", followers: 15000, following: 900, posts: 380,
      shortlistedAt: "2026-07-03T00:00:00.000Z", outlierCount: 1, outlierTopRatio: 2.2,
      outlierTopUrl: "https://www.instagram.com/p/BBB/", outlierCheckedAt: "2026-07-03T00:00:00.000Z" },
    "id:4": { userId: "4", username: "read_no_reply", profileUrl: "https://www.instagram.com/read_no_reply/",
      status: "Contacted", followers: 900, following: 120, posts: 40, seenAt: "2026-07-05T00:00:00.000Z",
      shortlistedAt: "2026-07-03T00:00:00.000Z",
      lastContactedAt: "2026-07-04T00:00:00.000Z",
      outreach: [{ at: "2026-07-04T00:00:00.000Z", channel: "dm", type: "manual", text: "hello", tpl: "tpl:t_intro" }] },
    "id:5": { userId: "5", username: "awaiting_read", profileUrl: "https://www.instagram.com/awaiting_read/",
      status: "Contacted", lastContactedAt: "2026-07-06T00:00:00.000Z",
      outreach: [{ at: "2026-07-06T00:00:00.000Z", channel: "dm", type: "batch", text: "hi", tpl: "obj:networking" }] },
    "id:6": { userId: "6", username: "replied_one", profileUrl: "https://www.instagram.com/replied_one/",
      status: "Replied", repliedAt: "2026-07-07T00:00:00.000Z", lastContactedAt: "2026-07-06T00:00:00.000Z",
      outreach: [{ at: "2026-07-06T00:00:00.000Z", channel: "dm", type: "manual", text: "yo", tpl: "tpl:t_intro" }] },
  },
};

// The container pins a Chromium build under PLAYWRIGHT_BROWSERS_PATH that may not
// match whatever `npm install playwright` just resolved, and `playwright install`
// is not available here. Point at the pinned binary when the bundled one is
// missing; fall back to the default so this also works on a normal machine.
const PINNED = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
                "/opt/pw-browsers/chromium/chrome-linux/chrome"];
let launchOpts = {};
for (const bin of PINNED) {
  if (existsSync(bin)) { launchOpts = { executablePath: bin }; break; }
}
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();

// Every error the page can produce, collected rather than sampled.
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console.error: " + m.text());
});
await page.addInitScript(CHROME_STUB(SEED));
await page.goto(base + "/src/sidepanel/panel.html", { waitUntil: "load" });
// boot() is async and unawaited; give the render chain a beat to finish or fail.
await page.waitForTimeout(900);

eq("the panel boots with no errors", errors, []);
eq("every resource panel.html asks for exists", missing, []);

// ---- the tab bar matches the funnel ----
// Four since 0.16.0: Shortlist, Outreach and Metrics merged into Pipeline, where
// the state lives on the row instead of in which tab you are looking at.
const tabs = await page.$$eval(".tab", (els) => els.map((e) => e.dataset.tab));
eq("four tabs, in funnel order", tabs,
  ["profile", "queue", "pipeline", "settings"]);

// ---- filters are built from one table, not hand-written twice ----
for (const prefix of ["q", "sl"]) {
  const ids = await page.$$eval(`#${prefix}-filters select, #${prefix}-filters input`,
    (els) => els.map((e) => e.id));
  eq(`${prefix} filter row is built`, ids, [
    `${prefix}-outlier`,
    `${prefix}-posts-min`, `${prefix}-posts-max`,
    `${prefix}-followers-min`, `${prefix}-followers-max`,
    `${prefix}-following-min`, `${prefix}-following-max`,
    `${prefix}-unknown`, `${prefix}-sort`,
  ]);
}
// The whole point of building them from one table: they cannot diverge.
const [qOpts, slOpts] = await Promise.all(["q", "sl"].map((p) =>
  page.$$eval(`#${p}-filters select`, (els) => els.map((e) => [...e.options].map((o) => o.value).join(",")))));
eq("Queue and Pipeline offer identical filters", qOpts, slOpts);

// ---- each tab renders ----
async function open(tab) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(350);
}

await open("queue");
eq("queue shows only queued leads",
  await page.$$eval("#queue-list .q-item .n", (els) => els.map((e) => e.textContent.trim()).sort()),
  ["@queued_one", "@queued_private"]);
// PUBLIC_ONLY_NOTE — a private account cannot be promoted, and the button says so
// rather than failing silently on click.
// The promote control is the ★ button since 0.16.0. Locate it by class, not by
// label — an icon has no words to match on, and matching on "★" would break the
// moment the glyph changes.
eq("the private lead cannot be shortlisted",
  await page.$$eval("#queue-list .q-item", (els) => {
    const row = els.find((e) => e.textContent.includes("queued_private"));
    return !!row.querySelector("button.star").disabled;
  }), true);
eq("the public lead can be shortlisted",
  await page.$$eval("#queue-list .q-item", (els) => {
    const row = els.find((e) => e.textContent.includes("queued_one"));
    return !row.querySelector("button.star").disabled;
  }), true);
// Batch send must not exist on the Queue — that is the funnel's whole point.
eq("the Queue has no send control",
  await page.$eval("#tab-queue", (el) => !!el.querySelector("#batch-send")), false);

// ---- bounds ----
// queued_one: 120 posts, 4.2k followers, follows 300. queued_private: no counts.
const rows = () => page.$$eval("#queue-list .q-item .n", (e) => e.map((n) => n.textContent.trim()).sort());
const setBound = async (id, v) => { await page.fill("#" + id, v); await page.waitForTimeout(420); };

// A lower bound alone.
await setBound("q-posts-min", "200");
eq("min 200 posts excludes a 120-post lead", await rows(), []);
eq("...and the count says how many are hidden",
  (await page.textContent("#queue-count")).includes("hidden by filter"), true);

// Bounds are INCLUSIVE at both ends — a range you typed should contain its edges.
await setBound("q-posts-min", "120");
eq("min is inclusive", await rows(), ["@queued_one"]);
await setBound("q-posts-min", "");
await setBound("q-posts-max", "120");
eq("max is inclusive", await rows(), ["@queued_one"]);
await setBound("q-posts-max", "119");
eq("max excludes just above it", await rows(), []);
await setBound("q-posts-max", "");

// k / m suffixes, because that is how follower counts are written everywhere.
await setBound("q-followers-min", "4k");
eq("4k parses as 4000 and matches 4200", await rows(), ["@queued_one"]);
await setBound("q-followers-min", "5k");
eq("5k excludes 4200", await rows(), []);
await setBound("q-followers-min", "1.5m");
eq("1.5m parses too", await rows(), []);
await setBound("q-followers-min", "");

// Both ends at once, on two fields — filters compose with AND.
await setBound("q-followers-min", "1k");
await setBound("q-followers-max", "10k");
await setBound("q-following-max", "500");
eq("a band on two fields", await rows(), ["@queued_one"]);
await setBound("q-following-max", "200");
eq("one failing field rejects the lead", await rows(), []);
await setBound("q-following-max", "");
await setBound("q-followers-min", "");
await setBound("q-followers-max", "");

// null is not zero: an un-enriched lead is excluded by ANY bound unless you ask
// for it. Without this, the queue looks empty right after a scan — when it is
// actually fullest.
await setBound("q-posts-min", "1");
eq("a bound excludes the un-enriched lead", await rows(), ["@queued_one"]);
await page.check("#q-unknown");
await page.waitForTimeout(350);
eq("incl. un-enriched brings it back", await rows(), ["@queued_one", "@queued_private"]);
await page.uncheck("#q-unknown");
await setBound("q-posts-min", "");

// Garbage in a bound is ignored rather than matching nothing — a half-typed value
// must not blank the list while you are still typing it.
await setBound("q-posts-min", "abc");
eq("an unparseable bound is inactive", await rows(), ["@queued_one", "@queued_private"]);
await setBound("q-posts-min", "");
eq("clearing every bound restores the list", await rows(), ["@queued_one", "@queued_private"]);

await open("pipeline");

// ---- the stat strip is the segment filter ----
// Each chip's number IS the list you get when you press it. If the strip and the
// list ever disagree, the number you are selling is not the number you can act on.
const strip = await page.$$eval("#pl-stats .pl-stat", (els) => els.map((e) => ({
  n: e.querySelector("b").textContent,
  label: e.querySelector("span:last-child").textContent,
})));
eq("four segments, in the order you act on them", strip.map((s) => s.label),
  ["to message", "awaiting read", "read · no reply", "replied"]);
// The three read-states are the product; a mis-bucketed lead here is a wrong
// follow-up sent to a real person.
eq("segment counts", strip.map((s) => s.n), ["1", "1", "1", "1"]);

// "to message" is the default segment, and it holds the vetted-but-unmessaged.
eq("pipeline opens on the vetted, not-yet-messaged leads",
  await page.$$eval("#pipeline-list .q-item .n", (els) => els.map((e) => e.textContent.trim())),
  ["@shortlisted_one"]);
eq("an un-messaged row shows ★ vetted and ☐ not sent",
  await page.$$eval("#pipeline-list .q-item .q-mark", (els) => els.map((e) => e.textContent)),
  ["★", "☐"]);
eq("the top-performing-reels panel is populated",
  await page.textContent("#sl-outlier-count"), "1");
eq("the 'to message' segment has the send control",
  await page.$eval("#batch-bar", (el) => el.style.display !== "none"), true);
eq("the Pipeline badge counts read-and-no-reply only",
  (await page.textContent("#tab-btn-pipeline")).replace(/\s+/g, " ").trim(), "Pipeline 1");

// Switching segment switches the list, and takes the batch bar away with it —
// bulk-sending to people already mid-conversation is not a thing you can do.
const seg = async (i) => {
  await page.click(`#pl-stats .pl-stat:nth-child(${i})`);
  await page.waitForTimeout(350);
};
await seg(3); // read · no reply
eq("the read segment shows the read lead",
  await page.$$eval("#pipeline-list .q-item .n", (els) => els.map((e) => e.textContent.trim())),
  ["@read_no_reply"]);
eq("a vetted-then-messaged row shows ★ ☑",
  await page.$$eval("#pipeline-list .q-item .q-mark", (els) => els.map((e) => e.textContent)),
  ["★", "☑"]);
// The star is DATA, not decoration: awaiting_read was DMed straight from the
// Profile tab and never shortlisted, so it must show a hollow star. If this ever
// reads ★, the mark is back to describing which segment the row is in.
await seg(2);
eq("messaged without ever being vetted shows ☆ ☑",
  await page.$$eval("#pipeline-list .q-item .q-mark", (els) => els.map((e) => e.textContent)),
  ["☆", "☑"]);
eq("no batch send outside 'to message'",
  await page.$eval("#batch-bar", (el) => el.style.display === "none"), true);
await seg(1);

eq("the message log counts events, not people",
  await page.textContent("#sent-log-count"), "3");

const metrics = await page.textContent("#metrics-body");
eq("metrics leads with read rate", metrics.includes("read rate"), true);
eq("metrics reports never-opened", metrics.includes("never opened"), true);
eq("metrics separates reply-of-read", metrics.includes("replied, of those who read"), true);
// byTemplate needs 2+ templates to be worth showing; the seed has two.
eq("metrics breaks down by first message", metrics.includes("By first message"), true);

await open("settings");
eq("the harvesting toggle is gone from Settings",
  await page.$("#flag-recorder"), null);
eq("the webhook is gone from Settings", await page.$("#wh-url"), null);
eq("the public-only toggle is gone", await page.$("#public-only"), null);
eq("the reset-counters button is gone", await page.$("#reset-usage"), null);
eq("shared lists are hidden",
  await page.$eval("#sharing-card", (el) => el.hidden), true);

// Nothing above may have introduced an error along the way.
eq("no errors after exercising every tab", errors, []);

await browser.close();
server.close();
report();
