// cullCandidates() — what the cleanup is allowed to propose deleting.
//
// This is the only feature in Sprill that proposes destroying records, and a
// prospect list is the one thing here that cannot be re-derived. So the tests
// that matter are the REFUSALS: every case below is someone the cleanup must not
// offer up, because a user who is shown a pre-ticked list of their own won deals
// will never press the button again — and the one time they press it without
// reading, the data is gone.
//
// The dates are computed relative to a fixed "now" passed in as ages in days, so
// this suite does not depend on the wall clock.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

installChromeStub({ seed: {} });
const { cullCandidates, CULL_DEFAULTS } = await import("../../extension/src/shared/store.js");

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const dm = (d) => [{ at: ago(d), channel: "dm", type: "manual", text: "hi" }];

const names = (rows) => rows.map((r) => r.username).sort();

// ---- quiet: messaged, never replied, past the point of hope ----

const quietSet = [
  { username: "long_silent", status: "Contacted", outreach: dm(60), lastContactedAt: ago(60) },
  { username: "recent_send", status: "Contacted", outreach: dm(3), lastContactedAt: ago(3) },
];
{
  const { quiet } = cullCandidates(quietSet);
  eq("a lead messaged 60d ago with no reply is proposed", names(quiet), ["long_silent"]);
}
// The boundary is inclusive, and a lead one day inside it is safe. Off-by-one
// here is someone deleted a day before you would have followed up.
{
  const at = [{ username: "exactly", status: "Contacted", outreach: dm(30), lastContactedAt: ago(30) }];
  eq("exactly at the threshold is proposed", cullCandidates(at).quiet.length, 1);
  const under = [{ username: "under", status: "Contacted", outreach: dm(29), lastContactedAt: ago(29) }];
  eq("one day under the threshold is not", cullCandidates(under).quiet.length, 0);
}

// ---- the refusals ----

// Someone who replied is never proposed, however long ago it was. This is the
// single most important assertion in the file: they are a live conversation.
{
  const replied = [{
    username: "replied_ages_ago", status: "Replied", repliedAt: ago(400),
    outreach: dm(420), lastContactedAt: ago(420),
  }];
  eq("a lead who replied is never proposed", cullCandidates(replied).quiet.length, 0);
}
// Nor is anyone you deliberately marked as an outcome worth keeping.
for (const status of ["Interested", "Meeting", "Won", "Do not contact", "Not interested"]) {
  const rec = [{ username: "marked", status, outreach: dm(500), lastContactedAt: ago(500) }];
  eq(`status "${status}" is never proposed`, cullCandidates(rec).quiet.length, 0);
}
// "No response" is the one closing status that IS eligible — it means exactly
// what the cleanup is for, and marking it should not immunise the record.
{
  const rec = [{ username: "no_response", status: "No response", outreach: dm(90), lastContactedAt: ago(90) }];
  eq('"No response" stays eligible', cullCandidates(rec).quiet.length, 1);
}

// A comment is not a question, so "no reply" is not a fact about one. A
// comment-only prospect has never been asked anything — and they appear in no
// Pipeline segment at all, so this review would be the only place they ever
// resurface, and it would resurface them in order to delete them.
{
  const commented = [{
    username: "comment_only", status: "Contacted",
    outreach: [{ at: ago(90), channel: "comment", type: "manual", text: "nice" }],
    lastContactedAt: ago(90),
  }];
  eq("a comment-only prospect is never proposed as quiet", cullCandidates(commented).quiet.length, 0);
}

// THE ONE THAT MATTERS for quiet. `lastDmAt` is stamped on DMs only; every
// channel stamps `lastContactedAt`. Reading the DM stamp in preference proposes
// deleting someone you DMed in March and commented on last week.
{
  const both = [{
    username: "dmed_then_commented", status: "Contacted",
    outreach: [
      { at: ago(60), channel: "dm", type: "manual", text: "hi" },
      { at: ago(5), channel: "comment", type: "manual", text: "nice" },
    ],
    lastDmAt: ago(60), lastContactedAt: ago(5),
  }];
  eq("a recent comment protects an old DM", cullCandidates(both).quiet.length, 0);
}

// ---- stale: the account itself stopped posting ----

// `lastPostAt` is written once, at capture or enrich, and never refreshed — so on
// its own it measures the age of our DATA, not the age of the account. It only
// means anything alongside a recent reading.
{
  const stale = [
    { username: "dormant", status: "Captured", lastPostAt: ago(200), outlierCheckedAt: ago(2) },
    { username: "posting", status: "Captured", lastPostAt: ago(10), outlierCheckedAt: ago(2) },
  ];
  eq("an account that stopped posting is proposed", names(cullCandidates(stale).stale), ["dormant"]);
}

// THE ONE THAT MATTERS for stale. We last looked five months ago and saw a
// then-recent post. The account may have posted every day since; we have no idea.
// "We stopped looking" must never be reported as "they stopped posting".
{
  const oldRead = [{
    username: "enriched_long_ago", status: "Captured",
    lastPostAt: ago(150), outlierCheckedAt: ago(150),
  }];
  eq("a stale READING is not a stale account", cullCandidates(oldRead).stale.length, 0);
}
// Never enriched at all → no reading, so no verdict.
{
  const never = [{ username: "never_checked", status: "Captured", lastPostAt: ago(300) }];
  eq("no reading date means no stale verdict", cullCandidates(never).stale.length, 0);
}
// And the reason says when we looked, so the row can be judged honestly.
{
  const rec = [{ username: "r", status: "Captured", lastPostAt: ago(200), outlierCheckedAt: ago(3) }];
  eq("the stale reason states when we last looked",
    /checked 3d ago/.test(cullCandidates(rec).stale[0].why), true);
}

// THE ONE THAT MATTERS for stale. `lastPostAt` is only written when the grid
// actually yielded English dates — it is absent on a non-English Instagram and on
// any lead never enriched. "We couldn't read the dates" must never be treated as
// "this account is dead", or the cleanup proposes deleting perfectly active leads
// for the crime of having their UI in Portuguese.
{
  const undated = [
    { username: "no_date_at_all", status: "Captured", outlierCheckedAt: ago(2) },
    { username: "null_date", status: "Captured", lastPostAt: null, outlierCheckedAt: ago(2) },
  ];
  const { stale } = cullCandidates(undated);
  eq("a lead with no readable post date is never proposed as stale", stale.length, 0);
}

// A lead you have already messaged is judged on the conversation, not on their
// posting habits — otherwise one person lands in both piles and gets counted twice.
{
  const both = [{
    username: "messaged_and_dormant", status: "Contacted",
    outreach: dm(60), lastContactedAt: ago(60), lastPostAt: ago(300),
    outlierCheckedAt: ago(2),
  }];
  const { quiet, stale } = cullCandidates(both);
  eq("a messaged lead is judged as quiet, not stale", [quiet.length, stale.length], [1, 0]);
}

// ---- thresholds are configurable, and the defaults are the documented ones ----
{
  eq("default thresholds", [CULL_DEFAULTS.quietDays, CULL_DEFAULTS.staleDays, CULL_DEFAULTS.checkedWithinDays], [30, 120, 30]);
  const rec = [{ username: "r", status: "Contacted", outreach: dm(10), lastContactedAt: ago(10) }];
  eq("a tighter quiet window catches more", cullCandidates(rec, { quietDays: 7 }).quiet.length, 1);
  eq("a looser one catches less", cullCandidates(rec, { quietDays: 90 }).quiet.length, 0);
}

// Each proposed row carries the reason it was proposed — the UI shows it, because
// a bare list of handles is not something anyone can review honestly.
{
  const rec = [{ username: "why", status: "Contacted", outreach: dm(45), lastContactedAt: ago(45) }];
  eq("every proposal explains itself", /no reply/.test(cullCandidates(rec).quiet[0].why), true);
}

report();
