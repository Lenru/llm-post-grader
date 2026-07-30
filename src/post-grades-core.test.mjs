import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSIONS,
  RUBRIC_VERSION,
  RAW_TOTAL,
  SCORE_MAX,
  bandFor,
  normalizeScores,
  overallOf,
  rawTotalOf,
  pendingRefs,
  summarize,
  formatReportCard,
} from "./post-grades-core.mjs";
import { parsePostFile, postRefFor } from "./grade-sweep.mjs";

const full = { hook: 5, voice: 5, clarity: 5, icp: 5, structure: 5, closer: 5 };

test("DIMENSIONS is the six keys in fixed order", () => {
  assert.deepEqual(DIMENSIONS, ["hook", "voice", "clarity", "icp", "structure", "closer"]);
  assert.equal(RUBRIC_VERSION, "v2");
});

test("bandFor maps 0-100 scores to bands at the documented edges", () => {
  assert.equal(bandFor(100), "A");
  assert.equal(bandFor(90), "A");
  assert.equal(bandFor(89), "B");
  assert.equal(bandFor(80), "B");
  assert.equal(bandFor(79), "C");
  assert.equal(bandFor(70), "C");
  assert.equal(bandFor(69), "D");
  assert.equal(bandFor(60), "D");
  assert.equal(bandFor(59), "F");
  assert.equal(bandFor(0), "F");
});

test("normalizeScores accepts a complete valid set and drops extra keys", () => {
  const out = normalizeScores({ ...full, bogus: 9 });
  assert.deepEqual(out, full);
});

test("normalizeScores rejects missing keys, out of range, and non-integers", () => {
  assert.throws(() => normalizeScores({ hook: 5 }), /missing/i);
  assert.throws(() => normalizeScores({ ...full, voice: 6 }), /voice/);
  assert.throws(() => normalizeScores({ ...full, voice: -1 }), /voice/);
  assert.throws(() => normalizeScores({ ...full, clarity: 2.5 }), /clarity/);
  assert.throws(() => normalizeScores({ ...full, icp: "3" }), /icp/);
});

test("rawTotalOf still returns the plain 0-30 sum", () => {
  assert.equal(rawTotalOf(full), 30);
  assert.equal(rawTotalOf({ hook: 1, voice: 2, clarity: 3, icp: 0, structure: 4, closer: 5 }), 15);
});

test("overallOf converts the raw sum to a 0-100 score", () => {
  assert.equal(overallOf(full), 100);
  // raw 15 / 30 * 100 = 50
  assert.equal(overallOf({ hook: 1, voice: 2, clarity: 3, icp: 0, structure: 4, closer: 5 }), 50);
});

test("RAW_TOTAL and SCORE_MAX are the documented ceilings", () => {
  assert.equal(RAW_TOTAL, 30);
  assert.equal(SCORE_MAX, 100);
});

test("pendingRefs returns disk refs not yet graded, order preserved, deduped", () => {
  assert.deepEqual(pendingRefs(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(pendingRefs(["a", "a", "b"], []), ["a", "b"]);
  assert.deepEqual(pendingRefs([], ["a"]), []);
  assert.deepEqual(pendingRefs(["a"], ["a"]), []);
});

test("summarize returns null for no rows", () => {
  assert.equal(summarize([]), null);
});

test("summarize averages overall and each dimension, and names the weakest", () => {
  // overall values are 0-100, matching what overallOf now produces: full is
  // 100, and the raw-18 row (4+2+4+3+3+2=18) is 18/30*100 = 60.
  const rows = [
    { overall: 100, scores: full },
    { overall: 60, scores: { hook: 4, voice: 2, clarity: 4, icp: 3, structure: 3, closer: 2 } },
  ];
  const s = summarize(rows);
  assert.equal(s.count, 2);
  assert.equal(s.avgOverall, 80);
  assert.equal(s.byDimension.hook, 4.5);
  assert.equal(s.byDimension.voice, 3.5);
  // voice and closer both average 3.5; the tie goes to voice, the earlier
  // dimension in DIMENSIONS. Asserting "closer" here would demand an
  // incoherent rule, since the sibling test below requires earliest-wins.
  assert.equal(s.weakest.dim, "voice");
  assert.equal(s.weakest.avg, 3.5);
});

test("summarize breaks weakest ties by DIMENSIONS order", () => {
  // raw 1+1+3+3+2+2=12, 12/30*100 = 40.
  const rows = [{ overall: 40, scores: { hook: 1, voice: 1, clarity: 3, icp: 3, structure: 2, closer: 2 } }];
  assert.equal(summarize(rows).weakest.dim, "hook");
});

test("formatReportCard names the weakest dimension and stays under the Discord limit", () => {
  // raw 5+3+4+4+4+4=24, 24/30*100 = 80.
  const summary = summarize([{ overall: 80, scores: { hook: 5, voice: 3, clarity: 4, icp: 4, structure: 4, closer: 4 } }]);
  const recent = [{ post_title: "VW short squeeze", grade: "C", overall: 75, notes: "coined term in the close" }];
  const out = formatReportCard({ summary, recent, prevSummary: null, skipped: [] });
  assert.match(out, /Post report card/);
  assert.match(out, /voice/);
  assert.match(out, /VW short squeeze/);
  assert.ok(out.length <= 1900, `report card too long: ${out.length}`);
  assert.ok(!out.includes("\u2014"), "report card must not contain an em-dash");
});

test("formatReportCard handles an empty week without crashing", () => {
  const out = formatReportCard({ summary: null, recent: [], prevSummary: null, skipped: [] });
  assert.match(out, /nothing new/i);
  assert.ok(out.length <= 1900);
});

test("formatReportCard shows the trend against the previous period and lists skips", () => {
  const summary = summarize([{ overall: 84, scores: full }]);
  const prevSummary = summarize([{ overall: 78, scores: full }]);
  const out = formatReportCard({ summary, recent: [], prevSummary, skipped: ["2026-07-02_linkedin_broken.md"] });
  assert.match(out, /\+6/);
  assert.match(out, /skipped/i);
  assert.match(out, /broken/);
});

test("formatReportCard truncates a huge recent list rather than exceeding the limit", () => {
  const summary = summarize([{ overall: 84, scores: full }]);
  const recent = Array.from({ length: 60 }, (_, i) => ({
    post_title: `A fairly long post title number ${i} about market structure`,
    grade: "B",
    overall: 84,
    notes: "a reasonably long note about what cost points on this particular post",
  }));
  const out = formatReportCard({ summary, recent, prevSummary: null, skipped: [] });
  assert.ok(out.length <= 1900, `report card too long: ${out.length}`);
});

test("parsePostFile strips frontmatter and returns the body plus title", () => {
  const raw = [
    "---",
    "title: FedNow deposit rails",
    "status: PASS",
    "---",
    "",
    "Instant payments changed the deposit game.",
    "",
    "Second paragraph.",
  ].join("\n");
  const parsed = parsePostFile(raw);
  assert.equal(parsed.title, "FedNow deposit rails");
  assert.match(parsed.body, /^Instant payments/);
  assert.match(parsed.body, /Second paragraph\./);
  assert.ok(!parsed.body.includes("status: PASS"));
});

test("parsePostFile falls back to the first heading when frontmatter has no title", () => {
  const parsed = parsePostFile("---\nstatus: PASS\n---\n\n# Copper grid buildout\n\nBody text here.");
  assert.equal(parsed.title, "Copper grid buildout");
  assert.match(parsed.body, /Body text here/);
});

test("parsePostFile handles a file with no frontmatter at all", () => {
  const parsed = parsePostFile("Just a body, no frontmatter.\n");
  assert.equal(parsed.body.trim(), "Just a body, no frontmatter.");
});

test("parsePostFile returns an empty body for a frontmatter-only file so the sweep can skip it", () => {
  const parsed = parsePostFile("---\ntitle: Empty\n---\n\n   \n");
  assert.equal(parsed.body.trim(), "");
});

test("postRefFor produces a stable relative ref regardless of path separators", () => {
  const win = String.raw`C:\Users\me\Desktop\clients\noah-finance\distribution\scheduled\2026-07-02_linkedin_fednow-deposit-rails.md`;
  assert.equal(postRefFor(win), "distribution/scheduled/2026-07-02_linkedin_fednow-deposit-rails.md");
  const nix = "/c/Users/me/Desktop/clients/noah-finance/distribution/published/2026-07-10_linkedin_x.md";
  assert.equal(postRefFor(nix), "distribution/published/2026-07-10_linkedin_x.md");
});
