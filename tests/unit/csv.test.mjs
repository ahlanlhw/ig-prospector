// csv.js — parsing, handle normalization, and row mapping.
//
// The assertion that matters most is "blank cols dropped": a sparse CSV must
// carry no keys for its empty columns, because saveProspects() merges by key
// and an empty string would overwrite an enriched value. That is TESTING.md
// §22's regression trap, caught here before it needs a human.

import { parseCsv, csvValue, mapCsvRows, normalizeHandle, handleFromUrl, parseHandleList }
  from "../../extension/src/shared/csv.js";
import { eq, report } from "../helpers/assert.mjs";

// 1. round-trip of the export format
const bio = 'Founder, CEO — "growth" guy\nDMs open';
const line = ["alice", bio, "1,234"].map(csvValue).join(",");
const rt = parseCsv("username,bio,followers\n" + line);
eq("roundtrip headers", rt.headers, ["username", "bio", "followers"]);
eq("roundtrip quoted+newline+quotes", rt.rows[0], ["alice", bio, "1,234"]);

// 2. line endings
eq("CRLF", parseCsv("a,b\r\n1,2\r\n").rows, [["1", "2"]]);
eq("LF", parseCsv("a,b\n1,2\n").rows, [["1", "2"]]);
eq("lone CR", parseCsv("a,b\r1,2").rows, [["1", "2"]]);
eq("no trailing newline", parseCsv("a,b\n1,2").rows, [["1", "2"]]);

// 3. BOM — what Excel writes
eq("BOM stripped", parseCsv("﻿username\nalice").headers, ["username"]);

// 4. empty file
eq("empty", parseCsv(""), { headers: [], rows: [] });
eq("null", parseCsv(null), { headers: [], rows: [] });

// 5. empty fields preserved positionally
eq("empty fields", parseCsv("a,b,c\n1,,3").rows[0], ["1", "", "3"]);

// 6. handle normalization
eq("strip @", normalizeHandle("@alice"), "alice");
eq("url in username col", normalizeHandle("https://www.instagram.com/bob/"), "bob");
eq("post url is not a handle", handleFromUrl("https://www.instagram.com/p/Cxyz123/"), null);
eq("reel url is not a handle", handleFromUrl("https://instagram.com/reel/abc/"), null);
eq("profile url", handleFromUrl("https://www.instagram.com/carol/?hl=en"), "carol");

// 7. mapping: empties dropped so enrichment is not clobbered
const m = mapCsvRows(parseCsv(
  "username,bio,followers,emails,verified,unknown_col\n" +
  "@dave,,,,,junk\n" +
  "erin,hi there,2500,a@x.com; b@y.com,true,junk\n"
));
eq("mapped count", m.records.length, 2);
eq("blank cols dropped", Object.keys(m.records[0]).sort(), ["profileUrl", "username"]);
eq("derived profileUrl", m.records[0].profileUrl, "https://www.instagram.com/dave/");
eq("numeric coerced", m.records[1].followers, 2500);
eq("array split", m.records[1].emails, ["a@x.com", "b@y.com"]);
eq("bool coerced", m.records[1].verified, true);
eq("unknown col ignored", m.records[1].unknown_col, undefined);

// 8. rows with no resolvable handle are skipped, not saved
const bad = mapCsvRows(parseCsv("username,bio\n,orphan bio\n,\nfrank,ok"));
eq("skipped headless rows", bad.skipped, 1);
eq("kept good row", bad.records.map((r) => r.username), ["frank"]);

// 9. handle-only CSV (the hand-written case)
const only = mapCsvRows(parseCsv("username\nalice\nbob\n"));
eq("handle-only count", only.records.length, 2);

// 10. profileUrl-only CSV
const urlOnly = mapCsvRows(parseCsv("profileUrl\nhttps://www.instagram.com/gina/\n"));
eq("username derived from url", urlOnly.records[0].username, "gina");

// 11. numeric that isn't numeric
eq("bad number dropped", mapCsvRows(parseCsv("username,followers\nhal,N/A")).records[0].followers, undefined);


// 12. headerRecognized — the gate the headerless fallback gates on.
//
// It is NOT "mapCsvRows found nothing": a real Sprill export with a good header
// and zero usable rows must keep its existing error rather than be re-read as a
// handle list, which would import its own "userId" header cell as lead #1.
eq("header recognized", mapCsvRows(parseCsv("username,bio\nalice,hi")).headerRecognized, true);
eq("header recognized, no rows", mapCsvRows(parseCsv("userId,username,followers\n")).headerRecognized, true);
eq("header unrecognized", mapCsvRows(parseCsv("alice\nbob")).headerRecognized, false);

// 13. parseHandleList — a hitlist with no header row at all.
const hl = parseHandleList(parseCsv("alice\n@bob\nhttps://www.instagram.com/carol/\n"));
eq("handle list count", hl.records.length, 3);
eq("handle list usernames", hl.records.map((r) => r.username), ["alice", "bob", "carol"]);
eq("handle list profileUrl", hl.records[0].profileUrl, "https://www.instagram.com/alice/");

// The first line IS a candidate — parseCsv puts a headerless file's line 1 in
// `headers`, and dropping it would silently lose the user's first prospect.
eq("first line kept", parseHandleList(parseCsv("solo")).records.map((r) => r.username), ["solo"]);

// Only the FIRST cell of a line, so a wide file can't donate its second column.
eq("first cell only", parseHandleList(parseCsv("alice,junk\nbob,junk")).records.map((r) => r.username), ["alice", "bob"]);

// CRLF and BOM come free by taking parseCsv output rather than raw text.
eq("handle list CRLF", parseHandleList(parseCsv("alice\r\nbob\r\n")).records.length, 2);
eq("handle list BOM", parseHandleList(parseCsv("\ufeffalice\nbob")).records.map((r) => r.username), ["alice", "bob"]);

// Case-insensitive dedupe.
const dup = parseHandleList(parseCsv("alice\nALICE\nbob"));
eq("handle list deduped", dup.records.map((r) => r.username), ["alice", "bob"]);
eq("handle list dupe counted", dup.skipped, 1);

// 14. What parseHandleList must REFUSE.
//
// Header words matter most: `userId` is the first cell of Sprill's own export
// header, so without that rule the app's own file creates a lead named after a
// column. Post URLs are already covered by NOT_HANDLES.
eq("rejects header word", parseHandleList(parseCsv("username\nalice\nbob")).records.map((r) => r.username), ["alice", "bob"]);
eq("rejects userId header", parseHandleList(parseCsv("userId\nalice\nbob")).records.map((r) => r.username), ["alice", "bob"]);
// Sized like a real list: the ratio guard below is a proportion, so a stray bad
// line among a handful of good ones must not sink the whole import.
const GOOD = "alice\nbob\ncarol\ndave\nerin";
eq("rejects post url", parseHandleList(parseCsv(GOOD + "\nhttps://www.instagram.com/p/Cabc123/")).records.length, 5);
eq("rejects over-30-char", parseHandleList(parseCsv(GOOD + "\n" + "z".repeat(31))).records.length, 5);
// A leading column name is expected at the top of a hand-made list and is NOT
// counted against the ratio — without that exemption "handle/alice/bob" is
// 2-of-3 valid, under the floor, and the whole file would be refused.
eq("short list with header word kept", parseHandleList(parseCsv("handle\nalice\nbob")).records.map((r) => r.username), ["alice", "bob"]);

// 15. The whole-file sanity ratio.
//
// A bio-only CSV yields a scattering of single-word cells that pass the charset
// test. Importing those dregs would be a quiet wrong answer, so below ~80% valid
// the file is refused outright rather than partly believed.
const prose = parseHandleList(parseCsv("bio\nFounder of Acme and also a dad\nWe make great coffee\nhello\nworld"));
eq("prose refused", prose.records.length, 0);
eq("prose counted as skipped", prose.skipped > 0, true);
eq("empty refused", parseHandleList(parseCsv("")).records.length, 0);
// A real list with one bad line still imports — the guard is a ratio, not a veto.
eq("mostly-valid list kept", parseHandleList(parseCsv("alice\nbob\ncarol\ndave\nnot a handle!")).records.length, 4);

report();
