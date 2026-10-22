// outliers.js — "did any of these posts get unusual reach FOR THIS ACCOUNT?"
//
// New suite. analyzeGrid() is pure and synchronous, so every guardrail in it is
// cheaply testable — which matters, because the DOM half that feeds it
// (extractGridPosts) is the least-verified code in the build and this is the
// only part of the feature that can be checked without a browser.
//
// The guardrails exist to stop the feature manufacturing outliers on thin data.
// Each one below has a test because each one is a way to be confidently wrong
// in front of a user.

import { analyzeGrid, shouldPersistFromCapture, OUTLIER_TUNING } from "../../extension/src/shared/outliers.js";
import { eq, report } from "../helpers/assert.mjs";

const DAY = 86400000;
const now = Date.now();

/** Build a grid tile. ageDays defaults into the eligible 3–120 day window. */
function post(o = {}) {
  const i = post.n = (post.n || 0) + 1;
  return {
    shortcode: o.shortcode || `sc${i}`,
    kind: o.isVideo ? "reel" : "p",
    isVideo: !!o.isVideo,
    pinned: !!o.pinned,
    url: `https://www.instagram.com/${o.isVideo ? "reel" : "p"}/${o.shortcode || `sc${i}`}/`,
    plays: "plays" in o ? o.plays : null,
    likes: "likes" in o ? o.likes : null,
    comments: null,
    takenAt: o.takenAt === null ? null : (o.takenAt ?? now - (10 + (i % 20)) * DAY),
    src: o.src || "json",
  };
}
const videos = (playsList, extra = {}) => playsList.map((p) => post({ isVideo: true, plays: p, ...extra }));
const images = (likesList, extra = {}) => likesList.map((l) => post({ isVideo: false, likes: l, ...extra }));

// ---- refusals: not enough to say anything ----

eq("empty grid refuses", analyzeGrid([]).ok, false);
eq("empty grid says so", /No posts found/.test(analyzeGrid([]).note), true);
eq("non-array tolerated", analyzeGrid(null).ok, false);

const allPinned = videos([5000, 1000, 1000]).map((p) => ({ ...p, pinned: true }));
eq("only pinned refuses", /Only pinned posts/.test(analyzeGrid(allPinned).note), true);

const tooFew = analyzeGrid(videos([1000, 1000, 1000]));
eq("too few refuses", tooFew.ok, false);
eq("too few names the threshold", new RegExp(`need ${OUTLIER_TUNING.MIN_SAMPLE}`).test(tooFew.note), true);

// Instagram hides counts on some accounts. That must read as "we can't tell",
// never as "nothing stands out".
const noCounts = analyzeGrid(images([null, null, null, null, null, null]));
eq("hidden counts refuses", noCounts.ok, false);
eq("hidden counts explains why", /Instagram hides them/.test(noCounts.note), true);

// ---- the happy path ----

const one = analyzeGrid(videos([1000, 1100, 1000, 1050, 1000, 5000]));
eq("one outlier found", one.outliers.length, 1);
eq("outlier is the 5000-play post", one.outliers[0].value, 5000);
eq("measured on plays", one.outliers[0].metric, "plays");
eq("kind is video", one.outliers[0].kind, "video");
eq("ratio is vs the median, not the mean", one.outliers[0].ratio, 5);
eq("sample reported", one.sample, 6);
eq("basis is dated", one.basis, "dated");
eq("window reported", typeof one.windowDays, "number");
eq("note never claims causation", /why/.test(one.note), true);

// Leave-one-out: a single breakout must not be able to hide inside its own
// baseline. At n=6 including it would drag the median up enough to do exactly that.
const dominant = analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 20000]));
eq("breakout does not hide in its own baseline", dominant.outliers.length, 1);

// A flat account produces nothing, and says so plainly.
const flat = analyzeGrid(videos([1000, 1050, 1000, 990, 1010, 1000]));
eq("flat account: ok but empty", [flat.ok, flat.outliers.length], [true, 0]);
eq("flat account note", /Nothing stands out/.test(flat.note), true);

// ---- the guardrails ----

// Absolute floor: on a tiny account a 5x ratio is noise, not reach.
const tiny = analyzeGrid(videos([100, 100, 100, 100, 100, 500]));
eq("below the absolute play floor is not an outlier", tiny.outliers.length, 0);

// Pinned posts are usually the account's best-ever and sort first. Including
// them biases the baseline upward and hides genuine recent outliers.
const withPinned = analyzeGrid([
  ...videos([1000, 1000, 1000, 1000, 1000, 4000]),
  post({ isVideo: true, plays: 99000, pinned: true, shortcode: "PINNED" }),
]);
eq("pinned post is never reported", withPinned.outliers.some((o) => o.shortcode === "PINNED"), false);
eq("pinned post does not suppress a real one", withPinned.outliers.length, 1);

// Bimodal: if a large share qualifies, the account changed format or cadence.
// That is not four viral posts, and calling them outliers would be wrong.
const bimodal = analyzeGrid(videos([1000, 1000, 1000, 9000, 9000, 9000]));
eq("bimodal grid reports nothing", bimodal.outliers.length, 0);
eq("bimodal grid explains itself", /vary too much/.test(bimodal.note), true);

// At most two, highest ratio first.
const many = analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 1000, 1000, 6000, 5000, 4000]));
eq("capped at MAX_OUTLIERS", many.outliers.length, OUTLIER_TUNING.MAX_OUTLIERS);
eq("sorted by ratio, strongest first", many.outliers[0].value > many.outliers[1].value, true);

// A young post hasn't finished accumulating views. It is EXCLUDED, never
// called weak — and it must not be reported as an outlier either.
const young = analyzeGrid([
  ...videos([1000, 1000, 1000, 1000, 1000, 1000]),
  post({ isVideo: true, plays: 50000, takenAt: now - 1 * DAY, shortcode: "YOUNG" }),
]);
eq("post younger than MIN_AGE_DAYS is excluded", young.outliers.some((o) => o.shortcode === "YOUNG"), false);

// Same at the other end — 200 days is not comparable to last month.
const old = analyzeGrid([
  ...videos([1000, 1000, 1000, 1000, 1000, 1000]),
  post({ isVideo: true, plays: 50000, takenAt: now - 200 * DAY, shortcode: "OLD" }),
]);
eq("post older than MAX_AGE_DAYS is excluded", old.outliers.some((o) => o.shortcode === "OLD"), false);

// Video and image are never pooled — mixing plays with likes would make every
// reel an "outlier" on a photo-led account.
const mixed = analyzeGrid([
  ...videos([12000, 12000, 12000, 12000, 12000, 12000]),
  ...images([300, 300, 300, 300, 300, 300]),
]);
eq("buckets are not pooled", mixed.outliers.length, 0);

// Images are measured on likes.
const imageOutlier = analyzeGrid(images([300, 300, 300, 300, 300, 2000]));
eq("image outlier measured on likes", imageOutlier.outliers[0].metric, "likes");
eq("image outlier kind", imageOutlier.outliers[0].kind, "image");

// ---- degraded reads ----

// No dates at all: stricter ratio, and the note must say the comparison is rougher.
const undated = analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 6000], { takenAt: null }));
eq("no-dates basis", undated.basis, "no-dates");
eq("no-dates window is null", undated.windowDays, null);
eq("no-dates warns", /No post dates found/.test(undated.note), true);

// A ratio between RATIO and RATIO_NODATE must NOT qualify without dates.
const undatedWeak = analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 3500], { takenAt: null }));
eq("no-dates uses the stricter threshold", undatedWeak.outliers.length, 0);

// Counts read off the page overlay are rounded ("15.3K" could be 15,349).
const approx = analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 5000], { src: "dom" }));
eq("dom-sourced read is flagged approximate", approx.approx, true);
eq("approx note mentions rounding", /rounded/.test(approx.note), true);

// ---- the invariant that protects everyone's existing queue ----
// analyzeGrid must never return a score-shaped field. Reach is not ICP fit, and
// folding it into computeScore would silently re-rank every user's queue.
eq("returns no score field", "score" in one, false);
eq("returns no band field", "band" in one, false);

// ---- shouldPersistFromCapture: positive verdicts only ----
//
// Capture reads the user's own SPA-navigated tab, where Instagram's embedded
// JSON can be stale or half-hydrated. A negative verdict from there is not
// evidence the account is flat — it is just as likely evidence of a partial
// read — and writing it would set outlierCheckedAt, moving the account out of
// the reels filter's "not checked yet" bucket into "no outliers" and hiding
// exactly the accounts most worth enriching next. Only Enrich, which is a clean
// full page load, may record a negative.

eq("a real breakout persists from capture",
  shouldPersistFromCapture(analyzeGrid(videos([1000, 1000, 1000, 1000, 1000, 1000, 9000]))), true);

// Every refusal and every "we looked and found nothing" must stay unwritten.
eq("'nothing stands out' does NOT persist from capture",
  shouldPersistFromCapture(analyzeGrid(videos([1000, 1100, 1000, 1200, 1000, 1050, 1100]))), false);
eq("a grid with no counts does NOT persist from capture",
  shouldPersistFromCapture(analyzeGrid(videos([null, null, null, null, null, null]))), false);
eq("too small a sample does NOT persist from capture",
  shouldPersistFromCapture(analyzeGrid(videos([1000, 1000, 9000]))), false);
eq("an empty grid does NOT persist from capture",
  shouldPersistFromCapture(analyzeGrid([])), false);
// The bimodal bail-out returns ok:true with zero outliers — the shape most
// likely to slip through a naive `g.ok` check.
const splitGrid = analyzeGrid(videos([1000, 1000, 1000, 8000, 9000, 10000, 11000]));
eq("the bimodal bail-out is ok but empty", splitGrid.ok && splitGrid.outliers.length === 0, true);
eq("...and does NOT persist from capture", shouldPersistFromCapture(splitGrid), false);
eq("garbage does NOT persist from capture", shouldPersistFromCapture(null), false);

report();
