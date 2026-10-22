// Every name a file CALLS must be a name that file can see.
//
// This exists because of one bug that cost a whole release. `panel.js` called
// `updateProspect(...)` at four sites and the store's export was missing from
// its import block. `panel.js` is an ES module, so an unresolved identifier
// throws `ReferenceError` **at call time, not at load**: the file parses, every
// listener binds, every other button works, and the async click handler rejects
// unhandled — no toast, no re-render, nothing in the UI. The Queue → Shortlist
// promotion built in 0.13.0 therefore never worked at all, and nothing caught
// it: `syntax.test.mjs` only parses (an undefined identifier is valid syntax)
// and `panel.smoke.mjs` boots the panel but never clicks a bulk action — and it
// is optional, so it does not run at all without Playwright.
//
// Zero dependencies on purpose: this must run on a fresh clone, because the
// releases where it matters most are exactly the ones where nobody installed
// anything.
//
// The check is narrow so it can be trusted: for each consumer file, take the
// names that `shared/*.js` exports, subtract what the file imports and what it
// declares itself, and flag anything left that appears as a call. It cannot
// find a call to a name nothing exports (that is a typo, not this bug), and it
// deliberately does not try to be a scope analyser.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, report } from "../helpers/assert.mjs";

const src = fileURLToPath(new URL("../../extension/src/", import.meta.url));
const sharedDir = join(src, "shared");

// Names that are legitimately called without being imported: a local shadow the
// declaration scan can't see (a function parameter), or a browser global that
// happens to share a name with one of our exports. Add with a reason.
const ALLOW = {
  // (empty — every current call resolves)
};

/**
 * Strip comments and string/template literals so prose and sample code in the
 * (heavily commented) sources can't produce a call-shaped match. Removing a
 * template literal wholesale can hide a real call inside `${...}`, which costs
 * coverage but never invents a failure — the right way round for a gate.
 */
function stripNonCode(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Exported names of one module: `export function x`, `export const x`, `export class x`. */
function exportsOf(code) {
  const names = new Set();
  const re = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

/** Local names bound in this file, including `as` aliases from its imports. */
function localNames(code) {
  const names = new Set();
  const add = (re, group = 1) => { let m; while ((m = re.exec(code))) names.add(m[group]); };
  add(/(?:^|[^.\w$])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g);
  add(/(?:^|[^.\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g);
  add(/(?:^|[^.\w$])class\s+([A-Za-z_$][\w$]*)/g);
  // Destructured declarations: const { a, b: c } = ...
  let m;
  const de = /(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  while ((m = de.exec(code))) {
    for (const part of m[1].split(",")) {
      const bits = part.split(":");
      const name = (bits[bits.length - 1] || "").trim().replace(/\s*=.*$/, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Names this file imports, resolving `x as y` to the LOCAL name y. */
function importedNames(code) {
  const names = new Set();
  // The path is `""` by the time this runs — stripNonCode blanks every string
  // literal, so the quantifier here must accept an empty one.
  const re = /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']*["']/g;
  let m;
  while ((m = re.exec(code))) {
    for (const part of m[1].split(",")) {
      const bits = part.split(/\s+as\s+/);
      const name = (bits[bits.length - 1] || "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Every `name(` in the file that is not a property access. */
function calledNames(code) {
  const names = new Set();
  const re = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) names.add(m[2]);
  return names;
}

// ---- collect what shared/ offers -------------------------------------------

const sharedFiles = readdirSync(sharedDir).filter((f) => f.endsWith(".js"));
eq("shared modules found", sharedFiles.length > 0, true);

const sharedExports = new Map(); // name -> [module, ...]
for (const f of sharedFiles) {
  for (const name of exportsOf(readFileSync(join(sharedDir, f), "utf8"))) {
    sharedExports.set(name, (sharedExports.get(name) || []).concat(f));
  }
}
eq("shared exports collected", sharedExports.size > 20, true);

// ---- check each consumer ----------------------------------------------------

const CONSUMERS = [
  "sidepanel/panel.js",
  "content/instagram.js",
  "service-worker.js",
  ...sharedFiles.map((f) => "shared/" + f), // shared modules import each other too
];

for (const rel of CONSUMERS) {
  let raw;
  try { raw = readFileSync(join(src, rel), "utf8"); } catch { continue; }
  const code = stripNonCode(raw);
  const imported = importedNames(code);
  const local = localNames(code);
  const allowed = new Set(Object.keys(ALLOW));
  const missing = [];
  for (const name of calledNames(code)) {
    if (!sharedExports.has(name)) continue;   // not ours — not this check's business
    if (imported.has(name)) continue;         // imported: fine
    if (local.has(name)) continue;            // shadowed by a local: fine
    if (allowed.has(name)) continue;
    if (sharedExports.get(name).includes(rel.split("/").pop())) continue; // its own export
    missing.push(`${name} (exported by ${sharedExports.get(name).join(", ")})`);
  }
  eq(`no called-but-unimported names: ${rel}`, missing.sort(), []);
}

// ---- the checker itself, on known inputs ------------------------------------
//
// A guard nobody has seen fail is a guard nobody knows works. These pin the two
// behaviours the check rests on.

eq("detects a call to an unimported shared export", (() => {
  const code = stripNonCode(`import { a } from "../shared/x.js";\nfunction go(){ return updateProspect(1); }`);
  return !importedNames(code).has("updateProspect") && calledNames(code).has("updateProspect");
})(), true);

eq("a local declaration shadows a shared export", (() => {
  const code = stripNonCode(`const sleep = (ms) => 0;\nasync function go(){ await sleep(5); }`);
  return localNames(code).has("sleep");
})(), true);

eq("an `as` alias registers the local name", (() => {
  const code = stripNonCode(`import { signIn as googleSignIn } from "../shared/auth.js";`);
  const n = importedNames(code);
  return n.has("googleSignIn") && !n.has("signIn");
})(), true);

eq("a call named only inside a comment is ignored", (() => {
  const code = stripNonCode(`// remember to call updateProspect(p) here\nconst x = 1;`);
  return !calledNames(code).has("updateProspect");
})(), true);

eq("a method call is not mistaken for a bare call", (() => {
  const code = stripNonCode(`list.removeProspect(1);`);
  return !calledNames(code).has("removeProspect");
})(), true);

report();
