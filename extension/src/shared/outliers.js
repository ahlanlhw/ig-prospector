// Sprill — grid outlier analysis.
//
// Takes the raw tiles extractGridPosts() read off a profile grid and answers one
// narrow question: did any of these posts get unusual reach FOR THIS ACCOUNT?
//
// What this deliberately does NOT do:
//   - It never says WHY a post worked. A heuristic cannot know that, and the
//     product's job here is to point at the post so the user can go watch it.
//   - It never compares one account to another. Every number is relative to the
//     account's own median.
//   - It never feeds computeScore(). Reach is not ICP fit, and folding it in
//     would silently re-rank every existing user's queue.
//
// Pure and synchronous, same contract style as score.js: an invariant return
// shape, and `reasons`-style strings that are self-contained and human-readable.

export const OUTLIER_TUNING = {
  GRID_LIMIT: 12,          // what a profile grid renders on first paint (3x4)
  MIN_SAMPLE: 6,           // eligible posts needed before we claim anything
  RATIO: 3.0,              // vs the leave-one-out median, when dates are known
  RATIO_NODATE: 4.0,       // stricter when we can't exclude un-settled posts
  MIN_ABS_PLAYS: 1000,     // absolute floors, so ratio noise on tiny accounts
  MIN_ABS_LIKES: 200,      //   doesn't manufacture "outliers"
  MIN_AGE_DAYS: 3,         // younger posts are EXCLUDED, never called weak
  MAX_AGE_DAYS: 120,       // older posts have had far longer to accumulate
  MAX_OUTLIERS: 2,
  MAX_QUALIFY_FRACTION: 0.4, // if more than this qualifies, the median is meaningless
};

const DAY = 86400000;

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// One metric bucket: video posts measured on plays, image posts on likes.
// Never pooled — the two have completely different scales, and mixing them
// would make every reel an "outlier" on a photo-led account.
function analyzeBucket(posts, metric, floor, ratioThreshold) {
  const vals = posts.map((p) => p[metric]).filter((v) => typeof v === "number" && v >= 0);
  if (vals.length < OUTLIER_TUNING.MIN_SAMPLE) return { sample: vals.length, hits: [] };

  const hits = [];
  for (const p of posts) {
    const v = p[metric];
    if (typeof v !== "number" || v < floor) continue;
    // Leave-one-out: exclude the candidate from its own baseline. At n=6-12 a
    // single breakout post drags the baseline up enough to hide itself.
    const rest = posts.filter((q) => q !== p).map((q) => q[metric]).filter((x) => typeof x === "number" && x >= 0);
    const base = median(rest);
    if (!base || base <= 0) continue;
    const ratio = v / base;
    if (ratio >= ratioThreshold) hits.push({ post: p, metric, value: v, baseline: Math.round(base), ratio: round1(ratio) });
  }
  return { sample: vals.length, hits, eligible: posts.length };
}

/**
 * @param {Array} posts tiles from extractGridPosts()
 * @returns {{ok:boolean, note:string, basis:"dated"|"no-dates", sample:number,
 *            windowDays:number|null, approx:boolean, outliers:Array}}
 */
export function analyzeGrid(posts) {
  const none = (note, extra = {}) => ({
    ok: false, note, basis: "dated", sample: 0, windowDays: null, approx: false, outliers: [], ...extra,
  });

  const all = Array.isArray(posts) ? posts : [];
  if (!all.length) return none("No posts found on this grid.");

  // Pinned posts are old, sort first, and are usually the account's best ever.
  // Including them biases the baseline upward and hides genuine recent outliers.
  const unpinned = all.filter((p) => !p.pinned);
  if (!unpinned.length) return none("Only pinned posts on this grid — nothing to compare.");

  const dated = unpinned.filter((p) => typeof p.takenAt === "number" && p.takenAt > 0);
  const haveDates = dated.length >= OUTLIER_TUNING.MIN_SAMPLE;
  const basis = haveDates ? "dated" : "no-dates";
  const ratioThreshold = haveDates ? OUTLIER_TUNING.RATIO : OUTLIER_TUNING.RATIO_NODATE;

  let eligible;
  let windowDays = null;
  if (haveDates) {
    const now = Date.now();
    // A young post is EXCLUDED, never penalised: it simply hasn't finished
    // accumulating views, so it can be neither a baseline nor an outlier.
    eligible = dated.filter((p) => {
      const ageDays = (now - p.takenAt) / DAY;
      return ageDays >= OUTLIER_TUNING.MIN_AGE_DAYS && ageDays <= OUTLIER_TUNING.MAX_AGE_DAYS;
    });
    if (eligible.length) {
      const ts = eligible.map((p) => p.takenAt);
      windowDays = Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / DAY));
    }
  } else {
    // No dates: drop the two newest tiles in document order as a crude age proxy.
    eligible = unpinned.slice(2);
  }

  if (eligible.length < OUTLIER_TUNING.MIN_SAMPLE) {
    return none(
      `Only ${eligible.length} post${eligible.length === 1 ? "" : "s"} to compare — need ${OUTLIER_TUNING.MIN_SAMPLE}.`,
      { basis, sample: eligible.length },
    );
  }

  const video = eligible.filter((p) => p.isVideo);
  const image = eligible.filter((p) => !p.isVideo);

  const v = analyzeBucket(video, "plays", OUTLIER_TUNING.MIN_ABS_PLAYS, ratioThreshold);
  const i = analyzeBucket(image, "likes", OUTLIER_TUNING.MIN_ABS_LIKES, ratioThreshold);

  const sample = Math.max(v.sample || 0, i.sample || 0);
  if (!sample) {
    return none(
      "No view or like counts on this grid — Instagram hides them for some accounts.",
      { basis, sample: 0 },
    );
  }

  let hits = [...(v.hits || []), ...(i.hits || [])];

  // If a large share of posts "qualify", the distribution is bimodal — the
  // account changed format or cadence. That's not four viral posts, and calling
  // them outliers would be wrong.
  const qualifyingPool = (v.sample || 0) + (i.sample || 0);
  if (qualifyingPool && hits.length / qualifyingPool > OUTLIER_TUNING.MAX_QUALIFY_FRACTION) {
    return {
      ok: true, basis, sample, windowDays, approx: false, outliers: [],
      note: "Posts here vary too much to call any one of them an outlier.",
    };
  }

  hits.sort((a, b) => b.ratio - a.ratio);
  hits = hits.slice(0, OUTLIER_TUNING.MAX_OUTLIERS);

  const approx = hits.some((h) => h.post.src === "dom");
  const now = Date.now();
  const outliers = hits.map((h) => ({
    shortcode: h.post.shortcode,
    url: h.post.url,
    kind: h.post.isVideo ? "video" : "image",
    metric: h.metric,
    value: h.value,
    baseline: h.baseline,
    ratio: h.ratio,
    ageDays: typeof h.post.takenAt === "number" ? Math.round((now - h.post.takenAt) / DAY) : null,
  }));

  if (!outliers.length) {
    return {
      ok: true, basis, sample, windowDays, approx: false, outliers: [],
      note: `Nothing stands out — the last ${sample} posts are all within normal range for this account.`,
    };
  }

  // Copy rules: compare only against the account's own median, always attach the
  // sample size, never imply causation, never say "viral" or "engagement rate".
  let note = "Compared against this account's own median. It means the post got unusual reach for them — not why, and not versus anyone else.";
  if (!haveDates) note += " No post dates found, so very recent posts may still be gaining views — this is a rougher comparison.";
  if (approx) note += " Counts read from the page overlay are rounded (15.3K could be 15,349).";

  return { ok: true, note, basis, sample, windowDays, approx, outliers };
}

/**
 * May a verdict read off the user's OWN tab be written to the record?
 *
 * Only when it is positive. The Current tab runs against a page the user
 * SPA-navigated to, where Instagram's embedded JSON can be stale or only
 * half-hydrated — so a "nothing stands out" from there is not evidence of a flat
 * account, it is just as likely to be evidence of a partial read. Persisting it
 * would set outlierCheckedAt and move the account out of the reels filter's "not
 * checked yet" bucket into "no outliers", hiding exactly the accounts most worth
 * enriching next.
 *
 * A positive verdict cannot be manufactured that way: real play counts and a real
 * median had to be on the page for analyzeGrid to clear its floors and ratios.
 *
 * Enrich stays the only path allowed to record a negative — it is the only clean
 * full page load (fetchProfileViaTempTab).
 *
 * @param {ReturnType<typeof analyzeGrid>} g
 */
export function shouldPersistFromCapture(g) {
  return !!(g && g.ok && g.outliers && g.outliers.length);
}
