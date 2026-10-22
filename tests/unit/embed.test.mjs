// Explore tile -> author, via the post's public embed page. (0.18.0)
//
// WHY THIS IS A SEPARATE, ZERO-DEPENDENCY SUITE. The obvious home for these
// assertions is extract.test.mjs, next to the other content-script parsers. But
// that suite needs jsdom, and jsdom is not installed here — it reports
// `skipped` on every run of this repo. Putting the newest and most fragile code
// in the build behind a suite that does not execute is how 0.11.0's Explore path
// shipped broken and stayed broken for six releases.
//
// So: no jsdom, no install, always runs. tests/helpers/content-stub.mjs explains
// how that is possible.
//
// WHAT THIS GUARDS. parseEmbed decides which Instagram account a DM gets sent
// to. A false positive here does not produce a bad row in a table — it produces
// a cold DM to a stranger, from the user's own account, under their name. Every
// ambiguous case below is therefore asserted to return null rather than a
// best guess, and the negative cases outnumber the positive ones on purpose.

import { eq, report } from "../helpers/assert.mjs";
import { loadContentScript, fakeFetch, embedHtml } from "../helpers/content-stub.mjs";

const ig = loadContentScript({ url: "https://www.instagram.com/explore/" });
const P = ig.parseEmbed;

// ---------------------------------------------------------------------------
// parseEmbed — the happy paths
// ---------------------------------------------------------------------------

eq("reads the handle from UsernameText",
  P(embedHtml({ username: "thebami_" })).username, "thebami_");

eq("verified false when no badge",
  P(embedHtml({ username: "thebami_" })).verified, false);

eq("verified true when the badge is present",
  P(embedHtml({ username: "thebami_", verified: true })).verified, true);

// ---------------------------------------------------------------------------
// The verified badge, against the markup Instagram ACTUALLY sends
// ---------------------------------------------------------------------------
// This block exists because the first version of it was wrong in a way the test
// suite could not see. The code looked for `VerifiedBadge`; so did the fixture
// generator; the assertions passed; and the feature never detected a verified
// account, because no such class exists in Instagram's output. The test and the
// code agreed with each other and both were wrong about the world.
//
// The literal below is copied verbatim from a live response for a post by
// @nasa on 15 Aug 2026 — public embed markup, no session data. An unverified
// account's response was checked the same way and contains the string
// "Verified" ZERO times, which is what makes this a clean signal.
const REAL_VERIFIED =
  '<span class="UsernameText">nasa</span>' +
  '<i class="Sprite VerifiedSprite img sp_qYtR2jXevE_ sx_eee86e"><u>Verified</u></i>';

eq("the real VerifiedSprite markup is detected", P(REAL_VERIFIED).verified, true);
eq("...and the handle still reads", P(REAL_VERIFIED).username, "nasa");
eq("the invented 'VerifiedBadge' class must NOT be what we key on",
  P('<span class="UsernameText">nasa</span><span class="VerifiedBadge"></span>').verified, false);

// Anchored to a class attribute so a caption can't claim a badge. The embed
// carries the post's caption text, and /embed/captioned/ carries more of it.
eq("the word 'Verified' in a caption does not confer a badge",
  P('<span class="UsernameText">a_b</span><div class="Caption">Verified best seller</div>').verified,
  false);
eq("nor does a bare VerifiedSprite mention outside a class attribute",
  P('<span class="UsernameText">a_b</span><div class="Caption">VerifiedSprite</div>').verified,
  false);

eq("falls back to the canonical profile href",
  P('<a href="https://www.instagram.com/bm_social_/?utm_source=ig_embed">x</a>').username,
  "bm_social_");

eq("handles with dots and underscores survive",
  P(embedHtml({ username: "thecreative.social" })).username, "thecreative.social");

// ---------------------------------------------------------------------------
// parseEmbed — follower counts, and the 1000x trap
//
// parseCount("175K followers") returns 175: its anchored regex rejects the
// trailing word and falls through to parseInt on the digits. Shipping that would
// have divided every Explore lead's reach by a thousand, silently, and the score
// would still have looked plausible. parseCountStrict exists for exactly this.
// ---------------------------------------------------------------------------

eq("175K followers -> 175000, NEVER 175",
  P(embedHtml({ username: "a_b", followers: "175K followers" })).followers, 175000);

eq("23.1K followers -> 23100",
  P(embedHtml({ username: "a_b", followers: "23.1K followers" })).followers, 23100);

eq("1,234 followers -> 1234",
  P(embedHtml({ username: "a_b", followers: "1,234 followers" })).followers, 1234);

eq("2.3M followers -> 2300000",
  P(embedHtml({ username: "a_b", followers: "2.3M followers" })).followers, 2300000);

// The key must be ABSENT, not null and not 0. saveProspect() spreads whatever
// keys it is handed, so a 0 here would persist as a fact, survive into the CSV
// export, and suppress score.js's thin-data concern on the very leads that most
// need enriching.
eq("no FollowerCountText -> the key is absent entirely",
  "followers" in P(embedHtml({ username: "a_b" })), false);

eq("...and the username still comes back",
  P(embedHtml({ username: "a_b" })).username, "a_b");

eq("unparseable count ('a few followers') -> absent, not 0",
  "followers" in P(embedHtml({ username: "a_b", followers: "a few followers" })), false);

eq("zero is readable and is not confused with absent",
  P(embedHtml({ username: "a_b", followers: "0 followers" })).followers, 0);

// ---------------------------------------------------------------------------
// parseEmbed — the negatives. These are the ones that matter.
// ---------------------------------------------------------------------------

// Measured live: 1 of 8 real shortcodes came back HTTP 200 with no UsernameText
// at all (~210 KB body — a deleted or restricted post). That is a normal
// outcome, not an error, and it must read as a miss.
eq("200 with no author anywhere -> null (the measured 1-in-8 case)",
  P("<html><body><div class=EmbedFrame>Sorry, this page isn't available.</div></body></html>"),
  null);

eq("UsernameText and the canonical href disagreeing -> null, not a coin toss",
  P('<span class="UsernameText">alice</span>' +
    '<a href="https://www.instagram.com/bob/?utm_source=ig_embed"></a>'), null);

eq("same handle in both places is fine",
  P('<span class="UsernameText">alice</span>' +
    '<a href="https://www.instagram.com/alice/?utm_source=ig_embed"></a>').username, "alice");

eq("a RESERVED route in UsernameText -> null",
  P('<span class="UsernameText">explore</span>'), null);

eq("another RESERVED route -> null",
  P('<span class="UsernameText">accounts</span>'), null);

eq("illegal characters -> null",
  P('<span class="UsernameText">not a handle</span>'), null);

eq("an HTML entity we don't decode -> null, never half-decoded",
  P('<span class="UsernameText">a&amp;b</span>'), null);

eq("empty string -> null", P(""), null);
eq("null input -> null", P(null), null);
eq("non-string input -> null", P({ username: "x" }), null);

// The body arrives over the network and can be cut off mid-flight.
eq("truncated html does not throw",
  P(embedHtml({ username: "thebami_" }).slice(0, 120)) === null ||
  typeof P(embedHtml({ username: "thebami_" }).slice(0, 120)) === "object", true);

// ---------------------------------------------------------------------------
// embedUrl — reject bad shortcodes BEFORE spending a request
// ---------------------------------------------------------------------------

eq("builds the captioned embed url", ig.embedUrl("Da2kbVtjFvm"),
  "/p/Da2kbVtjFvm/embed/captioned/");

eq("a reel's shortcode uses the same /p/ path", ig.embedUrl("Db2RmHXAe-N"),
  "/p/Db2RmHXAe-N/embed/captioned/");

eq("rejects a shortcode with a slash", ig.embedUrl("abc/../../evil"), null);
eq("rejects an empty shortcode", ig.embedUrl(""), null);
eq("rejects a too-short shortcode", ig.embedUrl("ab"), null);

// ---------------------------------------------------------------------------
// pickUnresolved — the derived backlog
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const MISS_TTL = 600000;

{
  const cache = new Map([
    ["hit1", { username: "a", at: NOW }],
    ["miss1", { miss: true, at: NOW }],                 // fresh miss
    ["miss2", { miss: true, at: NOW - MISS_TTL - 1 }],  // stale miss
  ]);
  const codes = ["hit1", "miss1", "miss2", "new1", "new2"];

  eq("skips resolved and fresh misses, retries stale ones, keeps DOM order",
    ig.pickUnresolved(codes, cache, NOW, 10), ["miss2", "new1", "new2"]);

  eq("respects the budget",
    ig.pickUnresolved(codes, cache, NOW, 2), ["miss2", "new1"]);

  eq("a budget of zero asks for nothing",
    ig.pickUnresolved(codes, cache, NOW, 0), []);

  eq("dedupes repeated shortcodes in the DOM",
    ig.pickUnresolved(["new1", "new1", "new2"], new Map(), NOW, 10), ["new1", "new2"]);

  eq("an empty cache returns the first `max`",
    ig.pickUnresolved(codes, new Map(), NOW, 3), ["hit1", "miss1", "miss2"]);
}

// ---------------------------------------------------------------------------
// canDrainTiles — the recorder gate
//
// Condition 1 is the whole safety argument: `emptyTicks >= IDLE_AFTER` is the
// same variable recSchedule() reads to choose the 4s interval, so a drain
// cannot occur on a 1.5s hot tick by construction rather than by intent.
// ---------------------------------------------------------------------------

const GATE = {
  active: true, page: "explore", emptyTicks: 5, visible: true,
  busy: false, now: NOW, cooldownUntil: 0, used: 0,
};

eq("all conditions met -> drain allowed", ig.canDrainTiles(GATE), true);
eq("hot tick (emptyTicks below IDLE_AFTER) -> never",
  ig.canDrainTiles({ ...GATE, emptyTicks: 4 }), false);
eq("no active session -> never", ig.canDrainTiles({ ...GATE, active: false }), false);
eq("off Explore -> never", ig.canDrainTiles({ ...GATE, page: "profile" }), false);
eq("background tab -> never", ig.canDrainTiles({ ...GATE, visible: false }), false);
eq("another fetch in flight -> never", ig.canDrainTiles({ ...GATE, busy: true }), false);
eq("inside the cooldown -> never",
  ig.canDrainTiles({ ...GATE, cooldownUntil: NOW + 1000 }), false);
eq("session budget spent -> never", ig.canDrainTiles({ ...GATE, used: 60 }), false);

// ---------------------------------------------------------------------------
// fetchEmbedAuthor — against an injected fetch. No network in this suite.
// ---------------------------------------------------------------------------

{
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "bm_social_", followers: "23.1K followers" }) });
  const igf = loadContentScript({ url: "https://www.instagram.com/explore/", fetch: f });
  const got = await igf.fetchEmbedAuthor("Da2kbVtjFvm");

  eq("200 -> the parsed record", got, { username: "bm_social_", verified: false, followers: 23100 });
  eq("hits the captioned embed url", f.calls[0].url, "/p/Da2kbVtjFvm/embed/captioned/");

  // THE assertion of this file. credentials:"omit" is what keeps a dozen
  // automated requests off the user's logged-in Instagram session. A future
  // tidy-up to "include" or a dropped init object would attach their cookies to
  // every one of them, and nothing else in the codebase would notice.
  eq("sends credentials:'omit' — never the user's session",
    f.calls[0].init.credentials, "omit");
}

{
  const f = fakeFetch({ status: 404, body: "" });
  const igf = loadContentScript({ fetch: f });
  eq("404 -> null", await igf.fetchEmbedAuthor("Da2kbVtjFvm"), null);
}

{
  const f = fakeFetch({ status: 200, body: "<html><body>nothing useful</body></html>" });
  const igf = loadContentScript({ fetch: f });
  eq("200 with no author -> null", await igf.fetchEmbedAuthor("Da2kbVtjFvm"), null);
}

{
  // No retries, deliberately. Retrying into a rate limiter, on the user's own
  // IP, against their own Instagram account, is the thing most likely to get
  // them limited — so a 429 must cost exactly one request and then stop.
  const f = fakeFetch({ status: 429, body: "" });
  const igf = loadContentScript({ fetch: f });
  const got = await igf.fetchEmbedAuthor("Da2kbVtjFvm");
  eq("429 -> null", got, null);
  eq("429 is NOT retried — exactly one request", f.calls.length, 1);
  eq("429 arms the cooldown", igf.__embedState().cooldownUntil > Date.now(), true);
}

{
  const f = fakeFetch({ status: 500, body: "" });
  const igf = loadContentScript({ fetch: f });
  eq("500 -> null", await igf.fetchEmbedAuthor("Da2kbVtjFvm"), null);
  eq("500 is not retried either", f.calls.length, 1);
  eq("500 does NOT arm the cooldown (it isn't a rate limit)",
    igf.__embedState().cooldownUntil, 0);
}

{
  const f = fakeFetch(new Error("network down"));
  const igf = loadContentScript({ fetch: f });
  eq("a thrown fetch is a miss, not a crash", await igf.fetchEmbedAuthor("Da2kbVtjFvm"), null);
}

{
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "a_b" }) });
  const igf = loadContentScript({ fetch: f });
  eq("a bad shortcode never reaches the network", await igf.fetchEmbedAuthor("../evil"), null);
  eq("...and made no request", f.calls.length, 0);
}

// ---------------------------------------------------------------------------
// scanVisibleProfiles — the async wrapper, end to end against stub anchors
// ---------------------------------------------------------------------------

{
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "digitalglowsolutions" }) });
  const igf = loadContentScript({
    url: "https://www.instagram.com/explore/search/keyword/?q=social%20media%20manager",
    anchors: ["/p/C74eR8-NL3g/", "/p/C9ntC1jSr65/"],
    fetch: f,
  });
  const r = await igf.scanVisibleProfiles(60, { resolve: 1 });

  eq("counts the tiles it saw", r.tiles, 2);
  eq("resolves up to the budget and no further", f.calls.length, 1);
  eq("reports the remainder as pending rather than dropping it", r.pending, 1);
  eq("returns the resolved author", r.profiles.map((p) => p.username), ["digitalglowsolutions"]);
  eq("stamps sourceType explore", r.profiles[0].sourceType, "explore");
  eq("stamps the query-bearing url as provenance",
    /q=social%20media%20manager/.test(r.profiles[0].sourceUrl), true);
  eq("tags how it was found", r.profiles[0].via, "tile");
}

{
  // The default budget is 0, so every caller that doesn't ask for resolution
  // keeps the old zero-network behaviour. This is what keeps the home feed, a
  // profile grid and the recorder's own path off the network.
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "a_b" }) });
  const igf = loadContentScript({
    url: "https://www.instagram.com/explore/",
    anchors: ["/p/C74eR8-NL3g/"],
    fetch: f,
  });
  const r = await igf.scanVisibleProfiles(60, {});
  eq("no budget -> no requests at all", f.calls.length, 0);
  eq("...but the tile count is still reported", r.tiles, 1);
}

{
  // Off Explore, tile resolution must not run even with a budget: on a profile
  // grid every tile belongs to the account you are already looking at.
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "a_b" }) });
  const igf = loadContentScript({
    url: "https://www.instagram.com/someone/",
    anchors: ["/p/C74eR8-NL3g/"],
    fetch: f,
  });
  await igf.scanVisibleProfiles(60, { resolve: 12 });
  eq("a profile grid never resolves tiles", f.calls.length, 0);
}

{
  // The href prefix, when Instagram emits it, is free and exact — paying a
  // 260 KB fetch for a handle already sitting in the href would be silly.
  const f = fakeFetch({ status: 200, body: embedHtml({ username: "wrong_one" }) });
  const igf = loadContentScript({
    url: "https://www.instagram.com/explore/",
    anchors: ["/realauthor/p/C74eR8-NL3g/"],
    fetch: f,
  });
  const r = await igf.scanVisibleProfiles(60, { resolve: 12 });
  eq("an author in the href is used directly", r.profiles.map((p) => p.username), ["realauthor"]);
  eq("...and costs no request", f.calls.length, 0);
}

report();
