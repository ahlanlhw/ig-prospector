// Sprill — the default test run.  `node tests/run.mjs`
//
// Each suite runs in its OWN process, deliberately. store.test.mjs installs a
// callback-style chrome stub, sheets.test.mjs installs a promise-style one AND
// replaces globalThis.fetch, and every suite calls process.exit(). Running them
// in one process would cross-contaminate.
//
// The emulator-backed Firestore rules suite is NOT run here — it needs a daemon
// (see "Run the tests" in README.md). A default run that fails because something isn't
// running just trains you to ignore red.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SUITES = [
  "unit/syntax.test.mjs",
  "unit/imports.test.mjs",
  "unit/csv.test.mjs",
  "unit/store.test.mjs",
  "unit/drafts.test.mjs",
  "unit/sheets.test.mjs",
  "unit/outliers.test.mjs",
  "unit/recorder.test.mjs",
  // Zero-dependency ON PURPOSE, even though it tests content-script code: the
  // embed resolver decides which account gets a DM, and extract.test.mjs (the
  // other content-script suite) skips without jsdom. See its header.
  "unit/embed.test.mjs",
  "unit/hardening.test.mjs",
  "unit/cull.test.mjs",
  // Optional: skips cleanly (RESULT 0 0) unless jsdom is installed. It is the
  // one suite with a dependency, and the repo's contract is that a fresh clone
  // needs no install — so it must never be the reason a clean checkout goes red.
  "unit/extract.test.mjs",
  // Optional too, and the only suite that opens a browser: it loads panel.html in
  // Chromium against a chrome.* stub and asserts the panel boots, switches tabs and
  // renders seeded data without throwing. panel.js is ~2,400 lines of DOM wiring
  // whose usual failure is a TypeError during an unawaited boot() — which leaves
  // the panel half-wired and reports nothing. Nothing here touches Instagram.
  //   npm install --no-save playwright
  "smoke/panel.smoke.mjs",
];

let pass = 0, fail = 0, broke = 0;
const rows = [];

for (const rel of SUITES) {
  const file = fileURLToPath(new URL(rel, import.meta.url));
  const started = process.hrtime.bigint();
  // process.execPath, never "node": no PATH lookup, no .cmd shim, no shell
  // quoting — identical behaviour from PowerShell, Git Bash and CI.
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  const name = rel.replace(/^(unit|smoke)\//, "").replace(/\.(test|smoke)\.mjs$/, "");
  const m = /^RESULT (\d+) (\d+)$/m.exec(r.stdout || "");

  if (r.stdout) {
    // Only echo the noisy bits: failures, and anything on stderr.
    const failures = r.stdout.split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("  "));
    if (r.status !== 0 && failures.length) {
      console.log(`\n--- ${name} ---`);
      console.log(r.stdout.trimEnd());
    }
  }
  if (r.stderr) process.stderr.write(r.stderr);

  if (!m) {
    // Crashed before it could report. The exit code is the authority.
    broke++;
    rows.push([name, "CRASHED", "—", ms]);
    continue;
  }
  pass += +m[1];
  fail += +m[2];
  // A suite that reports 0/0 declined to run — today that means extract.test.mjs
  // without jsdom. "0 passed" reads like a broken suite; say what happened.
  const skipped = m[1] === "0" && m[2] === "0";
  rows.push([name, skipped ? "skipped" : `${m[1]} passed`,
             +m[2] ? `${m[2]} FAILED` : (skipped ? (name === "panel" ? "(needs playwright)" : "(needs jsdom)") : ""), ms]);
}

const w = Math.max(...rows.map((r) => r[0].length));
console.log("");
for (const [name, a, b, ms] of rows) {
  console.log(`  ${name.padEnd(w)}  ${a.padEnd(12)} ${b.padEnd(10)} ${ms.toFixed(0).padStart(5)} ms`);
}
console.log(`\n  ${"TOTAL".padEnd(w)}  ${pass} passed, ${fail} failed${broke ? `, ${broke} crashed` : ""}`);
console.log("\n  Firestore rules (27 checks) not run. See README.md, Run the tests.");

process.exit(fail || broke ? 1 : 0);
