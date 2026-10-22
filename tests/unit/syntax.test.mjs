// Every shipped .js must parse.
//
// This repo has no build step, so a syntax error has nothing to catch it — it
// surfaces only as a silently broken extension after "Load unpacked", usually
// as a feature that does nothing rather than as an error you'd notice.
// `node --check` parses without executing, which is exactly what's wanted for
// files full of chrome.* calls.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { eq, report } from "../helpers/assert.mjs";

const root = fileURLToPath(new URL("../../extension/src/", import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = walk(root);
eq("found source files to check", files.length > 0, true);

for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  const name = `parses: ${relative(root, file).replace(/\\/g, "/")}`;
  if (r.status === 0) eq(name, true, true);
  else eq(name, (r.stderr || "").trim().split("\n").slice(0, 3).join(" | "), true);
}

report();
