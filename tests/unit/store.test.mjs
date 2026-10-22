// store.js — merge semantics for saveProspects(), key migration, and the
// storage-failure contract.
//
// This is TESTING.md §22's regression trap in unit form. If only one suite
// survives, it should be this one: a sparse CSV re-import that blanks an
// enriched bio, or flips a Contacted lead back to New, is silent data loss.

import { installChromeStub } from "../helpers/chrome-stub.mjs";
import { eq, report } from "../helpers/assert.mjs";

// The stub must exist before store.js evaluates, hence the dynamic imports.
const stub = installChromeStub({
  seed: {
    // An enriched, already-contacted prospect.
    prospects: {
      "id:999": {
        userId: "999", username: "alice", bio: "Founder of Acme", followers: 5000,
        score: 87, status: "Contacted", capturedAt: "2026-01-01T00:00:00.000Z",
        sourceAccount: "mybrand", emails: ["a@acme.com"],
      },
    },
  },
});

const store = await import("../../extension/src/shared/store.js");
const { parseCsv, mapCsvRows } = await import("../../extension/src/shared/csv.js");

// A sparse CSV that mentions alice with blank columns everywhere else.
const csv = "username,bio,followers,score,status\nalice,,,,\nbob,New guy,100,,\n";
const { records, skipped } = mapCsvRows(parseCsv(csv));
const defaults = {
  status: "New", sourceType: "csv",
  capturedAt: "2026-07-26T00:00:00.000Z", sourceAccount: "otheracct",
};
const res = await store.saveProspects(records, defaults);

eq("skipped", skipped, 0);
eq("added/merged", res, { added: 1, merged: 1 });

const after = await store.getProspects();
const alice = after["id:999"];

// The whole point: a sparse re-import must not destroy enrichment.
eq("bio kept", alice.bio, "Founder of Acme");
eq("followers kept", alice.followers, 5000);
eq("score kept", alice.score, 87);
eq("emails kept", alice.emails, ["a@acme.com"]);
eq("status NOT reset to New", alice.status, "Contacted");
eq("capturedAt NOT overwritten", alice.capturedAt, "2026-01-01T00:00:00.000Z");
eq("sourceAccount NOT reassigned", alice.sourceAccount, "mybrand");
eq("userId kept", alice.userId, "999");

// New record gets the defaults.
const bob = after["h:bob"];
eq("bob created", !!bob, true);
eq("bob defaults applied", [bob.status, bob.sourceType, bob.sourceAccount], ["New", "csv", "otheracct"]);
eq("bob csv values", [bob.bio, bob.followers], ["New guy", 100]);
eq("bob profileUrl derived", bob.profileUrl, "https://www.instagram.com/bob/");

// Re-importing the exact same file again must not duplicate.
const res2 = await store.saveProspects(mapCsvRows(parseCsv(csv)).records, defaults);
eq("second import merges both", res2, { added: 0, merged: 2 });
eq("no duplicate keys", Object.keys(await store.getProspects()).sort(), ["h:bob", "id:999"]);

// A CSV carrying a userId must migrate the handle key to the id key, not
// duplicate. This exercises findExistingKey (store.js:152-167), the most
// recently rewritten thing in the module.
const withId = mapCsvRows(parseCsv("username,userId\nbob,4242")).records;
await store.saveProspects(withId, defaults);
const keys = Object.keys(await store.getProspects()).sort();
eq("handle key migrated to id key", keys, ["id:4242", "id:999"]);
eq("bob data survived migration", (await store.getProspects())["id:4242"].bio, "New guy");

// A failing write must REJECT rather than silently resolve — otherwise a full
// quota reports "Imported 4,000" while nothing was written.
stub.failNextSet("QUOTA_BYTES quota exceeded");
let threw = false;
try { await store.saveProspects([{ username: "quotatest" }], {}); }
catch (e) { threw = /quota/i.test(e.message); }
eq("quota failure surfaces as a rejection", threw, true);

// storageUsage() needs getBytesInUse + QUOTA_BYTES, which the old hand-rolled
// stub didn't have. panel.js calls this on every Settings render.
const usage = await store.storageUsage();
eq("storageUsage counts bytes", usage.bytes > 0, true);

// The manifest declares "unlimitedStorage", but QUOTA_BYTES still reports the
// 10 MB constant regardless — so dividing by it told CSV-import users they were
// nearly full against a ceiling that had been waived. With the permission
// granted there is no percentage to quote, and pct must be null rather than a
// misleading number.
eq("unlimitedStorage is detected", usage.unlimited, true);
eq("no percentage when there is no ceiling", usage.pct, null);

// ...and when the permission ISN'T granted, the percentage is real again.
installChromeStub({ seed: { prospects: { "id:1": { username: "x" } } }, permissions: ["storage"] });
const capped = await (await import("../../extension/src/shared/store.js")).storageUsage();
eq("capped install reports a ceiling", capped.quota, 10485760);
eq("capped install reports a percentage", typeof capped.pct, "number");

// ---- CSV column defaults and the `posts` migration ----
//
// `posts` was extracted, stored, rendered and sortable long before it was
// exportable, so a hitlist enriched for follower and post counts lost one of the
// two on the way to the CSV.
eq("posts is a default column", store.DEFAULT_FIELDS.includes("posts"), true);
eq("followers is still a default column", store.DEFAULT_FIELDS.includes("followers"), true);
eq("posts sits beside followers",
  store.DEFAULT_FIELDS.indexOf("posts") - store.DEFAULT_FIELDS.indexOf("followers"), 1);
eq("lastPostBasis was not added", store.ALL_FIELDS.includes("lastPostBasis"), false);

// A user with no saved column set just gets the new defaults.
const freshStub = installChromeStub({ seed: {} });
const fresh = await (await import("../../extension/src/shared/store.js")).getCsvFields();
eq("fresh install gets posts", fresh.includes("posts"), true);

// A user who HAS customized gets it spliced in once, next to followers.
// Every fixture below carries `sourceAccount` so it isolates THIS migration:
// each migration in getCsvFields() returns early, so a set missing two columns
// gains one per call. That self-corrects on the next render and is pre-existing
// behaviour, but it makes a fixture missing sourceAccount test the wrong thing.
freshStub.seed({ csvFields: ["username", "followers", "score", "sourceAccount"], outlierColMigrated: true });
const s1 = await store.getCsvFields();
eq("customized set gains posts", s1, ["username", "followers", "posts", "score", "sourceAccount"]);
eq("migration marker written", freshStub.db().postsColMigrated, true);

// Idempotent: running again changes nothing.
eq("migration is idempotent", await store.getCsvFields(), ["username", "followers", "posts", "score", "sourceAccount"]);

// THE POINT OF THE MARKER. Keyed on the field's own absence (the sourceAccount
// pattern), removing the column by hand would resurrect it on every single load.
freshStub.seed({ csvFields: ["username", "score", "sourceAccount"], outlierColMigrated: true, postsColMigrated: true });
eq("hand-removed column stays removed", await store.getCsvFields(), ["username", "score", "sourceAccount"]);

// No `followers` column to anchor to — append rather than throw on indexOf -1.
freshStub.seed({ csvFields: ["username", "score", "sourceAccount"], outlierColMigrated: true });
eq("appends when followers absent", await store.getCsvFields(), ["username", "score", "sourceAccount", "posts"]);

report();
