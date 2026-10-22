// instagram.js's pure extractors, against saved Instagram HTML.
//
// WHY THIS EXISTS. Fourteen functions in the content script are pure
// (html | DOM) -> object, and between them they hold essentially every fragile
// assumption in the product: which JSON keys hold a user id, where a bio lives,
// how a grid tile's numbers are delimited. They had zero automated coverage,
// because the file is an IIFE with no exports and content scripts cannot be ES
// modules. instagram.js now ends with a guarded `module.exports` block — dead
// code in a browser — which is what lets this file require it.
//
// OPTIONAL BY DESIGN. This is the ONE suite with a dependency (jsdom), and the
// repo's test contract is "git clone && node tests/run.mjs, no install". So a
// missing jsdom SKIPS rather than fails, the same way the Firestore rules suite
// skips without the emulator. Turn it on with:
//
//     npm install --no-save jsdom
//
// FIXTURES. tests/fixtures/*.html are real serialized Instagram pages, captured
// with `window.__sprillDumpFixture()` in the content script's console. None are
// committed yet — the synthetic cases below run regardless and pin the specific
// defects that shipped in 0.11.0. Drop a real fixture in and the loop at the
// bottom picks it up.
//
// ⚠️ Scrub a fixture before committing it: a logged-in page contains your handle
// and whatever accounts Instagram put in your sidebar.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { eq, report } from "../helpers/assert.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const require_ = createRequire(import.meta.url);

let JSDOM;
try {
  ({ JSDOM } = require_("jsdom"));
} catch (_) {
  console.log("  skipped — jsdom not installed (npm install --no-save jsdom)");
  console.log("RESULT 0 0");
  process.exit(0);
}

/**
 * Load the content script against a given page and return its exports.
 *
 * NOT via require(). The repo's package.json is `"type": "module"`, so Node
 * treats every .js file in it as ESM — `module` would be undefined and the
 * export block at the bottom of instagram.js would never run. Evaluating the
 * source as a function body gives us real CJS semantics AND lets us inject the
 * DOM as parameters instead of polluting globalThis (Node 22 makes `navigator`
 * getter-only, so assigning to it throws anyway).
 *
 * The IIFE installs a chrome.runtime listener on its way out, so chrome is
 * stubbed. Everything passed in is read-only as far as the extractors care.
 */
const SRC = readFileSync(
  join(ROOT, "extension", "src", "content", "instagram.js"), "utf8");

const INJECT = [
  "module", "exports", "window", "document", "location", "navigator",
  "chrome", "getComputedStyle", "MutationObserver", "URL", "Node",
  "KeyboardEvent", "InputEvent", "Event",
];
const compiled = new Function(...INJECT, SRC);

function load(html, url) {
  const { window: w } = new JSDOM(html, { url, pretendToBeVisual: true });
  const noop = () => {};
  const m = { exports: {} };
  compiled(
    m, m.exports, w, w.document, w.location, w.navigator,
    { runtime: { id: "test", sendMessage: noop, onMessage: { addListener: noop } } },
    w.getComputedStyle.bind(w), w.MutationObserver, w.URL, w.Node,
    w.KeyboardEvent, w.InputEvent, w.Event,
  );
  if (!m.exports.pageType) {
    throw new Error(
      "instagram.js exported nothing — the guarded module.exports block at the " +
      "bottom of the file is the test seam. Don't remove it.");
  }
  // Handed back so assertions can query the same DOM the extractors saw.
  m.exports.__window = w;
  return m.exports;
}

const page = (body, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

// ---------------------------------------------------------------------------
// pageType / mediaFromPath — pure URL logic, no DOM needed
// ---------------------------------------------------------------------------
{
  const at = (url) => load(page(""), url).pageType();
  eq("root is home", at("https://www.instagram.com/"), "home");
  eq("explore", at("https://www.instagram.com/explore/"), "explore");
  eq("direct", at("https://www.instagram.com/direct/t/123/"), "direct");
  eq("a handle is a profile", at("https://www.instagram.com/alice/"), "profile");
  // The ordering trap: "p" and "reel" are IN the RESERVED set because that set
  // doubles as the handle blacklist, so the mediaFromPath check MUST sit above
  // the RESERVED check. One reorder turns every post page into "other" — and
  // turns "p" and "reel" into prospect handles.
  eq("/p/ is a post", at("https://www.instagram.com/p/CxYz123/"), "post");
  eq("/reel/ is a post", at("https://www.instagram.com/reel/CxYz123/"), "post");
  eq("/{user}/p/{code}/ is a post", at("https://www.instagram.com/alice/p/CxYz123/"), "post");
  // ...but the profile's reels TAB is not a post — it is that person's PROFILE.
  // Singular "reel" is a permalink, plural "reels" is the grid. Collapsing the
  // two would either break every reel permalink or turn every reels grid into a
  // post page.
  eq("the reels tab is the profile", at("https://www.instagram.com/alice/reels/"), "profile");
  eq("the tagged tab is the profile", at("https://www.instagram.com/alice/tagged/"), "profile");
  eq("the followers list is the profile", at("https://www.instagram.com/alice/followers/"), "profile");
  // A second segment that is NOT a known profile tab stays "other" — we are not
  // going to treat any two-segment URL as a profile and start capturing garbage.
  eq("an unknown second segment is not a profile",
    at("https://www.instagram.com/alice/somethingelse/"), "other");
  eq("a reserved route is not a profile", at("https://www.instagram.com/legal/"), "other");
}

// The handle must come from segment 0, not from the sub-tab name.
{
  const html = page('<header><h1>Alice</h1><span dir="auto">Founder of Acme</span></header>',
    '<meta property="og:title" content="Alice (@alice) • Instagram" />');
  const p = load(html, "https://www.instagram.com/alice/reels/").extractCurrentProfile();
  eq("a reels tab yields the profile, not null", p !== null, true);
  eq("...with the right handle", p.username, "alice");
  eq("...and the bio still reads", p.bio, "Founder of Acme");
}

// ---------------------------------------------------------------------------
// extractUserId — anchored patterns must beat unanchored ones
// ---------------------------------------------------------------------------
// THE DEFECT (fixed 0.12.0): the four unanchored patterns ran FIRST, so on a
// logged-in page they could return the viewer's id instead of the target's. That
// was silent data corruption, not a display bug: records key on user id, so two
// prospects that both mined the viewer's id collapse into one record and the
// second capture overwrites the first — outreach log included.
{
  // The viewer's id appears first in the document, in an unanchored shape.
  // The target's id appears later, anchored to their handle.
  const html = page("", `<script type="application/json">
    {"viewer":{"id":"111111111","username":"me"},"user_id":"111111111"}
  </script>`) .replace("</body>", `<script type="application/json">
    {"username":"alice","id":"999999999"}
  </script></body>`);
  const ig = load(html, "https://www.instagram.com/alice/");
  eq("the target's id wins over the viewer's", ig.extractUserId("alice"), "999999999");
  // With no handle to anchor on there is nothing better to do than guess, and
  // guessing is what the unanchored patterns are for.
  eq("falls back to unanchored when there is no handle", ig.extractUserId(""), "111111111");
}

// ---------------------------------------------------------------------------
// extractBio — must not widen its scope to the whole page
// ---------------------------------------------------------------------------
// THE DEFECT (fixed 0.12.0): extractCurrentProfile did
// `document.querySelector("header") || document.body`, so a page with no header
// yielded the longest span ON THE ENTIRE PAGE as the "bio" — a suggested-user
// blurb, a cookie banner. It was then scored, mined for business signals, and
// interpolated into the DM the prospect read.
{
  const withHeader = page(`
    <header>
      <h1>Alice</h1>
      <span dir="auto">Founder of Acme. DM for collabs.</span>
      <span dir="auto">5,000 Followers</span>
    </header>
    <aside><span dir="auto">${"x".repeat(300)} suggested for you</span></aside>`);
  const ig = load(withHeader, "https://www.instagram.com/alice/");
  const hdr = ig.__window.document.querySelector("header");
  eq("bio comes from the header", ig.extractBio(hdr), "Founder of Acme. DM for collabs.");
  eq("count strings are rejected as bio candidates",
    ig.extractBio(hdr).includes("Followers"), false);
  eq("a null header yields an empty bio, not the page", ig.extractBio(null), "");

  // The real assertion: with no header at all, the whole profile must fail the
  // sanity gate rather than producing a plausible-looking record.
  const noHeader = page(`<aside><span dir="auto">${"y".repeat(300)}</span></aside>`,
    `<meta property="og:title" content="Alice (@alice) • Instagram" />`);
  const ig2 = load(noHeader, "https://www.instagram.com/alice/");
  const prof = ig2.extractCurrentProfile();
  eq("no header means no bio", prof.bio, "");
  eq("no header means not verified", prof.verified, false);
}

// ---------------------------------------------------------------------------
// extractCurrentProfile — the og: tags, which are the stable-ish signals
// ---------------------------------------------------------------------------
{
  const html = page(`<header><h1>Alice Anderson</h1>
      <span dir="auto">Marketing consultant. DM for collabs — hello@acme.com</span>
      <a href="https://l.instagram.com/?u=https%3A%2F%2Flinktr.ee%2Falice&amp;e=1">linktr.ee/alice</a>
    </header>`,
    `<meta property="og:title" content="Alice Anderson (@alice) • Instagram photos and videos" />
     <meta property="og:description" content="5,432 Followers, 312 Following, 88 Posts - See Instagram photos and videos from Alice Anderson (@alice)" />`);
  const ig = load(html, "https://www.instagram.com/alice/");
  const p = ig.extractCurrentProfile();
  eq("username from the URL", p.username, "alice");
  eq("display name from og:title", p.displayName, "Alice Anderson");
  eq("followers from og:description", p.followers, 5432);
  eq("following from og:description", p.following, 312);
  eq("posts from og:description", p.posts, 88);
  eq("email extracted from the bio", p.emails, ["hello@acme.com"]);
  // The l.instagram.com shim must be unwrapped, or every link-in-bio is stored
  // as an Instagram URL and the link-in-bio detector never fires.
  eq("the link shim is decoded", p.links, ["https://linktr.ee/alice"]);
  eq("link-in-bio is the resolved URL, not a flag", p.linkInBio, "https://linktr.ee/alice");
  eq("a business signal was found", p.businessSignals.length > 0, true);
  eq("...and it is the DM-for-collabs phrase, not the email",
    p.businessSignals.some((x) => /collab/i.test(x)), true);
}

// ---------------------------------------------------------------------------
// extractVisibleProfiles — single-segment links only, minus the blacklist
// ---------------------------------------------------------------------------
{
  const html = page(`<main>
    <a href="/alice/">Alice</a>
    <a href="/bob/">Bob</a>
    <a href="/explore/">Explore</a>
    <a href="/legal/">Legal</a>
    <a href="/p/CxYz123/">a post</a>
    <a href="/alice/reels/">two segments</a>
    <a href="https://example.com/carol/">offsite</a>
  </main>`);
  const ig = load(html, "https://www.instagram.com/explore/people/");
  const found = ig.extractVisibleProfiles(60).map((r) => r.username).sort();
  eq("only real single-segment handles", found, ["alice", "bob"]);
  // The `known` set is checked BEFORE any text read, because innerText forces a
  // layout flush and the recorder calls this every 1.5s against a list where most
  // handles are already known.
  eq("a known handle is skipped",
    ig.extractVisibleProfiles(60, new Set(["alice"])).map((r) => r.username), ["bob"]);
  eq("the limit is respected", ig.extractVisibleProfiles(1).length, 1);
}

// ---------------------------------------------------------------------------
// parseCount / parseCountStrict
// ---------------------------------------------------------------------------
{
  const ig = load(page(""), "https://www.instagram.com/");
  eq("plain", ig.parseCount("1,234"), 1234);
  eq("thousands", ig.parseCount("15K"), 15000);
  eq("millions", ig.parseCount("2.3M"), 2300000);
  // parseCountStrict exists because parseCount returns a plausible-but-wrong
  // answer for junk, and the grid miner would rather store nothing than a lie.
  eq("strict rejects junk", ig.parseCountStrict("about 12 hours ago"), null);
  eq("strict accepts a clean count", ig.parseCountStrict("15K"), 15000);
}

// ---------------------------------------------------------------------------
// Real fixtures, when present
// ---------------------------------------------------------------------------
// Nothing here asserts a specific number — a fixture is someone's real profile
// and those change. It asserts the INVARIANTS: a profile fixture must yield a
// scorable profile, and a login-wall fixture must NOT.
const FIX = join(ROOT, "tests", "fixtures");
if (existsSync(FIX)) {
  for (const f of readdirSync(FIX).filter((n) => n.endsWith(".html"))) {
    const html = readFileSync(join(FIX, f), "utf8");
    // Convention: <name>.<pagetype>.<expected-username>.html
    const [name, kind, expect] = f.replace(/\.html$/, "").split(".");
    const url = kind === "explore"
      ? "https://www.instagram.com/explore/"
      : `https://www.instagram.com/${expect || name}/`;
    const ig = load(html, url);
    if (kind === "profile") {
      const p = ig.extractCurrentProfile();
      eq(`[${f}] handle matches`, p.username, expect || name);
      eq(`[${f}] yields something scorable`,
        !!(p.bio || p.category || p.followers != null), true);
    } else if (kind === "loginwall") {
      const p = ig.extractCurrentProfile();
      // The point of this fixture: a page that LOOKS like a profile URL but has
      // no profile in it must not produce a record enrich would trust.
      eq(`[${f}] yields nothing scorable`,
        !!(p.bio || p.category || p.followers != null), false);
    } else if (kind === "explore") {
      // NOT "tiles resolve to authors" any more. Since 0.18.0 that costs a
      // network round-trip per tile and lives in scanVisibleProfiles(); the
      // synchronous path deliberately returns nothing on Explore, so the old
      // `.length > 0` assertion would go red the moment a real fixture landed.
      // Resolution is covered by embed.test.mjs, which actually runs.
      //
      // The invariant worth pinning HERE is the 0.11.0 defect: before it, an
      // Explore scan silently returned nav-rail and sidebar links while still
      // stamping sourceType "explore", so it looked like it worked. Whatever
      // the sync path yields on Explore, none of it may be site chrome.
      const junk = ig.extractVisibleProfiles(60)
        .filter((p) => !/^\/p\//.test(p.profileUrl))
        .map((p) => p.username.toLowerCase())
        .filter((u) => ["explore", "reels", "direct", "accounts", "about",
                        "legal", "privacy", "terms", "instagram"].includes(u));
      eq(`[${f}] explore scan returns no nav-rail junk`, junk, []);
    }
  }
} else {
  console.log("  (no tests/fixtures/*.html yet — run window.__sprillDumpFixture() to add one)");
}

report();
