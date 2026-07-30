import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIMENSIONS,
  RUBRIC_VERSION,
  bandFor,
  normalizeScores,
  overallOf,
  pendingRefs,
  summarize,
  formatReportCard,
} from "./post-grades-core.mjs";

const full = { hook: 5, voice: 5, clarity: 5, icp: 5, structure: 5, closer: 5 };

test("DIMENSIONS is the six keys in fixed order", () => {
  assert.deepEqual(DIMENSIONS, ["hook", "voice", "clarity", "icp", "structure", "closer"]);
  assert.equal(RUBRIC_VERSION, "v1");
});

test("bandFor maps totals to bands at the documented edges", () => {
  assert.equal(bandFor(30), "A");
  assert.equal(bandFor(27), "A");
  assert.equal(bandFor(26), "B");
  assert.equal(bandFor(23), "B");
  assert.equal(bandFor(22), "C");
  assert.equal(bandFor(18), "C");
  assert.equal(bandFor(17), "D");
  assert.equal(bandFor(12), "D");
  assert.equal(bandFor(11), "F");
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

test("overallOf sums the six dimensions", () => {
  assert.equal(overallOf(full), 30);
  assert.equal(overallOf({ hook: 1, voice: 2, clarity: 3, icp: 0, structure: 4, closer: 5 }), 15);
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
  const rows = [
    { overall: 30, scores: full },
    { overall: 18, scores: { hook: 4, voice: 2, clarity: 4, icp: 3, structure: 3, closer: 2 } },
  ];
  const s = summarize(rows);
  assert.equal(s.count, 2);
  assert.equal(s.avgOverall, 24);
  assert.equal(s.byDimension.hook, 4.5);
  assert.equal(s.byDimension.voice, 3.5);
  assert.equal(s.weakest.dim, "closer");
  assert.equal(s.weakest.avg, 3.5);
});

test("summarize breaks weakest ties by DIMENSIONS order", () => {
  const rows = [{ overall: 12, scores: { hook: 1, voice: 1, clarity: 3, icp: 3, structure: 2, closer: 2 } }];
  assert.equal(summarize(rows).weakest.dim, "hook");
});

test("formatReportCard names the weakest dimension and stays under the Discord limit", () => {
  const summary = summarize([{ overall: 24, scores: { hook: 5, voice: 3, clarity: 4, icp: 4, structure: 4, closer: 4 } }]);
  const recent = [{ post_title: "VW short squeeze", grade: "C", overall: 20, notes: "coined term in the close" }];
  const out = formatReportCard({ summary, recent, prevSummary: null, skipped: [] });
  assert.match(out, /Post report card/);
  assert.match(out, /voice/);
  assert.match(out, /VW short squeeze/);
  assert.ok(out.length <= 1900, `report card too long: ${out.length}`);
  assert.ok(!out.includes("—"), "report card must not contain an em-dash");
});

test("formatReportCard handles an empty week without crashing", () => {
  const out = formatReportCard({ summary: null, recent: [], prevSummary: null, skipped: [] });
  assert.match(out, /nothing new/i);
  assert.ok(out.length <= 1900);
});

test("formatReportCard shows the trend against the previous period and lists skips", () => {
  const summary = summarize([{ overall: 24, scores: full }]);
  const prevSummary = summarize([{ overall: 18, scores: full }]);
  const out = formatReportCard({ summary, recent: [], prevSummary, skipped: ["2026-07-02_linkedin_broken.md"] });
  assert.match(out, /\+6/);
  assert.match(out, /skipped/i);
  assert.match(out, /broken/);
});

test("formatReportCard truncates a huge recent list rather than exceeding the limit", () => {
  const summary = summarize([{ overall: 24, scores: full }]);
  const recent = Array.from({ length: 60 }, (_, i) => ({
    post_title: `A fairly long post title number ${i} about market structure`,
    grade: "B",
    overall: 24,
    notes: "a reasonably long note about what cost points on this particular post",
  }));
  const out = formatReportCard({ summary, recent, prevSummary: null, skipped: [] });
  assert.ok(out.length <= 1900, `report card too long: ${out.length}`);
});
