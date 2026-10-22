// store.js — unsent draft persistence.
//
// New suite. Before this existed, anything typed into a draft or comment box
// died on any re-render: panel-tab switch, browser-tab switch, Instagram page
// load, or panel close. The bug was invisible in code review because the
// textarea "worked" — it just had the lifetime of a DOM node.
//
// These are the invariants the panel relies on. The panel wiring itself
// (attachDraftPersistence) needs a browser; TESTING.md §29 covers that.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

const stub = installChromeStub();
const {
  draftKey, getDraftText, setDraftText, clearDraftText, DRAFT_MAX, DRAFT_TTL_MS,
} = await import("../../extension/src/shared/store.js");

// ---- keys ----
// DMs are keyed by handle, comments by shortcode: you can be mid-comment on two
// different posts by the same person, and they must not overwrite each other.
eq("dm key", draftKey("dm", "Alice"), "dm:alice");
// Shortcodes are case-SENSITIVE ([A-Za-z0-9_-]), so /p/CxYz123/ and /p/cxyz123/
// are different posts. Lowercasing them collided two real posts onto one draft
// key and silently ate one of the drafts.
eq("comment key preserves shortcode case", draftKey("comment", "CxYz123"), "comment:CxYz123");
eq("comment keys of differing case do not collide",
  draftKey("comment", "CxYz123") === draftKey("comment", "cxyz123"), false);
// Handles ARE case-insensitive on Instagram, so DM keys still fold.
eq("dm keys are case-insensitive", draftKey("dm", "ALICE"), draftKey("dm", "alice"));
eq("dm and comment keys never collide", draftKey("dm", "x") === draftKey("comment", "x"), false);
eq("unknown kind falls back to dm", draftKey("whatever", "x"), "dm:x");

// ---- round trip ----
eq("missing draft is empty string, not undefined", await getDraftText("dm:nobody"), "");
eq("no key is tolerated", await getDraftText(""), "");

await setDraftText("dm:alice", "Hi Alice — saw your reel about pottery kilns");
eq("draft survives a write", await getDraftText("dm:alice"), "Hi Alice — saw your reel about pottery kilns");

await setDraftText("comment:abc", "The kiln temperature bit is the useful part");
eq("comment draft stored separately", await getDraftText("comment:abc"), "The kiln temperature bit is the useful part");
eq("dm draft untouched by the comment write", await getDraftText("dm:alice"), "Hi Alice — saw your reel about pottery kilns");

// Overwrite, not append.
await setDraftText("dm:alice", "second version");
eq("rewrite replaces", await getDraftText("dm:alice"), "second version");

// ---- clearing ----
// Emptying the box should remove the record, not store "". Otherwise a cleared
// draft still counts against the cap and still looks like a draft on restore.
await setDraftText("dm:alice", "   ");
eq("whitespace-only clears the draft", await getDraftText("dm:alice"), "");
eq("whitespace-only removes the key", "dm:alice" in (stub.db().drafts || {}), false);

await setDraftText("dm:bob", "something");
await clearDraftText("dm:bob");
eq("explicit clear works", await getDraftText("dm:bob"), "");
eq("clearing a missing key is a no-op", await clearDraftText("dm:ghost"), undefined);

// ---- expiry ----
// An abandoned draft resurfacing months later, attached to a prospect whose
// situation has changed, is worse than no draft at all.
stub.seed({ drafts: { "dm:stale": { text: "written long ago", at: Date.now() - DRAFT_TTL_MS - 1000 } } });
eq("expired draft is not returned", await getDraftText("dm:stale"), "");

stub.seed({ drafts: { "dm:fresh": { text: "recent", at: Date.now() - 1000 } } });
eq("fresh draft is returned", await getDraftText("dm:fresh"), "recent");

// A write also sweeps anything past the TTL, so the blob doesn't accumulate
// forever on a long-lived install.
stub.seed({
  drafts: {
    "dm:old": { text: "gone", at: Date.now() - DRAFT_TTL_MS - 1000 },
    "dm:keep": { text: "stays", at: Date.now() },
  },
});
await setDraftText("dm:new", "trigger the sweep");
eq("expired entries swept on write", "dm:old" in stub.db().drafts, false);
eq("live entries survive the sweep", stub.db().drafts["dm:keep"].text, "stays");

// ---- the cap ----
// Oldest-first eviction. Without a bound, a heavy user's draft blob competes
// with the prospects blob for the same storage.
stub.seed({ drafts: {} });
const N = DRAFT_MAX + 25;
for (let i = 0; i < N; i++) {
  await setDraftText(`dm:u${i}`, `draft ${i}`);
  // Ages must be distinct and increasing for eviction order to mean anything —
  // the stub's clock is too coarse across a tight loop. They must also stay
  // comfortably inside the TTL, or the sweep removes them before the cap does.
  stub.db().drafts[`dm:u${i}`].at = Date.now() - (N - i) * 1000;
}
await setDraftText("dm:final", "one more");
const kept = Object.keys(stub.db().drafts);
eq("cap enforced", kept.length <= DRAFT_MAX, true);
eq("newest survives", await getDraftText("dm:final"), "one more");
eq("oldest evicted first", kept.includes("dm:u0"), false);
eq("recent entries retained", kept.includes(`dm:u${DRAFT_MAX + 24}`), true);

// ---- the shape the panel depends on ----
// A draft must never leak into the prospect record: saveProspects merges by key
// and an unexpected field would ride along into exports and the Sheet.
stub.seed({ drafts: {} });
await setDraftText("dm:alice", "text");
eq("drafts live under their own storage key", Object.keys(stub.db()), ["drafts"]);

report();
