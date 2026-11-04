// Grade any brand's posts against that brand's own rubric.
//
// The RUBRIC is authoritative: it declares its own dimensions and scale, the
// model reads it, and this validates the envelope rather than the shape.
//
//   node src/grade-brand.mjs --brand=example/northside-physio
//   node src/grade-brand.mjs --brand=example/northside-physio --approved
//   node src/grade-brand.mjs --brand=example/northside-physio --ref=hip --samples=1
//
// A brand is a folder:
//   post-rubric.md   the rubric (required)
//   voice.md etc.    brand material the grader judges voice and sourcing against
//   approved/*.md    posts the client approved without a single edit: the standard
//   posts/*.md       posts to grade
//
// Model: with ANTHROPIC_API_KEY set it calls the Messages API. Without it, it
// runs the `claude` CLI headless, which is how this ran in production.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pickMedia, parseGrade, medianRun, parsePost, barFor } from "./post-grades-core.mjs";

// Headless: skip the user's CLAUDE.md files (rules for live chats, ~44k tokens a call). Auth, MCP, tools unaffected.
process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
try { process.loadEnvFile(join(ROOT, ".env")); } catch { /* exported, or not needed */ }

const MODEL = process.env.GRADER_MODEL ?? "claude-sonnet-5-5";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=")[1];
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};

/**
 * Video posts, which this rubric cannot score. `format` is freeform frontmatter
 * that drifts, so the filename is checked too.
 */
const isVideo = (p) =>
  String(p.format ?? "").toLowerCase().includes("video") || /clip-/.test(p.post_ref ?? "");

const BRAND_DIR = arg("brand") ? resolve(arg("brand")) : null;
const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT = Number(arg("limit")) || Infinity;
/** Grade ONE post by a substring of its filename. */
const ONLY_REF = arg("ref");
// How many times each post is scored before the median is taken. One is fine
// for a quick look; three is what a publish gate needs. See gradeOne().
const SAMPLES = Math.max(1, Number(arg("samples")) || 3);
// Grade the client's own approved posts. They are the calibration set: a
// grader that scores them badly is wrong about the grader, not about the posts.
const APPROVED_ONLY = process.argv.includes("--approved");
// How many approved posts go into the prompt as worked examples of the
// standard, and the switch to turn that off when measuring its effect.
const EXEMPLAR_COUNT = Math.max(0, Number(arg("exemplars") ?? 3));
const NO_EXEMPLARS = process.argv.includes("--no-exemplars") || EXEMPLAR_COUNT === 0;

if (!BRAND_DIR || !existsSync(BRAND_DIR)) {
  console.error("Usage: node src/grade-brand.mjs --brand=<folder> [--approved] [--ref <name>] [--samples N] [--limit N] [--bar N] [--dry-run]");
  process.exit(1);
}
const BRAND = basename(BRAND_DIR);
const BAR = Number(arg("bar")) || barFor(BRAND);

// Files the grader needs to judge dimensions that are NOT visible in the post.
//
// This is the whole lesson of the first run: it graded on the rubric and the
// post body alone, and `sourcing` (20 pts, "does this trace to something the
// client actually said") and `voice` (20 pts) collapsed to 3.8 and 5.0 against
// 19.1 and 16.5 from a grader that had this context. Two fifths of the score
// were being marked absent because the grader had no way to look.
const CONTEXT_FILES = [
  "voice.md",
  "voice-company.md",
  "content-corpus-digest.md", // the claims bank: what `sourcing` is checked against
  "pillars.md",
  "content-playbook.md",
  "sentence-craft-checklist.md",
];

// Keeps one call bounded if a brand's library grows.
const CONTEXT_BUDGET = 90_000;

function loadContext() {
  const parts = [];
  let used = 0;
  for (const name of CONTEXT_FILES) {
    const fp = join(BRAND_DIR, name);
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

function loadRubric() {
  const fp = join(BRAND_DIR, "post-rubric.md");
  if (!existsSync(fp)) {
    console.error(`No rubric at ${fp}. Grading without one would invent a standard.`);
    process.exit(1);
  }
  return readFileSync(fp, "utf8");
}

const readPosts = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
        .map((f) => parsePost(readFileSync(join(dir, f), "utf8"), f))
    : [];

/**
 * A post's media as base64 image blocks for the grader, loaded once per post
 * (not per sample). Images are fetched; each .mp4 gives its final frame via
 * ffmpeg reading the URL directly. `expected` is how many there should be, so
 * a failed load shows up as a partial grade instead of a blind guess.
 */
async function loadMedia(urls) {
  const dir = mkdtempSync(join(tmpdir(), "grade-media-"));
  const picked = pickMedia(urls, dir);
  const images = [];
  try {
    for (const m of picked) {
      try {
        let buf;
        if (m.kind === "video") {
          const ff = spawnSync("ffmpeg", ["-v", "error", "-y", "-sseof", "-0.2", "-i", m.url, "-frames:v", "1", m.still], { timeout: 60000 });
          if (ff.status !== 0 || !existsSync(m.still)) throw new Error(String(ff.stderr || ff.error || "ffmpeg failed").trim());
          buf = readFileSync(m.still);
        } else {
          const r = await fetch(m.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          buf = Buffer.from(await r.arrayBuffer());
        }
        images.push({ type: "image", source: { type: "base64", media_type: m.mediaType, data: buf.toString("base64") } });
      } catch (e) {
        console.warn(`  media not loaded: ${m.url} (${e.message.slice(0, 120)})`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { images, expected: picked.length };
}

/** Prompt (+ images) in, reply text out. Throws on any failure. */
async function callModel(prompt, images) {
  const content = [{ type: "text", text: prompt }, ...images];

  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  // Prompt on stdin, not argv: the rubric is long, and its own "<0-5>"
  // placeholders get treated as redirection operators by cmd.exe when passed
  // as an argv string. `--tools "" --strict-mcp-config` denies tool access for
  // the grading call, so the grader cannot read files or run Bash mid-grade.
  // (`--allowedTools ""` turns NOTHING off: proven 2026-10-20.)
  // With media, images go in as base64 content blocks over stream-json input,
  // so tools stay fully off. stream-json input requires stream-json output;
  // the reply is the `result` event.
  const withImages = images.length > 0;
  const res = spawnSync(
    "claude",
    ["-p", "--tools", "", "--strict-mcp-config",
      ...(withImages ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : [])],
    {
      input: withImages
        ? JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
        : prompt,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (res.status !== 0 || !res.stdout) throw new Error(res.stderr?.trim() || `claude exit ${res.status}`);
  return withImages
    ? res.stdout.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((e) => e?.type === "result")?.result ?? ""
    : res.stdout;
}

/** One post, one model call. Returns a validated grade or null. */
async function gradeOnce({ rubric, context, exemplars, body, ref, images = [], expected = 0 }) {
  const partial = expected > images.length;
  const prompt = [
    "You are grading a social media post against a fixed rubric.",
    "Apply the rubric literally, using ITS dimensions, ITS weights and ITS scale.",
    "Deduct for every hard-rule breach the rubric names.",
    "",
    // The rubric states its own expected distribution, and both graders that
    // have run against it ignored that line: one put 14 of 15 posts above 90,
    // a first version of this one put the same posts at 43-60. Restating it as
    // an instruction is the calibration: the anchor was already written down,
    // it just was not being applied.
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
          "They set the QUALITY bar, not a template. Resembling them earns nothing:",
          "never score a post higher for reusing their structure, opener or turn,",
          "and never lower for taking a different shape that meets the rubric.",
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
    ...(expected
      ? [
          `MEDIA: this post carries ${expected} media file(s). ${images.length} are attached as images,`,
          "in post order (a video slide is shown as its final frame). Score `visual` from",
          "the attached images, every one of them, not from the caption.",
          ...(partial
            ? [
                `${expected - images.length} could not be loaded. Score \`visual\` only on what is`,
                "attached, do not guess at the rest, and start notes with",
                `"PARTIAL: visual from ${images.length} of ${expected} media."`,
              ]
            : []),
          "",
        ]
      : []),
    "Reply with ONLY a JSON object, no prose, no code fence:",
    '{"scores":{"<each rubric dimension key>":<number awarded>},',
    ' "max_scores":{"<same keys>":<maximum that dimension can score per the rubric>},',
    ' "notes":"<one or two sentences naming the specific lines and rules that cost points>"}',
    "",
    "Do NOT report a total. It is calculated from the numbers above.",
  ].join("\n");

  try {
    return parseGrade(await callModel(prompt, images), { expected, loaded: images.length });
  } catch (e) {
    console.error(`  ${ref}: grade failed (${e.message.slice(0, 200)})`);
    return null;
  }
}

/**
 * Grade a post SAMPLES times and take the median.
 *
 * A single run drifts about eight points on the same post: re-grading four
 * drafts moved them 73→71, 65→69, 70→72 and 63→71. That is tolerable for a
 * label and not tolerable for a gate, because a post either side of the bar
 * then ships or doesn't depending on which run it got. The median of three
 * throws away the outlier run rather than averaging it in.
 */
async function gradeOne(args) {
  const runs = [];
  for (let n = 0; n < SAMPLES; n += 1) {
    // One retry. A malformed reply is not a verdict on the post, and losing a
    // sample costs more than the extra call: it drops the median onto an even
    // pair. 2 of 30 calls came back unparseable in the run that exposed this.
    const g = (await gradeOnce(args)) ?? (await gradeOnce(args));
    if (g) runs.push(g);
  }
  return medianRun(runs);
}

async function main() {
  const context = loadContext();
  const rubric = loadRubric();
  const approved = readPosts(join(BRAND_DIR, "approved"));

  let exemplars = null;
  let exemplarRefs = new Set();
  if (!NO_EXEMPLARS && approved.length) {
    const picked = approved.slice(0, EXEMPLAR_COUNT);
    exemplarRefs = new Set(picked.map((p) => p.post_ref));
    exemplars = picked
      .map((p, i) => `--- Approved example ${i + 1} ---\n${p.body.slice(0, 2500)}`)
      .join("\n\n");
    console.log(`  ground truth: ${picked.length} approved post(s)`);
  } else if (!NO_EXEMPLARS) {
    console.log("  ground truth: none. Add the client's approved posts to approved/.");
  }

  // Video is skipped outright, and this is not a temporary hack. The rubric has
  // no video anchor, and Structure's anchor is a nine-beat, ~280-word LinkedIn
  // essay. Grading a 40-second clip against that measures the caption and never
  // the post. Run over a real queue it scored text at 77 average, 84% clearing
  // the bar, and video at 68, 47% clearing, with the biggest single loss on
  // VOICE, for posts that were the client speaking his own words.
  //
  // A wrong number is worse than no number here, because the bar turns it into
  // a gate. To grade video properly, feed the grader the transcript, then
  // delete this filter.
  //
  // Threads is skipped for exactly the same reason. Grading 66 posts gave
  // Instagram 77.8, LinkedIn 77.2 and Facebook 76.5, with no F anywhere, and
  // Threads 60.3 with 20 of 27 under the bar and ELEVEN F grades. A Threads post
  // is a few lines by design. The rubric measures its length and reports it as
  // quality.
  const isThreads = (p) =>
    String(p.platform ?? "").toLowerCase() === "threads" ||
    /(^|\/)threads_/.test(p.post_ref ?? "");

  const skipped = [];
  const skippedThreads = [];
  // A post is never graded against itself: an exemplar in the prompt would
  // score itself perfectly and tell us nothing.
  const targets = (APPROVED_ONLY ? approved : readPosts(join(BRAND_DIR, "posts")))
    .filter((p) => {
      if (isVideo(p)) { skipped.push(p.post_ref); return false; }
      if (isThreads(p)) { skippedThreads.push(p.post_ref); return false; }
      if (ONLY_REF && !p.post_ref.includes(ONLY_REF)) return false;
      return p.body.length > 40 && !exemplarRefs.has(p.post_ref);
    })
    .slice(0, LIMIT);
  if (skipped.length) console.log(`  skipped ${skipped.length} video post(s): this rubric has no video anchor`);
  if (skippedThreads.length) console.log(`  skipped ${skippedThreads.length} threads post(s): this rubric is LinkedIn-shaped`);
  console.log(`${BRAND}: ${targets.length} post(s) to grade, ${SAMPLES} sample(s) each, via ${process.env.ANTHROPIC_API_KEY ? MODEL : "claude CLI"}`);
  if (DRY_RUN) {
    for (const p of targets) console.log(`  would grade ${p.post_ref}`);
    return;
  }

  const scored = [];
  let failed = 0;
  for (const p of targets) {
    const g = await gradeOne({ rubric, context, exemplars, body: p.body, ref: p.post_ref, ...(await loadMedia(p.media)) });
    if (!g) { failed += 1; continue; }
    scored.push(g);
    const drift = g.spread ? `±${g.spread}` : "";
    const verdict = APPROVED_ONLY ? "" : g.overall >= BAR ? "  ships" : "  BLOCKED";
    console.log(`  ${String(g.overall).padStart(3)} ${g.grade} ${drift.padEnd(4)}${verdict.padEnd(9)} ${p.post_ref}`);
    console.log(`        ${g.notes}`);
  }

  if (!scored.length) { if (failed) process.exitCode = 1; return; }
  const totals = scored.map((s) => s.overall).sort((a, b) => a - b);
  const worstDrift = Math.max(...scored.map((s) => s.spread ?? 0));

  if (APPROVED_ONLY) {
    // The calibration read: what does the grader say about work the client
    // already signed off? A low spread here means the grader agrees with the
    // client's standard, and the publish bar can sit just under the floor. A
    // scatter means the grader is the thing that needs fixing.
    console.log(
      `\n${scored.length} post(s) the client approved: floor ${totals[0]}, ` +
        `median ${totals[Math.floor((totals.length - 1) / 2)]}, top ${totals[totals.length - 1]}. Worst run-to-run drift ${worstDrift}.`,
    );
    console.log(
      worstDrift > 10
        ? `Too noisy to gate on: one post moved ${worstDrift} points between runs. ` +
          "Raise --samples or fix the prompt before deriving a bar."
        : `A bar at ${totals[0]} passes everything the client approved. Grade unapproved ` +
          "drafts before setting it: a bar only means something if the two sets actually separate.",
    );
  } else {
    console.log(`\n${totals.filter((t) => t >= BAR).length} of ${scored.length} clear the ${BAR} bar. Worst run-to-run drift ${worstDrift}.`);
  }
  if (failed) { console.log(`${failed} failed to grade.`); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
