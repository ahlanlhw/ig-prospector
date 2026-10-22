// Load instagram.js with NO jsdom, for testing the parts that aren't DOM work.
//
// WHY A SECOND HARNESS. tests/unit/extract.test.mjs already compiles the content
// script, but it needs jsdom and therefore SKIPS on a clean checkout — which is
// where this repo's test contract puts it: "git clone && node tests/run.mjs, no
// install". That is the right trade for the DOM extractors. It is the wrong
// trade for the embed resolver, which is the newest and most fragile code in the
// build and whose failure mode is a wrong Instagram handle in a DM.
//
// The embed parser is a pure (string) -> object function. It touches no DOM at
// all. So it does not need jsdom — it needs the IIFE to survive `new Function`,
// which takes about ten lines of stubs, because the script only reaches for a
// handful of globals at load time:
//
//   - location.pathname/href    the closing console.debug calls pageType()
//   - document/window .addEventListener, document.querySelector*
//   - chrome.runtime.sendMessage  via recBoot()
//   - MutationObserver          only constructed inside recArm(), never at load
//
// Everything else runs lazily, inside functions the test calls by hand.
//
// TWO TRAPS worth naming, both of which cost a debugging session if you hit them
// cold:
//
//  1. `fetch` MUST be injected. It goes in the parameter list rather than onto
//     globalThis so the source needs no injection seam of its own, and so two
//     suites can hold different fakes at once without stepping on each other.
//  2. recBoot()'s sendMessage callback MUST be invoked. If the stub never calls
//     back, `recBoot` sits on an unresolved promise; if it calls back with a
//     session, recArm() schedules a real setTimeout and the process either hangs
//     or fires a tick mid-assertion. Answering `null` makes it disarm cleanly.
//     Suites using this must still end with report(), which exits explicitly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const SRC = readFileSync(join(ROOT, "extension", "src", "content", "instagram.js"), "utf8");

// Same technique as extract.test.mjs:62-67. package.json is `"type": "module"`,
// so require() would leave `module` undefined and the export block at the bottom
// of instagram.js would never run.
const INJECT = [
  "module", "exports", "window", "document", "location", "navigator",
  "chrome", "getComputedStyle", "MutationObserver", "URL", "Node",
  "KeyboardEvent", "InputEvent", "Event",
  "fetch",                       // <- the addition that makes this suite possible
];
const compiled = new Function(...INJECT, SRC);

const noop = () => {};

/** Minimal stand-in for the handful of DOM calls the IIFE makes at load time. */
function stubDocument(anchors = []) {
  const nodes = anchors.map((href) => ({
    getAttribute: (k) => (k === "href" ? href : null),
    textContent: "",
    innerText: "",
    querySelectorAll: () => [],
    querySelector: () => null,
  }));
  return {
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    // Every selector the content script uses for tiles is an anchor selector,
    // and the anchor list is exactly what these tests want to control.
    querySelectorAll: (sel) => (/a\[href/.test(sel) ? nodes : []),
    documentElement: { innerHTML: "" },
    body: { innerText: "" },
    visibilityState: "visible",
  };
}

/**
 * Compile the content script against stubs and hand back its export seam.
 *
 * @param {object}   opts
 * @param {string}   opts.url      location.href to pretend we are on
 * @param {string[]} opts.anchors  hrefs that querySelectorAll('a[href…]') returns
 * @param {Function} opts.fetch    the fake fetch
 * @returns the module.exports object, plus __window for poking at state
 */
export function loadContentScript(opts = {}) {
  const url = opts.url || "https://www.instagram.com/explore/";
  const u = new URL(url);
  const doc = stubDocument(opts.anchors || []);
  const win = {
    addEventListener: noop,
    removeEventListener: noop,
    innerHeight: 900,
    location: u,
  };
  const loc = {
    href: u.href, pathname: u.pathname, search: u.search,
    hostname: u.hostname, origin: u.origin,
  };
  const m = { exports: {} };

  compiled(
    m, m.exports, win, doc, loc, { userAgent: "test" },
    {
      runtime: {
        id: "test",
        // Answer null so recBoot() disarms instead of scheduling a live timer.
        sendMessage: (_msg, cb) => { if (typeof cb === "function") cb(null); },
        onMessage: { addListener: noop },
        lastError: null,
      },
    },
    () => ({}), function MutationObserverStub() { this.observe = noop; this.disconnect = noop; },
    URL, class NodeStub {}, class KeyboardEventStub {}, class InputEventStub {}, class EventStub {},
    opts.fetch || (async () => { throw new Error("no fetch injected"); }),
  );

  if (!m.exports.parseEmbed) {
    throw new Error(
      "instagram.js exported no parseEmbed — the guarded module.exports block at " +
      "the bottom of the file is the test seam. Don't remove it.");
  }
  m.exports.__window = win;
  m.exports.__document = doc;
  return m.exports;
}

/** A fake fetch that replays a scripted list of responses and records its calls. */
export function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? responses.slice() : [responses];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(url, init);
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body || "",
    };
  };
  fn.calls = calls;
  return fn;
}

/**
 * Build an embed response body.
 *
 * The markup here is copied from REAL responses, not invented — that distinction
 * cost a bug. The verified badge was originally written as `VerifiedBadge`,
 * which appears nowhere in Instagram's output; both the code and this generator
 * used the made-up name, so the tests passed while the feature never once
 * detected a verified account. Checked live against @nasa (verified) and an
 * ordinary creator (not): the real markup is a `Sprite VerifiedSprite` class on
 * an <i>, and an unverified response contains the string "Verified" zero times.
 *
 * If you change anything in here, change it because you saw it in a real
 * response — see tests/fixtures/embed/ for two captured ones.
 */
export function embedHtml({ username, followers, verified } = {}) {
  return [
    '<!doctype html><html><body><div class="EmbedFrame">',
    '<div class="Header">',
    username ? `<a href="https://www.instagram.com/${username}/?utm_source=ig_embed"` +
               ` class="Avatar"></a><span class="UsernameText">${username}</span>` : "",
    verified ? '<i class="Sprite VerifiedSprite img sp_qYtR2jXevE_ sx_eee86e"><u>Verified</u></i>' : "",
    followers ? `<span class="FollowerCountText">${followers}</span>` : "",
    "</div></div></body></html>",
  ].join("");
}
