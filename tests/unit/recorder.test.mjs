// recorder.js — the recording-session model.
//
// New suite. The feature is staged behind FLAGS.recorder and ships v1.1, but
// mergeInto() is where two Instagram tabs' batches actually collide and
// reconcile() is what stops a forgotten session ambushing the user later. Both
// are pure enough to test without a browser, and both fail silently if wrong.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

const stub = installChromeStub();

const rec = await import("../../extension/src/shared/recorder.js");
const {
  mergeInto, isActive, isStale, msLeft, newSession, reconcile,
  readSession, writeSession, clearSession, MAX_HARVEST, STALE_MS, DURATIONS,
  DEFAULT_DURATION_MIN, burstPaceMs, BURST_PACE_MIN_MS, BURST_PACE_JITTER_MS,
} = rec;

const seen = (username, sourceUrl, displayName) => ({
  username, displayName: displayName || username,
  profileUrl: `https://www.instagram.com/${username}/`,
  sourceType: "list", sourceUrl,
});

// ---- mergeInto: the staging map ----

let h = {};
mergeInto(h, [seen("Alice", "/x/followers/"), seen("bob", "/x/followers/")]);
eq("records staged", Object.keys(h).sort(), ["alice", "bob"]);
eq("key is lowercased", h.alice.username, "Alice");
eq("first sighting counts once", h.alice.n, 1);
eq("source page recorded", h.alice.pages, ["/x/followers/"]);

// A second sighting on the same page bumps the count but not the page list.
mergeInto(h, [seen("Alice", "/x/followers/")]);
eq("re-sighting bumps n", h.alice.n, 2);
eq("same page not duplicated", h.alice.pages.length, 1);

// Distinct pages accumulate — that is what identifies site chrome later.
mergeInto(h, [seen("Alice", "/explore/")]);
eq("distinct page recorded", h.alice.pages, ["/x/followers/", "/explore/"]);

// ...but the page list is bounded, or a nav-rail handle grows without limit.
for (let i = 0; i < 20; i++) mergeInto(h, [seen("Alice", `/p${i}/`)]);
eq("page list capped at 5", h.alice.pages.length, 5);
eq("sightings still counted past the page cap", h.alice.n, 23);

// A better display name upgrades a handle-only record; it never downgrades one.
let h2 = {};
mergeInto(h2, [seen("carol", "/a/")]);
eq("display name starts as the handle", h2.carol.displayName, "carol");
mergeInto(h2, [seen("carol", "/b/", "Carol Danvers")]);
eq("display name upgraded", h2.carol.displayName, "Carol Danvers");
mergeInto(h2, [seen("carol", "/c/")]);
eq("display name not downgraded back to the handle", h2.carol.displayName, "Carol Danvers");

// Junk in, nothing out.
let h3 = {};
mergeInto(h3, [{ username: "" }, { username: null }, {}]);
eq("blank usernames dropped", Object.keys(h3).length, 0);
eq("null batch tolerated", mergeInto(h3, null).capped, false);

// The hard ceiling. Past MAX_HARVEST the burst is meaningless anyway, and the
// flag is what lets the panel tell the user their session was truncated.
let big = {};
mergeInto(big, Array.from({ length: MAX_HARVEST }, (_, i) => seen(`u${i}`, "/x/")));
eq("filled to the ceiling", Object.keys(big).length, MAX_HARVEST);
const over = mergeInto(big, [seen("onemore", "/x/")]);
eq("further NEW records are refused", over.capped, true);
eq("ceiling not exceeded", Object.keys(big).length, MAX_HARVEST);
// ...but an ALREADY-staged handle must still be countable at the ceiling.
const again = mergeInto(big, [seen("u0", "/y/")]);
eq("existing records still merge at the ceiling", again.capped, false);
eq("existing record still bumped", big.u0.n, 2);

// ---- session predicates ----

const live = newSession({ durationMin: 10, tabId: 7, sourceAccount: "mybrand" });
eq("duration honoured", live.durationMs, 10 * 60 * 1000);
eq("starts active", isActive(live), true);
eq("endsAt is absolute", live.endsAt > Date.now(), true);
eq("msLeft counts down", msLeft(live) > 0 && msLeft(live) <= 10 * 60 * 1000, true);
eq("fresh session is not stale", isStale(live), false);
eq("tab and account carried", [live.tabId, live.sourceAccount], [7, "mybrand"]);

eq("bad duration falls back to the default",
  newSession({ durationMin: 999 }).durationMs, DEFAULT_DURATION_MIN * 60 * 1000);
eq("offered durations are the allowed ones",
  DURATIONS.every((d) => newSession({ durationMin: d }).durationMs === d * 60 * 1000), true);

eq("null session is not active", isActive(null), false);
eq("null session is not stale", isStale(null), false);
eq("msLeft of null is 0", msLeft(null), 0);

const expired = { ...live, endsAt: Date.now() - 1000 };
eq("expired session has no time left", msLeft(expired), 0);
eq("just-expired is not yet stale", isStale(expired), false);

const ancient = { ...live, endsAt: Date.now() - STALE_MS - 1000 };
eq("day-old session is stale", isStale(ancient), true);

// Burst pacing must stay inside its declared window — a metronome-regular
// request pattern is exactly what behavioural rate-limiting looks for.
const paces = Array.from({ length: 50 }, burstPaceMs);
eq("burst pacing respects the floor", paces.every((p) => p >= BURST_PACE_MIN_MS), true);
eq("burst pacing respects the ceiling",
  paces.every((p) => p <= BURST_PACE_MIN_MS + BURST_PACE_JITTER_MS), true);
eq("burst pacing is jittered, not fixed", new Set(paces).size > 1, true);

// ---- reconcile: self-healing on boot ----
// The content script is the only timer holder, so if its tab closed before
// endsAt the timer never fired and the session sits "active" with a deadline in
// the past. Both the panel and the content script boot through here.

await writeSession(live);
eq("live session survives reconcile", (await reconcile()).status, "active");

await writeSession({ ...live, endsAt: Date.now() - 1000 });
const healed = await reconcile();
eq("expired session is closed, not left active", healed.status, "ended");
eq("endedAt is the deadline, not now", healed.endedAt, healed.endsAt);
eq("healed status was persisted", (await readSession()).status, "ended");

await writeSession(ancient);
eq("stale session is discarded", await reconcile(), null);
eq("stale session cleared from storage", await readSession(), null);

await clearSession();
eq("no session reconciles to null", await reconcile(), null);
eq("clearSession removes both keys", "recording" in stub.db() || "recHarvest" in stub.db(), false);

// ---------------------------------------------------------------------------
// The Explore tile drain (0.18.0) — canDrainTiles, from instagram.js
// ---------------------------------------------------------------------------
// A recording session on Explore may resolve post tiles to their authors, which
// costs a network request each. That is the ONE place the content script is
// allowed to fetch on a timer, so its gate lives here alongside the rest of the
// session model rather than only in embed.test.mjs.
//
// The safety property, and the only reason this is defensible at all: the drain
// keys on the SAME counter that chooses the tick interval. `emptyTicks >=
// IDLE_AFTER` is what makes recSchedule() back off from 1500ms to 4000ms, so a
// drain cannot land on a hot tick by construction — not by remembering to check.
const { canDrainTiles } = await import("../helpers/content-stub.mjs")
  .then((m) => m.loadContentScript({ url: "https://www.instagram.com/explore/" }));

const ok = {
  active: true, page: "explore", emptyTicks: 5, visible: true,
  busy: false, now: 1_700_000_000_000, cooldownUntil: 0, used: 0,
};
eq("an idle tick on Explore may drain", canDrainTiles(ok), true);
eq("the 1.5s hot tick never fetches", canDrainTiles({ ...ok, emptyTicks: 4 }), false);
eq("one tick short of idle still never fetches",
  canDrainTiles({ ...ok, emptyTicks: 0 }), false);
eq("no session, no drain", canDrainTiles({ ...ok, active: false }), false);
eq("a followers list is not Explore", canDrainTiles({ ...ok, page: "profile" }), false);
eq("never harvests a DM list", canDrainTiles({ ...ok, page: "direct" }), false);
eq("a backgrounded tab does not crawl", canDrainTiles({ ...ok, visible: false }), false);
eq("never overlaps a manual scan", canDrainTiles({ ...ok, busy: true }), false);
eq("respects the shared rate-limit cooldown",
  canDrainTiles({ ...ok, cooldownUntil: ok.now + 1 }), false);
eq("the cooldown expiring re-opens it",
  canDrainTiles({ ...ok, cooldownUntil: ok.now }), true);

// A 20-minute sit on Explore at one request per 4s idle tick would be ~300
// requests without this. The budget is per session, reset in recArm().
eq("the session budget closes the drain at 60", canDrainTiles({ ...ok, used: 60 }), false);
eq("...and 59 is still open", canDrainTiles({ ...ok, used: 59 }), true);

report();
