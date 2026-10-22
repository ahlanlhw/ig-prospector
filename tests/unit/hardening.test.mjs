// The 0.12.0 hardening pass, in assertions.
//
// Every test in here pins a specific defect that shipped in 0.11.0 and could not
// be caught by the existing suites. Each block names the failure it prevents,
// because a test whose purpose is forgotten gets "fixed" by deleting it.
//
// Deliberately NOT covered here (needs a browser, see TESTING.md):
//   • findComposer()'s scope change and sendInThread()'s DM-thread guard
//   • postComment()'s comment_uncertain third state
//   • readThreadStatus()'s thread-pane scoping
// Those live in instagram.js, which is a classic script with no exports.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

const stub = installChromeStub({
  seed: {
    prospects: {
      "id:1": {
        userId: "1", username: "alice", bio: "Founder of Acme, DM for collabs",
        followers: 5000, category: "Marketing agency", score: 87,
        status: "Contacted", emails: ["a@acme.com"], links: ["https://acme.com"],
      },
    },
  },
});

const store = await import("../../extension/src/shared/store.js");
const { csvValue, csvField, parseCsv, mapCsvRows, JSON_FIELDS } = await import("../../extension/src/shared/csv.js");

// ---------------------------------------------------------------------------
// 1. mergeEnrichment — a degraded scrape must not blank good data
// ---------------------------------------------------------------------------
// The defect: enrichList() spread a fresh scrape over the stored record. When
// Instagram served a login wall or a rate-limit interstitial at a profile URL,
// extractCurrentProfile() still returned a fully-shaped object with null counts
// and empty arrays — and all of it overwrote the truth. Self-concealing, because
// the fabricated bio made the record look enriched so it was never retried.

await store.mergeEnrichment({ username: "alice" }, {
  bio: "", followers: null, category: undefined,
  emails: [], links: [], displayName: "Alice A.",
});
let alice = (await store.getProspects())["id:1"];
eq("empty string does not blank a bio", alice.bio, "Founder of Acme, DM for collabs");
eq("null does not blank a follower count", alice.followers, 5000);
eq("undefined does not blank a category", alice.category, "Marketing agency");
eq("empty array does not blank emails", alice.emails, ["a@acme.com"]);
eq("a real new value IS written", alice.displayName, "Alice A.");

// A zero is a real value, not an absence. followers: 0 is a legitimate reading
// and must be stored — testing this because `if (!v) continue` would have been
// the obvious wrong implementation.
await store.mergeEnrichment({ username: "alice" }, { followers: 0, posts: 0 });
alice = (await store.getProspects())["id:1"];
eq("zero is a real value and is written", alice.followers, 0);
eq("zero posts is written too", alice.posts, 0);

// `false` is likewise a real value.
await store.mergeEnrichment({ username: "alice" }, { verified: false, isPrivate: false });
alice = (await store.getProspects())["id:1"];
eq("false is a real value and is written", alice.verified, false);

eq("merging an unknown prospect is a no-op, not a crash",
  await store.mergeEnrichment({ username: "nobody" }, { bio: "x" }), null);

// ---------------------------------------------------------------------------
// 2. looksLikeRealProfile — the gate that decides whether to trust a scrape
// ---------------------------------------------------------------------------
const { looksLikeRealProfile: real } = store;

eq("a real profile render passes",
  real({ username: "alice", followers: 5000, bio: "hi" }, "alice"), true);
eq("followers alone is enough",
  real({ username: "alice", followers: 12 }, "alice"), true);
eq("a category alone is enough",
  real({ username: "alice", category: "Coach" }, "alice"), true);
eq("a bio alone is enough",
  real({ username: "alice", bio: "Founder" }, "alice"), true);

// The login-wall case: right URL, wrong content. Every substantive field is
// absent, which is what makes it detectable at all.
eq("a login wall is rejected",
  real({ username: "alice", followers: null, bio: "", category: null }, "alice"), false);
// The redirect case: Instagram served someone else's page, or the viewer's own.
eq("a handle mismatch is rejected",
  real({ username: "someoneelse", followers: 5000 }, "alice"), false);
eq("case differences in the handle are tolerated",
  real({ username: "Alice", followers: 5000 }, "alice"), true);
eq("no scrape at all is rejected", real(null, "alice"), false);
eq("a scrape with no username is rejected", real({ followers: 5000 }, "alice"), false);

// ---------------------------------------------------------------------------
// 2b. reelsReadIsComplete / withReelsGrid — reading the Reels tab safely
// ---------------------------------------------------------------------------
// Enrich loads /{handle}/reels/, because on the mixed main grid analyzeGrid's
// video bucket usually falls under MIN_SAMPLE and the reels are never evaluated
// at all. The unverified part is whether that sub-route serves og:description,
// which is where follower counts come from — so the switch is guarded.
const { reelsReadIsComplete: complete, withReelsGrid: withGrid } = store;

// The whole point of being STRICTER than looksLikeRealProfile: the reels page
// almost certainly has a header (bio, category) while possibly lacking the og
// counts. Accepting it on a bio would leave followers null forever, because
// mergeEnrichment drops nulls — a silent, permanent hole in every follower bound.
eq("a reels read with counts is complete",
  complete({ username: "alice", followers: 5000, bio: "hi" }, "alice"), true);
eq("a reels read with a bio but NO counts is not complete",
  complete({ username: "alice", followers: null, bio: "Founder" }, "alice"), false);
eq("a reels read with a category but no counts is not complete",
  complete({ username: "alice", category: "Coach" }, "alice"), false);
eq("zero followers is a count, not a missing one",
  complete({ username: "alice", followers: 0, bio: "hi" }, "alice"), true);
eq("a handle mismatch is still rejected",
  complete({ username: "someoneelse", followers: 5000 }, "alice"), false);
eq("no reels read at all is not complete", complete(null, "alice"), false);

// The fallback: canonical page for the fields, reels grid for the comparison.
const mainRead = { username: "alice", followers: 5000, bio: "hi", gridPosts: [{ kind: "p" }] };
const reelsRead = { username: "alice", gridPosts: [{ kind: "reel" }, { kind: "reel" }] };
eq("the reels grid replaces the mixed one",
  withGrid(mainRead, reelsRead, "alice").gridPosts.length, 2);
eq("...and every other field comes from the canonical read",
  withGrid(mainRead, reelsRead, "alice").followers, 5000);
eq("the canonical read is not mutated", mainRead.gridPosts.length, 1);

// A grid from the wrong account would put a STRANGER'S post behind this
// prospect's "▶ Watch" button.
eq("a mismatched reels read is ignored",
  withGrid(mainRead, { username: "bob", gridPosts: [{ kind: "reel" }] }, "alice").gridPosts.length, 1);
eq("an empty reels grid is ignored",
  withGrid(mainRead, { username: "alice", gridPosts: [] }, "alice").gridPosts.length, 1);
eq("no reels read at all leaves the main read alone",
  withGrid(mainRead, null, "alice").gridPosts.length, 1);
eq("no main read stays null", withGrid(null, reelsRead, "alice"), null);

// ---------------------------------------------------------------------------
// 2c. readQuality / readLooksSettled — don't read a page that hasn't rendered
// ---------------------------------------------------------------------------
// The defect: fetchProfileViaTempTab broke out of its retry loop on the first
// response that was an object at all, and extractCurrentProfile() returns a
// fully-shaped object the moment pageType() says "profile" — true on first paint.
// So it always exited on iteration 0 with a skeleton and closed the tab mid-render.
// Counts arrive in og:description (initial HTML) while the bio and grid arrive
// later, so a lead could be enriched with 138K followers and no bio, and then sit
// at "needs enrich" forever because computeScore has nothing to score.
const { readQuality: quality, readLooksSettled: settled } = store;

const skeleton = { username: "alice", displayName: "alice", followers: null, bio: "", gridPosts: [] };
const hydrated = { username: "alice", displayName: "Alice Smith", followers: 5000, following: 300,
  posts: 120, bio: "Founder", category: "Coach", links: ["x.com/a"],
  gridPosts: [1, 2, 3, 4, 5, 6].map(() => ({ kind: "reel" })) };

eq("a skeleton read scores near nothing", quality(skeleton), 0);
eq("a hydrated read scores much higher", quality(hydrated) > quality(skeleton), true);
eq("nothing at all scores zero", quality(null), 0);
// Monotonic in the fields that matter: this is what lets the poller keep the BEST
// read rather than the last, so a late rate-limit interstitial can't overwrite a
// good one.
eq("arriving counts raise the score",
  quality({ ...skeleton, followers: 5000 }) > quality(skeleton), true);
eq("an arriving bio raises the score",
  quality({ ...skeleton, bio: "Founder" }) > quality(skeleton), true);
eq("arriving grid tiles raise the score",
  quality({ ...skeleton, gridPosts: [{}, {}] }) > quality(skeleton), true);

// The early exit. It must NOT fire on the half-rendered state that caused the bug.
eq("a fully rendered page settles", settled(hydrated, 6), true);
eq("counts without a bio or category do NOT settle",
  settled({ ...hydrated, bio: "", category: null }, 6), false);
eq("a bio without counts does NOT settle",
  settled({ ...hydrated, followers: null }, 6), false);
eq("too few grid tiles does NOT settle",
  settled({ ...hydrated, gridPosts: [{}, {}] }, 6), false);
eq("the skeleton never settles", settled(skeleton, 6), false);
eq("nothing at all never settles", settled(null, 6), false);
// A category is enough on its own — plenty of business accounts have no bio, and
// waiting the whole budget for one that will never come is just slower.
eq("a category substitutes for a bio", settled({ ...hydrated, bio: "" }, 6), true);

// ---------------------------------------------------------------------------
// 3. The write lock — concurrent writers must not lose each other's changes
// ---------------------------------------------------------------------------
// The defect: every prospects mutation was an unguarded read-modify-write of one
// blob. The observed failure was a recording session committing 380 handles being
// silently overwritten by a rescoreAll() that had read the map before the commit.
// Fired WITHOUT await, in one tick, which is exactly how the panel calls these.

const writes = [
  store.saveProspects([{ username: "bob" }, { username: "carol" }], { status: "New" }),
  store.saveProspect({ username: "dave", status: "New" }),
  store.replaceProspects((ps) => { for (const k in ps) ps[k].touched = true; return ps; }),
  store.saveProspect({ username: "erin", status: "New" }),
];
await Promise.all(writes);
const after = await store.getProspects();
const names = Object.values(after).map((p) => p.username).sort();
eq("no concurrent write is lost", names, ["alice", "bob", "carol", "dave", "erin"]);
// replaceProspects ran third, so it saw bob and carol but not erin. What matters
// is that it did not DELETE anyone — the old bug was the wholesale overwrite.
eq("the map-wide rewrite did not drop later writers", names.includes("erin"), true);

// A rejected write must not wedge the queue for everyone behind it.
stub.failNextSet && stub.failNextSet();
let rejected = false;
try { await store.saveProspect({ username: "frank" }); } catch (_) { rejected = true; }
await store.saveProspect({ username: "grace", status: "New" });
const afterFail = await store.getProspects();
eq("a write after a failed write still lands",
  Object.values(afterFail).some((p) => p.username === "grace"), true);

// ---------------------------------------------------------------------------
// 4. Draft keys — shortcodes are case-sensitive, handles are not
// ---------------------------------------------------------------------------
// The defect: draftKey lowercased everything. Instagram shortcodes are
// [A-Za-z0-9_-] and case-SENSITIVE, so /p/DAbc/ and /p/Dabc/ are different posts
// that collided on one draft key — and one person's half-written comment ate the
// other's.
eq("comment keys keep case", store.draftKey("comment", "CxYz"), "comment:CxYz");
eq("differing-case shortcodes do not collide",
  store.draftKey("comment", "CxYz") === store.draftKey("comment", "cxyz"), false);
eq("dm keys still fold case", store.draftKey("dm", "ALICE"), store.draftKey("dm", "alice"));

// Concurrent draft writes to DIFFERENT keys must both survive. draftSelected()
// mounts up to eight boxes at once, each with its own 400ms debounce against the
// one shared blob — inside a single window, both used to read the same map and
// the first writer's text vanished.
await Promise.all([
  store.setDraftText("dm:one", "first draft"),
  store.setDraftText("dm:two", "second draft"),
  store.setDraftText("comment:AbC", "a comment"),
]);
eq("concurrent draft write 1 survives", await store.getDraftText("dm:one"), "first draft");
eq("concurrent draft write 2 survives", await store.getDraftText("dm:two"), "second draft");
eq("concurrent draft write 3 survives", await store.getDraftText("comment:AbC"), "a comment");

// ---------------------------------------------------------------------------
// 5. CSV — the outreach log must round-trip, and a lone CR must not split a row
// ---------------------------------------------------------------------------
// The defect (round-trip): `outreach` was not in ALL_FIELDS, so export → Clear
// all data → import lost every message body, timestamp and channel. The Metrics
// tab is computed entirely from that array, so all history was unrecoverable —
// and an export was the only backup a user without Firebase had.
eq("outreach is exportable", store.ALL_FIELDS.includes("outreach"), true);
eq("outreach is NOT a default column", store.DEFAULT_FIELDS.includes("outreach"), false);
eq("outreach is a JSON field", JSON_FIELDS.includes("outreach"), true);

const log = [
  { at: "2026-07-01T00:00:00.000Z", channel: "dm", type: "manual", text: 'Hi, "hello"\nsecond line', tpl: "tpl:t_intro" },
  { at: "2026-07-05T00:00:00.000Z", channel: "comment", type: "manual", text: "nice, work", noFollowUp: true },
];
const cell = csvValue(csvField({ outreach: log }, "outreach"));
const roundTripped = mapCsvRows(parseCsv(`username,outreach\nalice,${cell}`)).records[0];
eq("the outreach log survives a full CSV round trip", roundTripped.outreach, log);
eq("a mangled outreach cell drops that field instead of failing the row",
  mapCsvRows(parseCsv('username,outreach\nalice,"{not json"')).records[0].username, "alice");
eq("a mangled outreach cell yields no outreach key",
  "outreach" in mapCsvRows(parseCsv('username,outreach\nalice,"{not json"')).records[0], false);
eq("an empty outreach cell is dropped, not written as []",
  "outreach" in mapCsvRows(parseCsv("username,outreach\nalice,\n")).records[0], false);

// The defect (lone CR): csvValue quoted on /[",\n]/ but not \r, while parseCsv
// treats an unquoted lone \r as a row terminator. A bio carrying a stray CR
// therefore exported unquoted and re-imported as two rows with every column
// shifted — silently, because the fragment has no handle and is just "skipped".
eq("a lone CR is quoted on export", csvValue("line one\rline two"), '"line one\rline two"');
const crRow = mapCsvRows(parseCsv(`username,bio\nalice,${csvValue("a\rb")}`));
eq("a bio with a lone CR stays one row", crRow.records.length, 1);
eq("a bio with a lone CR keeps both halves", crRow.records[0].bio, "a\rb");
eq("nothing was silently skipped", crRow.skipped, 0);

// ---------------------------------------------------------------------------
// 6. computeMetrics — read rate, and reply rate BY TEMPLATE
// ---------------------------------------------------------------------------
// byTemplate did not exist. logOutreach stored the rendered `text` but no
// template id, so "which message works" — the question the product is built
// around — had nothing to group by.
const stub2 = installChromeStub({
  seed: {
    prospects: {
      // Template A: read, replied.
      a: { username: "a", seenAt: "x", repliedAt: "y", status: "Replied",
           outreach: [{ at: "1", channel: "dm", tpl: "tpl:t_intro" }] },
      // Template A: read, no reply.
      b: { username: "b", seenAt: "x", status: "Contacted",
           outreach: [{ at: "1", channel: "dm", tpl: "tpl:t_intro" }] },
      // Template B: never read.
      c: { username: "c", status: "Contacted",
           outreach: [{ at: "1", channel: "dm", tpl: "tpl:t_partner" }] },
      // A follow-up under a DIFFERENT template must not re-attribute the person:
      // the first message is the one that had to earn the open.
      d: { username: "d", seenAt: "x", status: "Contacted", outreach: [
            { at: "1", channel: "dm", tpl: "tpl:t_intro" },
            { at: "2", channel: "dm", tpl: "tpl:t_followup" },
          ] },
      // Comment-only: must not appear in any DM denominator.
      e: { username: "e", status: "Contacted",
           outreach: [{ at: "1", channel: "comment" }] },
      // Pre-`tpl` history: grouped under "—", never lumped in with a real one.
      f: { username: "f", seenAt: "x", status: "Contacted",
           outreach: [{ at: "1", channel: "dm" }] },
    },
  },
});
const store2 = await import("../../extension/src/shared/store.js?v=2");
const m = await store2.computeMetrics();

eq("dm people excludes the comment-only prospect", m.dmPeople, 5);
eq("read count is right", m.seen, 4);
eq("unread is the complement of read", m.unread, 1);
eq("read rate", m.seenRate, 80);
eq("reply rate is over everyone messaged", m.replyRate, 20);
// The number that separates "nobody opens my DMs" from "people open them and
// don't care" — two different problems with two different fixes.
eq("reply rate among people who read it", m.replyRateOfRead, 25);

eq("template A counted 3 people", m.byTemplate["tpl:t_intro"].people, 3);
eq("template A read count", m.byTemplate["tpl:t_intro"].seen, 3);
eq("template A reply count", m.byTemplate["tpl:t_intro"].replied, 1);
eq("template B counted 1 person", m.byTemplate["tpl:t_partner"].people, 1);
eq("template B was never read", m.byTemplate["tpl:t_partner"].seen, 0);
eq("a follow-up template does not re-attribute the person",
  m.byTemplate["tpl:t_followup"], undefined);
eq("pre-tpl history groups under a dash", m.byTemplate["—"].people, 1);
eq("comment-only prospects are in no template bucket",
  Object.values(m.byTemplate).reduce((n, t) => n + t.people, 0), 5);

// bySource counts PEOPLE. It used to be named `sent` while the "messages sent"
// tile counted events, so the Metrics tab showed two numbers that disagreed.
eq("bySource counts people, and says so", "people" in m.bySource["—"], true);

// ---------------------------------------------------------------------------
// 7. The funnel: Queue -> Shortlist -> Outreach
// ---------------------------------------------------------------------------
// One `status` field drives all three tabs. The reason it is a field and not a
// separate collection: every path that already writes a prospect (capture, CSV
// import, Scan, harvest, enrich) would otherwise need to learn about a second
// store, and the two could desynchronise.
const { STAGE, QUEUE_STATUSES, isQueued, isShortlisted, isContacted } = store;

eq("the three stages are named", [STAGE.QUEUE, STAGE.SHORTLIST, STAGE.CONTACTED],
  ["Captured", "Shortlisted", "Contacted"]);

// Three write paths historically produced three different strings for the same
// state: "Captured" (capture button, Scan), "New" (CSV import) and "" (earliest
// records). All three are the Queue. If this ever narrows, imported leads and old
// records vanish from the UI without any error.
eq("queue statuses cover all three legacy spellings",
  QUEUE_STATUSES.slice().sort(), ["", "Captured", "New"]);
eq("a captured lead is queued", isQueued({ status: "Captured" }), true);
eq("a CSV-imported lead is queued", isQueued({ status: "New" }), true);
eq("a status-less record is queued", isQueued({}), true);
eq("a shortlisted lead is NOT queued", isQueued({ status: "Shortlisted" }), false);
eq("a contacted lead is NOT queued", isQueued({ status: "Contacted" }), false);
eq("a closed lead is NOT queued", isQueued({ status: "Won" }), false);

eq("shortlisted", isShortlisted({ status: "Shortlisted" }), true);
eq("not shortlisted", isShortlisted({ status: "Captured" }), false);

// isContacted reads the outreach LOG, not the status, so a lead leaves the
// shortlist the moment a message is actually recorded — even if a later status
// change (Replied, Won) overwrites "Contacted".
eq("contacted is decided by the outreach log", isContacted({ outreach: [{ at: "1" }] }), true);
eq("an empty log is not contacted", isContacted({ outreach: [] }), false);
eq("no log at all is not contacted", isContacted({}), false);
eq("a Won lead is still contacted", isContacted({ status: "Won", outreach: [{ at: "1" }] }), true);

// The three views must PARTITION everyone who has been messaged out of the two
// working lists — otherwise a lead appears in two tabs and gets messaged twice.
const people = [
  { username: "a", status: "Captured" },
  { username: "b", status: "New" },
  { username: "c", status: "Shortlisted" },
  { username: "d", status: "Shortlisted", outreach: [{ at: "1" }] }, // sent: leaves the shortlist
  { username: "e", status: "Contacted", outreach: [{ at: "1" }] },
];
const inQueue = people.filter((p) => isQueued(p) && !isContacted(p)).map((p) => p.username);
const inShortlist = people.filter((p) => isShortlisted(p) && !isContacted(p)).map((p) => p.username);
const inOutreach = people.filter(isContacted).map((p) => p.username);
eq("queue view", inQueue, ["a", "b"]);
eq("shortlist view", inShortlist, ["c"]);
eq("outreach view", inOutreach, ["d", "e"]);
eq("nobody appears in two lists",
  new Set([...inQueue, ...inShortlist, ...inOutreach]).size, 5);

// PUBLIC_ONLY_NOTE — a rule with no exception as of 0.13.0. It was a toggle with a
// "Capture anyway" escape hatch, which made the listing claim conditional.
eq("a private account fails the filter", store.failsPublicFilter({ isPrivate: true }), true);
eq("a public account passes", store.failsPublicFilter({ isPrivate: false }), false);
eq("an unknown account passes (isPrivate is only known after a read)",
  store.failsPublicFilter({}), false);
eq("the public-only toggle is gone", typeof store.getPublicOnly, "undefined");
eq("the webhook is gone", typeof store.getWebhook, "undefined");

// ---------------------------------------------------------------------------
// 8. Numeric bounds — posts, followers, following
// ---------------------------------------------------------------------------
// These live in panel.js, which is a side-panel ES module full of DOM code, so the
// two pure predicates are duplicated here. That is a real tradeoff: change them in
// panel.js and this suite will not notice. It is worth it anyway, because both
// break SILENTLY — a wrong bound just shows the operator a slightly wrong list,
// forever. tests/smoke/panel.smoke.mjs covers the same rules through the real UI,
// so the pair catches a drift between them.
//
// RULE 1: bounds are INCLUSIVE at both ends. A range someone typed as 1000–5000
// should contain 1000 and 5000.
// RULE 2: null is not zero. A scanned handle has no counts until Enrich opens it,
// and a bound must exclude it unless "incl. un-enriched" is on — otherwise the
// queue looks empty right after a scan, when it is actually fullest.
// RULE 3: an unparseable bound is INACTIVE, not zero. A half-typed number must not
// blank the list mid-keystroke.
function parseBound(raw) {
  const t = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[, _]/g, "");
  if (!t) return null;
  const m = t.match(/^([0-9]*\.?[0-9]+)([km])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1));
}
function numMatch(p, field, min, max, includeUnknown) {
  if (min == null && max == null) return true;
  const raw = p[field];
  const n = raw == null || raw === "" ? null : Number(raw);
  if (n == null) return !!includeUnknown;
  if (min != null && n < min) return false;
  if (max != null && n > max) return false;
  return true;
}

// ---- parsing ----
eq("plain integer", parseBound("120"), 120);
eq("commas are ignored", parseBound("12,000"), 12000);
eq("spaces are ignored", parseBound(" 1 500 "), 1500);
// k/m because that is how Instagram writes every follower count.
eq("k suffix", parseBound("2k"), 2000);
eq("decimal k", parseBound("1.5k"), 1500);
eq("m suffix", parseBound("1.5m"), 1500000);
eq("uppercase K", parseBound("15K"), 15000);
eq("empty is no bound", parseBound(""), null);
eq("whitespace is no bound", parseBound("   "), null);
eq("null is no bound", parseBound(null), null);
// RULE 3 — these must be null (inactive), never 0, or typing "1" then backspacing
// would filter to nothing.
eq("letters are no bound", parseBound("abc"), null);
eq("a bare k is no bound", parseBound("k"), null);
eq("a negative is no bound", parseBound("-5"), null);
eq("a partial decimal is no bound", parseBound("1.2.3"), null);
eq("zero IS a bound, and it is zero", parseBound("0"), 0);

// ---- matching ----
const lead = { posts: 120, followers: 4200, following: 300 };
eq("no bounds set means the field is inactive", numMatch(lead, "posts", null, null, false), true);

// RULE 1 — inclusive at both ends.
eq("min equal to the value matches", numMatch(lead, "posts", 120, null, false), true);
eq("min one above excludes", numMatch(lead, "posts", 121, null, false), false);
eq("max equal to the value matches", numMatch(lead, "posts", null, 120, false), true);
eq("max one below excludes", numMatch(lead, "posts", null, 119, false), false);
eq("a range containing the value", numMatch(lead, "followers", 1000, 10000, false), true);
eq("a range with the value on the lower edge", numMatch(lead, "followers", 4200, 10000, false), true);
eq("a range with the value on the upper edge", numMatch(lead, "followers", 1000, 4200, false), true);
eq("a range entirely above", numMatch(lead, "followers", 10000, 20000, false), false);
eq("a range entirely below", numMatch(lead, "followers", 100, 1000, false), false);
// An inverted range matches nothing. Not an error — just what min>max means.
eq("an inverted range matches nothing", numMatch(lead, "posts", 200, 100, false), false);

// RULE 2 — null is not zero.
const unenriched = { username: "scanned" };
eq("an un-enriched lead is excluded by a min", numMatch(unenriched, "posts", 1, null, false), false);
eq("an un-enriched lead is excluded by a max", numMatch(unenriched, "posts", null, 500, false), false);
eq("...and is INCLUDED when asked for", numMatch(unenriched, "posts", 1, null, true), true);
eq("an un-enriched lead is unaffected when no bound is set",
  numMatch(unenriched, "posts", null, null, false), true);
eq("an explicit null count behaves like a missing one",
  numMatch({ posts: null }, "posts", 1, null, false), false);
eq("an empty-string count behaves like a missing one",
  numMatch({ posts: "" }, "posts", 1, null, false), false);
// But a real zero is a real answer and must be matched, not treated as unknown.
eq("0 posts matches a max of 10", numMatch({ posts: 0 }, "posts", null, 10, false), true);
eq("0 posts fails a min of 1", numMatch({ posts: 0 }, "posts", 1, null, false), false);
eq("0 posts is not 'unknown'", numMatch({ posts: 0 }, "posts", 1, null, true), false);

// Fields are independent and compose with AND.
eq("all three satisfied",
  numMatch(lead, "posts", 100, 200, false)
  && numMatch(lead, "followers", 1000, 10000, false)
  && numMatch(lead, "following", null, 500, false), true);
eq("one failing field rejects the lead",
  numMatch(lead, "posts", 100, 200, false)
  && numMatch(lead, "following", null, 200, false), false);

// The follow-for-follow shape: follows thousands, small audience.
const f4f = { followers: 800, following: 6500, posts: 12 };
eq("a follow-for-follow account is caught by a following max",
  numMatch(f4f, "following", null, 1500, false), false);

// ---------------------------------------------------------------------------
// 8. 0.17.0 — the greeting, and the default template
// ---------------------------------------------------------------------------
// The defect, seen in a real draft: buildDraft() only used displayName, and set
// the name to "" when it was missing or equal to the handle. The message then
// opened "Hi — came across your links in bio", which reads to the recipient as a
// mail-merge that didn't fire. renderTemplate's {first_name} had always fallen
// back to the handle; these two now agree.

const { buildDraft } = await import("../../extension/src/shared/draft.js");

eq("a display name is used, first word only",
  buildDraft({ username: "acme_co", displayName: "Ada Lovelace" }, {}).startsWith("Hi Ada "), true);
eq("no display name falls back to the handle, never a bare Hi —",
  buildDraft({ username: "acme_co" }, {}).startsWith("Hi acme_co "), true);
eq("a display name equal to the handle is not treated as a name",
  buildDraft({ username: "acme_co", displayName: "acme_co" }, {}).startsWith("Hi acme_co "), true);
eq("the greeting is never left dangling",
  /^Hi\s+—/.test(buildDraft({ username: "acme_co" }, {})), false);

// The default template is stored as an id, so deleting that template must fall
// back to the auto opener rather than leaving every draft box pointed at a
// template that no longer exists.
await store.saveTemplate({ id: "t_x", kind: "dm", name: "Test opener", body: "Hi {first_name}" });
await store.setDefaultTpl("t_x");
eq("a default template round-trips", await store.getDefaultTpl(), "t_x");
await store.deleteTemplate("t_x");
eq("a default pointing at a deleted template falls back", await store.getDefaultTpl(), "");
await store.setDefaultTpl("");
eq("empty means the auto opener", await store.getDefaultTpl(), "");

// ---------------------------------------------------------------------------
// N. An Explore follower count must not hide "needs enrich"        [0.18.0]
// ---------------------------------------------------------------------------
// Scanning Explore resolves each post tile through the post's public embed page,
// which hands back a follower count for free — with no bio, no category, and no
// check of whether the account is even public. The worry during review was that
// this free number would suppress score.js's thin-data warning on exactly the
// leads that most need enriching.
//
// It does not, and the reason is worth pinning so nobody "fixes" it later:
// computeScore's `hasText` gate keys on bio||category||links and never consults
// followers, so an Explore lead takes the early return and comes back
// "Needs enrich" whether or not it has a follower count. These assertions hold
// that line — if someone ever adds `|| profile.followers` to `hasText`, Explore
// leads start scoring as if they'd been read properly, and this goes red.
const { computeScore } = await import("../../extension/src/shared/score.js");
const verdict = (p) => computeScore(p, { keywords: ["social media"] });
const needsEnrich = (p) => verdict(p).band === "Needs enrich";
const thin = (p) => verdict(p).concerns.some((c) => /Thin data/.test(c));

// Exactly the record shape an Explore tile scan produces.
eq("an Explore lead with a follower count still needs enriching",
  needsEnrich({ username: "bm_social_", followers: 23100, verified: false }), true);
eq("a huge follower count doesn't change that",
  needsEnrich({ username: "a", followers: 2300000, verified: true }), true);
eq("nor does one with no follower count", needsEnrich({ username: "a" }), true);
eq("a bio makes it scorable", needsEnrich({ username: "a", bio: "SMM for coaches" }), false);
eq("so does a category", needsEnrich({ username: "a", category: "Marketing agency" }), false);

// The second half: within the window where the thin-data concern IS reachable
// (a link or category present), it now keys on bio+category rather than
// bio+followers. A follower count is a number about an account, not text
// extracted from it, and it was never evidence that we'd read enough.
eq("a link plus a follower count but no bio is still thin",
  thin({ username: "a", links: ["https://x.com"], followers: 5000 }), true);
eq("a link with no bio and no followers is thin too",
  thin({ username: "a", links: ["https://x.com"] }), true);
eq("a category is real extracted signal, so not thin",
  thin({ username: "a", category: "Marketing agency" }), false);

// ---------------------------------------------------------------------------
// N+1. An absent follower count is an ABSENT KEY, not 0            [0.18.0]
// ---------------------------------------------------------------------------
// The embed page carried a follower count on only about half the posts sampled
// live. Writing the misses as 0 would be worse than not writing them: 0 is a
// legitimate value, so it survives mergeEnrichment's empty-value filter (which
// drops undefined/null/""/[] but deliberately KEEPS 0 and false), persists into
// the CSV export as fact, and reads as "this account has no followers".
//
// The scan path is a plain saveProspect() spread, not mergeEnrichment, so the
// filter never even gets a chance — which is why parseEmbed omits the key.
await store.saveProspect({ userId: "77", username: "embedlead", followers: 4200 });
await store.mergeEnrichment({ userId: "77" }, { followers: null, bio: "real bio" });
const embedLead = (await store.getProspects())["id:77"];
eq("a null enrich cannot blank a good follower count", embedLead.followers, 4200);
eq("...while the real value it did carry is written", embedLead.bio, "real bio");

await store.mergeEnrichment({ userId: "77" }, { followers: 0 });
eq("but a genuine 0 IS written — which is why absent must mean absent",
  (await store.getProspects())["id:77"].followers, 0);

report();
