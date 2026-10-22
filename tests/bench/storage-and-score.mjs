// Not a test — a measurement. Run it by hand when a decision depends on the
// numbers:  node tests/bench/storage-and-score.mjs
//
// Two questions it answers:
//   1. How many prospects fit in chrome.storage.local? (This is why the
//      manifest declares "unlimitedStorage" — a CSV import can blow past 10 MB.)
//   2. How expensive is computeScore? renderQueue re-scores on EVERY render, so
//      this is the cost of scrolling the queue.

const { computeScore } = await import("../../extension/src/shared/score.js");

// A realistically enriched record — what one looks like after enrichList().
const enriched = {
  userId: "12345678901", username: "acmestudio", displayName: "Acme Studio",
  profileUrl: "https://www.instagram.com/acmestudio/", accountType: "business",
  category: "Marketing Agency",
  bio: "We help D2C founders scale with performance creative. 200+ brands served. DMs open for collabs — link below for our case studies.",
  followers: 18400, following: 812, posts: 640, verified: false, isPrivate: false,
  score: 82, band: "Strong", reasons: ["Bio matches 'd2c'", "Bio matches 'founder'", "Business account", "Has link in bio"],
  concerns: ["Large following — may be slow to reply"],
  businessSignals: ["email in bio", "link in bio", "category set"],
  linkInBio: "https://acmestudio.co/case-studies", links: ["https://acmestudio.co"],
  emails: ["hello@acmestudio.co"], phones: ["+1 555 0100"], mentionedHandles: ["@acmefounder"],
  publicContactButtons: ["Email", "Call"],
  outliers: { at: "2026-07-26T10:00:00.000Z", n: 9, basis: "dated", windowDays: 62,
    top: [{ c: "Cabc123", k: "v", m: "plays", v: 41200, b: 9800, r: 4.2, a: 21 }] },
  outlierCount: 1, outlierTopRatio: 4.2,
  outlierTopUrl: "https://www.instagram.com/reel/Cabc123/",
  outlierCheckedAt: "2026-07-26T10:00:00.000Z",
  sourceType: "scan", sourceUrl: "https://www.instagram.com/somebrand/followers/",
  sourceAccount: "mybrand", status: "Captured", capturedAt: "2026-07-26T10:00:00.000Z",
};

const contacted = {
  ...enriched, status: "Contacted", lastContactedAt: "2026-07-26T11:00:00.000Z",
  lastSourceHandle: "mybrand", outreachCount: 2, followUpAt: "2026-07-29T11:00:00.000Z",
  outreach: [
    { at: "2026-07-26T11:00:00.000Z", type: "oneclick", method: "click", source: { username: "mybrand", userId: "999" },
      text: "Hi Acme — came across your case studies and wanted to reach out. I think there may be a good reason for us to connect. Open to a quick chat this week?" },
    { at: "2026-07-29T11:00:00.000Z", type: "batch", method: "enter", source: { username: "mybrand", userId: "999" },
      text: "Hi Acme, just floating this back to the top in case it slipped by. Still happy to share how we could help — worth a quick chat?" },
  ],
};

const QUOTA = 10 * 1024 * 1024; // chrome.storage.local QUOTA_BYTES without unlimitedStorage
const cases = [
  ["handle-only (CSV import)", {
    username: "someone", profileUrl: "https://www.instagram.com/someone/",
    status: "New", sourceType: "csv", capturedAt: "2026-07-26T10:00:00.000Z",
  }],
  ["enriched", enriched],
  ["enriched + 2 messages sent", contacted],
];

for (const [label, rec] of cases) {
  const bytes = new TextEncoder().encode(JSON.stringify(rec)).length;
  console.log(`${label.padEnd(28)} ${String(bytes).padStart(5)} B/record  ->  ~${Math.floor(QUOTA / bytes).toLocaleString()} records fills 10 MB`);
}

const icp = {
  keywords: ["founder", "ceo", "d2c", "ecommerce", "brand", "startup", "saas", "agency"],
  description: "D2C brands",
};
for (const n of [1000, 5000]) {
  const set = Array.from({ length: n }, () => enriched);
  const t = process.hrtime.bigint();
  for (const p of set) computeScore(p, icp);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`computeScore x${n}: ${ms.toFixed(0)} ms  (renderQueue does this on EVERY render)`);
}
