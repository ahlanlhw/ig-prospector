// Sprill — the whole test vocabulary, in one file.
//
// Deliberately tiny: no framework, no npm, no install step. Each suite is a
// plain `node tests/unit/x.test.mjs` script that imports these three helpers,
// makes its assertions top-to-bottom, and calls report() last.
//
// report() prints a machine-readable `RESULT <pass> <fail>` line that
// tests/run.mjs greps to build the combined total. The child's *exit code* is
// the authority on pass/fail; the counts are only for the summary table.

let pass = 0;
let fail = 0;

/** Deep-ish equality by JSON shape. The workhorse — most assertions use this. */
export function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
  }
}

/**
 * Like eq(), but `want` may be an array of acceptable values. The rules suite
 * needs this: Firestore can answer a denied read with either 403 or 404
 * depending on the path, and both are correct.
 */
export function check(name, got, want) {
  const ok = Array.isArray(want) ? want.includes(got) : got === want;
  if (ok) {
    pass++;
    console.log(`  ok   ${name} (${got})`);
  } else {
    fail++;
    console.log(`  FAIL ${name}: got ${got}, want ${want}`);
  }
}

/** Print the tally, emit the machine-readable line, exit non-zero on failure. */
export function report() {
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`RESULT ${pass} ${fail}`);
  process.exit(fail ? 1 : 0);
}
