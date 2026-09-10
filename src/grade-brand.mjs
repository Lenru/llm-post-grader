// Grade any brand's posts against that brand's own rubric.
//
// Deliberately NOT an extension of grade-sweep.mjs. That script is built around
// noah-finance's shape — six fixed dimensions scored 0-5, rescaled from 0-30 —
// and it is unit-tested, gates PUBLISH_BAR, and runs on the NoahOS-PostGrades
// schedule. Community and Clinic use seven weighted dimensions out of 20. Bending the
// tested path to fit a second shape risks the thing that decides what ships.
//
// Here the RUBRIC is authoritative: it declares its own dimensions and scale,
// the model reads it, and this validates the envelope rather than the shape.
//
//   node brain/grade-brand.mjs --brand=community --queued
//   node brain/grade-brand.mjs --brand=clinic --queued --limit 3
//   node brain/grade-brand.mjs --brand=community --queued --dry-run
//
// --queued selects posts the client can see that are scheduled or published and
// have no grade yet: the ones actually going out, which is what a grade gates.
// Writes to ops.post_grades, keyed on the same post_ref the hub uses, so a
// graded post shows its score in the hub on the next `hub-sync`.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClientsRoot } from "./post-grades-core.mjs";
import { loadApprovedExamples, FILENAME } from "../scripts/approved-corpus.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
try { process.loadEnvFile(join(ROOT, ".env.local")); } catch { /* exported */ }

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};

/**
 * Video posts, which this rubric cannot score. `format` is freeform frontmatter
 * that has drifted across brands, so the filename is checked too: every one of
 * Clinic's video posts is named `clip-*` and every `clip-*` file carries
 * `format: video`, verified 2026-08-21.
 */
const isVideo = (p) =>
  String(p.format ?? "").toLowerCase().includes("video") || /clip-/.test(p.post_ref ?? "");

const BRAND = arg("brand");
const QUEUED = process.argv.includes("--queued");
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(arg("limit")) || Infinity;
/** Grade ONE post by a substring of its post_ref. For the "can this go out
 *  today" question, where grading the other thirty is a ten minute wait and
 *  thirty model calls nobody asked for. */
const ONLY_REF = arg("ref");
// Re-grade posts that ALREADY have a score and print the delta, writing nothing.
// The first version of this script was confidently wrong; calibrating against
// grades produced with full context is how that gets caught next time.
const COMPARE = process.argv.includes("--compare");
// Re-grade posts that already have a score and WRITE the result. ops.post_grades
// keeps history (only published rows are unique per brand/version/ref), so this
// supersedes rather than destroys: the old row stays, the newest one wins on
// read. Needed because Clinic's v2 grades were 14 posts sharing two values.
const REGRADE = process.argv.includes("--regrade");
// How many times each post is scored before the median is taken. One is the
// old behaviour and is fine for a quick look; three is what a publish gate
// needs. See gradeOne().
const SAMPLES = Math.max(1, Number(arg("samples")) || 3);
// Grade only posts whose frontmatter carries `approval: Approved`. These are
// the client's own signed-off work, so they are the calibration set: a grader
// that scores them badly is wrong about the grader, not about the posts.
const APPROVED_ONLY = process.argv.includes("--approved");
// How many client-approved posts go into the prompt as worked examples of the
// standard, and the switch to turn that off when measuring its effect.
const EXEMPLAR_COUNT = Math.max(0, Number(arg("exemplars") ?? 3));
const NO_EXEMPLARS = process.argv.includes("--no-exemplars") || EXEMPLAR_COUNT === 0;

if (!BRAND) {
  console.error("Usage: node brain/grade-brand.mjs --brand=<slug> --queued [--limit N] [--dry-run]");
  process.exit(1);
}

const HOME = process.env.USERPROFILE ?? process.env.HOME;
const CLIENTS_ROOT = resolveClientsRoot(
  process.env.CLIENTS_ROOT
    ? [process.env.CLIENTS_ROOT]
    : [join(HOME, "Desktop", "Main Folder CLAUDE", "clients"), join(HOME, "Desktop", "clients")],
  existsSync,
);

const bandFor = (n) => (n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : n >= 60 ? "D" : "F");

// Files the grader needs to judge dimensions that are NOT visible in the post.
//
// This is the whole lesson of the first run: it graded on the rubric and the
// post body alone, and `sourcing` (20 pts, "does this trace to something the client
// actually said or to Clinic data") and `voice` (20 pts) collapsed to 3.8 and
// 5.0 against 19.1 and 16.5 from the skill that had this context. Two fifths of
// the score were being marked absent because the grader had no way to look.
const CONTEXT_FILES = [
  "voice.md",
  "voice-company.md",
  "content-corpus-digest.md", // the claims bank — what `sourcing` is checked against
  "pillars.md",
  "content-playbook.md",
  "sentence-craft-checklist.md",
];

// Keeps one call bounded if a brand's library grows. Currently ~30k per brand.
const CONTEXT_BUDGET = 90_000;

function loadContext() {
  const parts = [];
  let used = 0;
  for (const name of CONTEXT_FILES) {
    const fp = join(CLIENTS_ROOT, BRAND, "brand", name);
    if (!existsSync(fp)) continue;
    const text = readFileSync(fp, "utf8");
    if (used + text.length > CONTEXT_BUDGET) {
      console.warn(`  (skipped ${name}: context budget reached)`);
      continue;
    }
    used += text.length;
    parts.push(`--- ${name} ---\n${text}`);
  }
  if (!parts.length) {
    console.error(
      `No voice or corpus files for ${BRAND}. Grading without them scores\n` +
        `sourcing and voice blind, which is how the first run produced\n` +
        `uniform Fs. Refusing rather than producing numbers that look real.`,
    );
    process.exit(1);
  }
  console.log(`  context: ${parts.length} file(s), ${Math.round(used / 1000)}k chars`);
  return parts.join("\n\n");
}

/**
 * A brand can run more than one surface, and the surfaces are graded to
 * different standards. Community is the case: `post-rubric.md` scores the Club
 * accounts over seven weighted dimensions INCLUDING Visual worth 20, and
 * `post-rubric-founder.md` scores his personal profile over six with no Visual
 * dimension at all, because that surface is text only by spec.
 *
 * Loading the Club rubric for a post on the founder's profile is not a mild
 * mismatch, it is arithmetic: the post forfeits Visual's 20 points before a
 * word is read, so 80 is its ceiling and the bar is 88. Nothing he writes can
 * pass. That is the same shape as the bar that froze Clinic's queue at zero of
 * fifty, and it would have looked like the writing failing.
 *
 * Surface is not on the hub row and is not in the post_ref path, so the split
 * is the filename convention every draft already follows, which is the same
 * belt-and-braces the Threads skip below relies on: club drafts are `club_*`,
 * his are not.
 */
const RUBRIC_CACHE = new Map();
function loadRubric(ref = "") {
  const isClub = /(?:^|\/)club_/.test(ref);
  const founder = join(CLIENTS_ROOT, BRAND, "brand", "post-rubric-founder.md");
  const fp = !isClub && existsSync(founder)
    ? founder
    : join(CLIENTS_ROOT, BRAND, "brand", "post-rubric.md");

  if (RUBRIC_CACHE.has(fp)) return RUBRIC_CACHE.get(fp);
  if (!existsSync(fp)) {
    console.error(`No rubric at ${fp}. Grading without one would invent a standard.`);
    process.exit(1);
  }
  const raw = readFileSync(fp, "utf8");
  const version = raw.match(/^rubric_version:\s*(\S+)/m)?.[1] ?? null;
  const loaded = { text: raw, version, path: fp };
  RUBRIC_CACHE.set(fp, loaded);
  return loaded;
}

/**
 * One post, one model call. Returns a validated record or null.
 *
 * The envelope is checked, not the dimension list: each brand's rubric names
 * its own dimensions and its own scale, so asserting a fixed set here would
 * just reimpose noah-finance's shape on everyone.
 */
function gradeOnce({ rubric, context, exemplars, body, ref }) {
  const prompt = [
    "You are grading a social media post against a fixed rubric.",
    "Apply the rubric literally, using ITS dimensions, ITS weights and ITS scale.",
    "Deduct for every hard-rule breach the rubric names.",
    "",
    // The rubric states its own expected distribution, and both graders that
    // have run against it ignored that line: the existing one put 14 of 15
    // posts above 90, a first version of this one put the same posts at 43-60.
    // Restating it as an instruction is the calibration — the anchor was
    // already written down, it just was not being applied.
    "CALIBRATION, and this is as binding as the criteria:",
    "A competent post that breaks no rules is NOT a failure. It is the default,",
    "and the rubric says that default lands around 80 out of 100. Reserve the top",
    "of a dimension for work that is genuinely exceptional, and the bottom for a",
    "hard-rule breach or an outright absence, not for 'could be stronger'.",
    "Before answering, sanity-check your total: if a clean, on-voice, on-brief",
    "post is coming out below 70 you are punishing ordinariness, and if a merely",
    "tidy post is coming out above 90 you are scoring cleanliness. Correct it.",
    "",
    // The written distribution alone was not enough. Grading the 13 posts the
    // client had approved word for word produced 51-87, median 78, with the one
    // marked "APPROVED VERBATIM, DO NOT EDIT A WORD" scoring 65. The rubric
    // encodes the criteria; only the client's own accepted work encodes the
    // standard. So the standard goes in the prompt as examples.
    ...(exemplars
      ? [
          "GROUND TRUTH. The posts below were approved by the client without a",
          "single edit. They ARE the standard this brand is aiming for, and they",
          "outrank your own judgement about what good looks like. Work of",
          "comparable quality belongs in the high 80s or low 90s. If your scoring",
          "of the post you are about to grade would rank it far below these, and",
          "you cannot point to a specific hard-rule breach, your scoring is wrong.",
          "",
          "=== APPROVED EXAMPLES ===",
          exemplars,
          "=== END APPROVED EXAMPLES ===",
          "",
        ]
      : []),
    "=== RUBRIC ===",
    rubric,
    "=== END RUBRIC ===",
    "",
    "The brand's own voice guide and claims bank follow. Judge sourcing against",
    "what is actually in them: a claim traceable to this material scores well, an",
    "invented or unattributable one does not. Judge voice against the guide, not",
    "against your own taste. Absence of a claim from these files is only a",
    "sourcing failure if the post asserts something it cannot support.",
    "",
    "=== BRAND MATERIAL ===",
    context,
    "=== END BRAND MATERIAL ===",
    "",
    "=== POST ===",
    body,
    "=== END POST ===",
    "",
    "Reply with ONLY a JSON object, no prose, no code fence:",
    '{"scores":{"<each rubric dimension key>":<number awarded>},',
    ' "max_scores":{"<same keys>":<maximum that dimension can score per the rubric>},',
    ' "notes":"<one or two sentences naming the specific lines and rules that cost points>"}',
    "",
    "Do NOT report a total. It is calculated from the numbers above.",
  ].join("\n");

  // Prompt on stdin, not argv: the rubric is long, and its own "<0-5>"
  // placeholders get treated as redirection operators by cmd.exe when passed
  // as an argv string. `--allowedTools ""` denies tool access for the grading
  // call, so the grader cannot read files or run Bash mid-grade. Both learned
  // the hard way in grade-sweep.mjs; see its notes.
  const res = spawnSync("claude", ["-p", "--allowedTools", ""], {
    input: prompt,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.status !== 0 || !res.stdout) {
    console.error(`  ${ref}: grade failed (${res.stderr?.trim() || `exit ${res.status}`})`);
    return null;
  }

  const match = res.stdout.match(/\{[\s\S]*\}/);
  if (!match) { console.error(`  ${ref}: no JSON in output`); return null; }

  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { console.error(`  ${ref}: unparseable JSON`); return null; }

  const numeric = (o) =>
    o && typeof o === "object" && !Array.isArray(o) &&
    Object.keys(o).length > 0 &&
    Object.values(o).every((v) => Number.isFinite(Number(v)));

  if (!numeric(parsed.scores)) { console.error(`  ${ref}: scores unusable`); return null; }
  if (!numeric(parsed.max_scores)) { console.error(`  ${ref}: max_scores missing`); return null; }

  const scores = Object.fromEntries(Object.entries(parsed.scores).map(([k, v]) => [k, Number(v)]));
  const maxes = Object.fromEntries(Object.entries(parsed.max_scores).map(([k, v]) => [k, Number(v)]));

  // Every scored dimension needs a maximum, or the total is computed against a
  // denominator that silently omits it.
  const missing = Object.keys(scores).filter((k) => !(k in maxes));
  if (missing.length) { console.error(`  ${ref}: no maximum for ${missing.join(", ")}`); return null; }

  const got = Object.values(scores).reduce((a, n) => a + n, 0);
  const possible = Object.keys(scores).reduce((a, k) => a + maxes[k], 0);
  if (possible <= 0) { console.error(`  ${ref}: rubric maximum is zero`); return null; }

  // Computed here, never taken from the model. The first run of this script
  // returned scores summing to 42 alongside an "overall" of 32 — the numbers
  // were right and the addition was wrong. A grade that gates publishing
  // cannot rest on arithmetic nobody checked.
  const overall = Math.max(0, Math.min(100, Math.round((got / possible) * 100)));

  return {
    scores,
    overall,
    // Recomputed rather than trusted: the band must follow from the number, or
    // the report card and the publish gate can disagree about the same post.
    grade: bandFor(overall),
    notes: String(parsed.notes ?? "").slice(0, 1000),
  };
}

/**
 * Grade a post SAMPLES times and take the median.
 *
 * A single run drifts about eight points on the same post: re-grading four
 * Clinic drafts moved them 73→71, 65→69, 70→72 and 63→71. That is tolerable for
 * a label and not tolerable for a gate, because a post either side of the bar
 * then ships or doesn't depending on which run it got. The median of three
 * throws away the outlier run rather than averaging it in.
 */
function gradeOne(args) {
  const runs = [];
  for (let n = 0; n < SAMPLES; n += 1) {
    // One retry. A malformed reply is not a verdict on the post, and losing a
    // sample costs more than the extra call: it drops the median onto an even
    // pair. 2 of 30 calls came back unparseable in the run that exposed this.
    const g = gradeOnce(args) ?? gradeOnce(args);
    if (g) runs.push(g);
  }
  if (!runs.length) return null;
  // A single usable run is still a grade; it just carries the variance.
  if (runs.length === 1) return { ...runs[0], samples: 1, spread: 0 };

  const sorted = [...runs].sort((a, b) => a.overall - b.overall);
  // With an EVEN number of usable runs, sorted[len/2] is the upper of the two
  // middles, not the middle. That is not a rounding nit: when one of three
  // samples fails to parse, the survivor pair silently returns its maximum, and
  // two posts jumped 23 and 25 points between runs partly because of it. Take
  // the lower middle instead, so a lost sample cannot flatter a post.
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];
  return {
    ...mid,
    samples: runs.length,
    spread: sorted[sorted.length - 1].overall - sorted[0].overall,
  };
}

async function main() {
  const context = loadContext();

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  let q = sb.schema("hub").from("posts")
    .select("post_ref,title,body,stage,client_status,grade_overall,grade_scores,format,platform")
    .eq("brand", BRAND)
    .eq("visibility_effective", "client");
  // Ground truth comes from the same generated file the drafting skills read,
  // so the standard a post is WRITTEN against and the standard it is GRADED
  // against cannot drift apart. Regenerate with scripts/approved-corpus.mjs.
  let exemplars = null;
  let exemplarRefs = new Set();
  if (!NO_EXEMPLARS) {
    const corpus = loadApprovedExamples(CLIENTS_ROOT, BRAND);
    if (!corpus) {
      console.log(
        `  ground truth: none. Run \`node scripts/approved-corpus.mjs --brand=${BRAND}\`` +
          " once the client has approved something.",
      );
    } else {
      // Sections are `## N. title`, each followed by a `post_ref` in backticks.
      const sections = corpus.split(/\n## \d+\. /).slice(1);
      const picked = sections.slice(0, EXEMPLAR_COUNT);
      exemplarRefs = new Set(picked.map((sec) => sec.match(/`([^`]+)`/)?.[1]).filter(Boolean));
      exemplars = picked
        .map((sec, i) => `--- Approved example ${i + 1} ---\n${sec.trim().slice(0, 2500)}`)
        .join("\n\n");
      console.log(`  ground truth: ${picked.length} approved post(s) from ${FILENAME}`);
    }
  }

  // --approved is the calibration set and is not about whether a grade exists:
  // client_status='approved' is the client's own sign-off, mirrored from the
  // `approval: Approved` frontmatter these posts carry on disk.
  if (APPROVED_ONLY) q = q.eq("client_status", "approved");
  else if (COMPARE || REGRADE) q = q.not("grade_overall", "is", null);
  else q = q.is("grade_overall", null);
  if (QUEUED && !COMPARE && !APPROVED_ONLY) q = q.in("stage", ["scheduled", "published"]);

  const { data, error } = await q.order("post_ref");
  if (error) { console.error(error.message); process.exit(1); }

  // A post is never graded against itself: an exemplar in the prompt would
  // score itself perfectly and tell us nothing.
  //
  // Video is skipped outright, and this is not a temporary hack. The rubric has
  // no video anchor: it says so itself ("There is no Visual dimension... Visual
  // defects show up under Structure instead"), and Structure's own anchor is a
  // nine-beat, ~280-word LinkedIn essay. Grading a 40-second clip against that
  // measures the caption and never the post. Run over Clinic's queue on
  // 2026-08-21 it scored text at 77 average, 84% clearing the bar, and video at
  // 68, 47% clearing, with the biggest single loss on VOICE, of all dimensions,
  // for posts that are the client speaking his own words. Sourcing lost too, on clips
  // whose frontmatter cites a timestamped interview the grader cannot open.
  //
  // A wrong number is worse than no number here, because PUBLISH_BAR turns it
  // into a gate. Video's gate is its compliance file plus the client's sign-off,
  // both of which every clip already carries. To grade video properly, feed the
  // grader the transcript segment that `source:` already points at, then delete
  // this filter. Until then it stays off.
  // Threads is skipped for exactly the same reason, added 2026-08-25 on Noah's
  // call once the first full sweep made it visible. Grading 66 Clinic posts gave
  // Instagram 77.8, LinkedIn 77.2 and Facebook 76.5, with no F anywhere, and
  // Threads 60.3 with 20 of 27 under the bar and ELEVEN F grades. Every F in the
  // corpus was a Threads post.
  //
  // That is the same failure as video, not a different one. Structure's anchor
  // is a nine-beat ~280-word LinkedIn essay, and a Threads post is a few lines
  // by design. The rubric measures its length and reports it as quality. Take
  // Threads out and the remaining 39 posts average 77.4 with four under the bar
  // and no F, which is a corpus the numbers actually describe.
  // Two sources, the same belt-and-braces isVideo uses: the column, and the
  // filename convention every threads draft follows. `platform` had to be added
  // to the select above for the first half to be anything but undefined, which
  // is how a skip like this silently never fires.
  const isThreads = (p) =>
    String(p.platform ?? "").toLowerCase() === "threads" ||
    /(^|\/)threads_/.test(p.post_ref ?? "");

  const skipped = [];
  const skippedThreads = [];
  const targets = (data ?? [])
    .filter((p) => {
      if (isVideo(p)) { skipped.push(p.post_ref); return false; }
      if (isThreads(p)) { skippedThreads.push(p.post_ref); return false; }
      if (ONLY_REF && !(p.post_ref ?? "").includes(ONLY_REF)) return false;
      return (p.body ?? "").trim().length > 40 && !exemplarRefs.has(p.post_ref);
    })
    .slice(0, LIMIT);
  if (skipped.length) {
    console.log(`  skipped ${skipped.length} video post(s): this rubric has no video anchor`);
  }
  if (skippedThreads.length) {
    console.log(`  skipped ${skippedThreads.length} threads post(s): this rubric is LinkedIn-shaped`);
  }
  console.log(`${BRAND}: ${targets.length} post(s) to grade`);
  if (DRY_RUN) {
    for (const p of targets) console.log(`  would grade ${p.post_ref}`);
    return;
  }

  // The calibration read: what does the grader say about work the client
  // already signed off? A low spread here means the grader agrees with the
  // client's standard, and the publish bar can sit just under the floor. A
  // scatter means the grader is the thing that needs fixing.
  if (APPROVED_ONLY && !REGRADE) {
    const scored = [];
    for (const p of targets) {
      const { text: rubric, version } = loadRubric(p.post_ref);
      const g = gradeOne({ rubric, context, exemplars, body: p.body, ref: p.post_ref });
      if (!g) continue;
      scored.push({ ref: p.post_ref, ...g });
      const drift = g.spread ? `  ±${g.spread}` : "";
      console.log(`  ${String(g.overall).padStart(3)} ${g.grade}${drift.padEnd(6)}  ${p.post_ref}`);
    }
    if (!scored.length) return;
    const totals = scored.map((s) => s.overall).sort((a, b) => a - b);
    const floor = totals[0];
    const median = totals[Math.floor(totals.length / 2)];
    const worstDrift = Math.max(...scored.map((s) => s.spread ?? 0));
    console.log(
      `
${scored.length} post(s) the client approved: floor ${floor}, median ${median}, ` +
        `top ${totals[totals.length - 1]}. Worst run-to-run drift ${worstDrift}.`,
    );
    // No fixed pass mark here. A floor of 69 is not "bad", it is simply where
    // this client's accepted work sits on this rubric, and the earlier version
    // of this line printed "NOT calibrated" over a perfectly usable
    // distribution because it compared against an invented threshold of 80.
    // What matters is the drift and the gap to unapproved work, and only the
    // first of those is measurable from this set alone.
    console.log(
      worstDrift > 10
        ? `Too noisy to gate on: one post moved ${worstDrift} points between runs. ` +
          "Raise --samples or fix the prompt before deriving a bar."
        : `A bar at ${floor} passes everything the client approved. Compare against ` +
          "unapproved drafts (--compare) before setting it: a bar only means " +
          "something if the two sets actually separate.",
    );
    return;
  }

  if (COMPARE) {
    const deltas = [];
    for (const p of targets) {
      const { text: rubric, version } = loadRubric(p.post_ref);
      const g = gradeOne({ rubric, context, exemplars, body: p.body, ref: p.post_ref });
      if (!g) continue;
      const d = g.overall - p.grade_overall;
      deltas.push(d);
      console.log(`  was ${String(p.grade_overall).padStart(3)} -> now ${String(g.overall).padStart(3)}  (${d >= 0 ? "+" : ""}${d})  ${p.post_ref}`);
    }
    if (deltas.length) {
      const mean = deltas.reduce((a, n) => a + n, 0) / deltas.length;
      const worst = deltas.reduce((a, n) => Math.max(a, Math.abs(n)), 0);
      console.log(`
mean drift ${mean.toFixed(1)} points, largest single gap ${worst}`);
      console.log(worst <= 15 ? "Calibrated closely enough to trust." : "NOT calibrated — do not write these.");
    }
    return;
  }

  let done = 0, failed = 0;
  for (const p of targets) {
    const { text: rubric, version } = loadRubric(p.post_ref);
    const g = gradeOne({ rubric, context, exemplars, body: p.body, ref: p.post_ref });
    if (!g) { failed += 1; continue; }

    // stage 'draft' in the hub maps to ops.post_grades' 'draft'; anything live
    // is 'published'. The partial unique index only covers published rows.
    const stage = p.stage === "published" ? "published" : "draft";
    const { error: insErr } = await sb.schema("ops").from("post_grades").insert({
      brand: BRAND,
      stage,
      post_ref: p.post_ref,
      post_title: p.title,
      scores: g.scores,
      overall: g.overall,
      grade: g.grade,
      notes: g.notes,
      rubric_version: version,
    });
    if (insErr) { console.error(`  ${p.post_ref}: insert failed — ${insErr.message}`); failed += 1; continue; }

    done += 1;
    console.log(`  ${g.overall} ${g.grade}  ${p.post_ref}`);
  }

  console.log(`${BRAND}: graded ${done}, failed ${failed}`);
  if (done) console.log("Run `node scripts/hub-sync.mjs` to surface these in the hub.");
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
