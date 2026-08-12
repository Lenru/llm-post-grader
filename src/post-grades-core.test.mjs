import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DIMENSIONS,
  RUBRIC_VERSION,
  RAW_TOTAL,
  SCORE_MAX,
  PUBLISH_BAR,
  bandFor,
  meetsBar,
  normalizeScores,
  overallOf,
  rawTotalOf,
  pendingRefs,
  summarize,
  formatReportCard,
  chunk,
  resolveClientsRoot,
} from "./post-grades-core.mjs";
import { parsePostFile, postRefFor, insertBatchWithRetry } from "./grade-sweep.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test("PUBLISH_BAR is 88, so a silent change breaks this test", () => {
  assert.equal(PUBLISH_BAR, 88);
});

test("meetsBar applies the 88 bar as a strict >= cutoff", () => {
  assert.equal(meetsBar(88), true);
  assert.equal(meetsBar(87), false);
  assert.equal(meetsBar(90), true);
  assert.equal(meetsBar(100), true);
  assert.equal(meetsBar(0), false);
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

test("formatReportCard states how many of this run's graded posts clear the 88 bar", () => {
  const summary = summarize([{ overall: 96, scores: full }, { overall: 60, scores: { hook: 4, voice: 2, clarity: 4, icp: 3, structure: 3, closer: 2 } }]);
  const recent = [
    { post_title: "Clears the bar", grade: "A", overall: 96, notes: "clean" },
    { post_title: "Misses the bar", grade: "D", overall: 60, notes: "weak closer" },
  ];
  const out = formatReportCard({ summary, recent, prevSummary: null, skipped: [] });
  assert.match(out, /1 of 2 clear the 88 bar/);
});

test("formatReportCard handles an empty week without crashing", () => {
  const out = formatReportCard({ summary: null, recent: [], prevSummary: null, skipped: [] });
  assert.match(out, /nothing new/i);
  assert.ok(out.length <= 1900);
});

test("a quiet week (nothing graded) never presents the prior corpus as this week's work", () => {
  // Mirrors grade-sweep.mjs's call site directly: summarize(graded), never
  // summarize(priorRows). A week where everything on disk is already graded
  // must produce the honest null summary, not the whole standing corpus
  // dressed up as "N posts graded" for a week that graded zero.
  const priorRows = [
    { overall: 80, scores: full },
    { overall: 60, scores: { hook: 4, voice: 2, clarity: 4, icp: 3, structure: 3, closer: 2 } },
  ];
  const graded = [];
  const summary = summarize(graded);
  assert.equal(summary, null, "summarize([]) must be null, the fix's whole point");
  const out = formatReportCard({ summary, recent: [], prevSummary: null, skipped: [] });
  assert.match(out, /nothing new/i);
  // The old bug rendered "2 posts graded" (priorRows.length) as this week's
  // count. Guard against that literal regression.
  assert.ok(!out.includes(`${priorRows.length} post`), "must not phrase the prior corpus count as work done this week");
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
  // The length check alone is guaranteed by the trailing .slice(0, DISCORD_BUDGET)
  // regardless of whether the per-post budget loop ever ran, so it does not
  // prove the loop actually truncated anything. Assert the loop's own output:
  // the "and N more" marker, and strictly fewer post lines than were passed in.
  assert.match(out, /and \d+ more/, "truncation marker must be present for 60 recent posts");
  const postLineCount = recent.filter((r) => out.includes(r.post_title)).length;
  assert.ok(postLineCount < recent.length, `expected fewer than ${recent.length} post lines to survive, got ${postLineCount}`);
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
  assert.equal(postRefFor(win), "distribution/2026-07-02_linkedin_fednow-deposit-rails.md");
  const nix = "/c/Users/me/Desktop/clients/noah-finance/distribution/published/2026-07-10_linkedin_x.md";
  assert.equal(postRefFor(nix), "distribution/2026-07-10_linkedin_x.md");
});

test("postRefFor collapses scheduled/ and published/ to the SAME ref for the same basename", () => {
  // This equality is the whole point of the F7 fix: mark-published moves the
  // file from distribution/scheduled/ to distribution/published/, and if the
  // folder survived in the ref, the sweep would see the moved file as a new,
  // ungraded post and grade (and insert) it a second time.
  const scheduled = String.raw`C:\Users\me\Desktop\clients\noah-finance\distribution\scheduled\2026-07-15_linkedin_same-post.md`;
  const published = "/c/Users/me/Desktop/clients/noah-finance/distribution/published/2026-07-15_linkedin_same-post.md";
  assert.equal(postRefFor(scheduled), "distribution/2026-07-15_linkedin_same-post.md");
  assert.equal(postRefFor(published), "distribution/2026-07-15_linkedin_same-post.md");
  assert.equal(postRefFor(scheduled), postRefFor(published));
});

test("postRefFor leaves script-lab draft refs untouched", () => {
  const draft = String.raw`C:\Users\me\Desktop\clients\noah-finance\script-lab\linkedin_fednow-deposit-rails_draft.md`;
  assert.equal(postRefFor(draft), "script-lab/linkedin_fednow-deposit-rails_draft.md");
});

test("chunk splits an exact multiple into equal groups", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6], 2), [[1, 2], [3, 4], [5, 6]]);
});

test("chunk puts the remainder in a shorter final group", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("chunk returns an empty array for empty input", () => {
  assert.deepEqual(chunk([], 10), []);
});

test("chunk returns a single group when size exceeds the array length", () => {
  assert.deepEqual(chunk([1, 2, 3], 10), [[1, 2, 3]]);
});

// insertBatchWithRetry guards the 2026-07-30 incident: 43 posts graded
// successfully, then a single bulk INSERT died to a transient
// `TypeError: fetch failed`, and every graded row was lost even though the
// grading itself had already succeeded. A minimal fake `sb` stands in for
// @supabase/supabase-js: `.from(table).insert(batch)` either throws
// (network-shaped failure, the incident's exact case) or resolves with
// `{ error }` (Postgres actually answered, e.g. a unique-index conflict).
// No mocking framework, just a closure over a queue of behaviors.
function fakeSb(behaviors) {
  const calls = [];
  let i = 0;
  return {
    calls,
    from(table) {
      assert.equal(table, "post_grades");
      return {
        async insert(batch) {
          calls.push(batch);
          const behavior = behaviors[i++];
          if (!behavior) throw new Error("fakeSb ran out of scripted behaviors");
          return behavior();
        },
      };
    },
  };
}

test("insertBatchWithRetry: a thrown error is retried and can still succeed", async () => {
  const sb = fakeSb([
    () => { throw new TypeError("fetch failed"); },
    () => { throw new TypeError("fetch failed"); },
    () => ({ error: null }),
  ]);
  const result = await insertBatchWithRetry(sb, [{ id: 1 }]);
  assert.deepEqual(result, { ok: true });
  assert.equal(sb.calls.length, 3, "must attempt exactly 3 times: try, retry, retry-succeeds");
});

test("insertBatchWithRetry: a resolved {error} (constraint violation) is NEVER retried", async () => {
  // The distinguishing behavior of the fix: a batch that resolves with an
  // `error` field is Postgres actually answering, a real, deterministic
  // outcome, not a reachability problem. Retrying it just fails the same way
  // three times slower, so it must stop after exactly one call.
  const constraintErr = { message: "duplicate key value violates unique constraint post_grades_published_once_idx" };
  const sb = fakeSb([() => ({ error: constraintErr })]);
  const result = await insertBatchWithRetry(sb, [{ id: 1 }]);
  assert.equal(result.ok, false);
  assert.equal(result.error, constraintErr);
  assert.equal(sb.calls.length, 1, "a resolved {error} must not be retried");
});

test("insertBatchWithRetry: three thrown errors exhaust retries and surface the last one", async () => {
  const err1 = new TypeError("fetch failed 1");
  const err2 = new TypeError("fetch failed 2");
  const err3 = new TypeError("fetch failed 3");
  const sb = fakeSb([
    () => { throw err1; },
    () => { throw err2; },
    () => { throw err3; },
  ]);
  const result = await insertBatchWithRetry(sb, [{ id: 1 }]);
  assert.equal(result.ok, false);
  assert.equal(result.error, err3, "must carry the LAST error, not the first");
  assert.equal(sb.calls.length, 3, "must attempt exactly 3 times total, then give up");
});

// resolveClientsRoot guards the 2026-08-12 break: the content tree moved
// from Desktop/clients to "Desktop/Main Folder CLAUDE/clients" and
// grade-sweep.mjs had that old path hardcoded, so the weekly grading sweep
// failed instead of grading for over a week. `exists` is injected rather
// than calling fs.existsSync directly, so this is a plain function of an
// array in and a Set-backed existence check, no real filesystem involved.
function fakeExists(existingPaths) {
  const set = new Set(existingPaths);
  return (p) => set.has(p);
}

test("resolveClientsRoot returns the first candidate that exists", () => {
  const exists = fakeExists(["/a", "/b", "/c"]);
  assert.equal(resolveClientsRoot(["/a", "/b", "/c"], exists), "/a");
});

test("resolveClientsRoot skips missing candidates and picks the first that exists", () => {
  const exists = fakeExists(["/main-folder-claude/clients"]);
  assert.equal(
    resolveClientsRoot(["/old/clients", "/main-folder-claude/clients"], exists),
    "/main-folder-claude/clients",
  );
});

test("resolveClientsRoot returns null when none of the candidates exist", () => {
  const exists = fakeExists([]);
  assert.equal(resolveClientsRoot(["/old/clients", "/main-folder-claude/clients"], exists), null);
});

test("resolveClientsRoot respects candidate order: an earlier existing path wins over a later one", () => {
  const exists = fakeExists(["/first", "/second"]);
  assert.equal(resolveClientsRoot(["/first", "/second"], exists), "/first");
  assert.equal(resolveClientsRoot(["/second", "/first"], exists), "/second");
});

// M4: an unparseable --limit must never silently mean unlimited, which would
// turn a typo into an expensive surprise (grading the whole corpus when
// someone meant to cap the run). LIMIT is computed at module load time, so
// this is exercised via a real subprocess rather than an import.
test("grade-sweep.mjs exits 1 with a clear message on an unparseable --limit", () => {
  const script = join(__dirname, "grade-sweep.mjs");
  const res = spawnSync(process.execPath, [script, "--limit", "abc", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--limit/);
});
