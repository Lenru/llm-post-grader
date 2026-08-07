// Pure grading math for the post report card. No I/O, no LLM, no Supabase, so
// every rule here is testable and the weekly number Noah reads cannot drift.
// Judgment (what a post actually scores) lives in the rubric file and the
// grade-posts skill. This module only counts, bands, filters and formats.
//
// Two scales are in play, and every function here is explicit about which one
// it uses: each of the six dimensions is scored 0 to 5 (rubric anchor text is
// written for that range and stays that way), and those six raw points sum to
// 0-30 (RAW_TOTAL). The stored and displayed "overall" is that raw sum
// rescaled to a 0-100 score (SCORE_MAX), because a percentage reads better
// than a /30 total. Bands (A/B/C/D/F) are school-style cutoffs on the 0-100
// score, not the raw 0-30 sum.

export const RUBRIC_VERSION = "v2";

export const DIMENSIONS = ["hook", "voice", "clarity", "icp", "structure", "closer"];

const MAX_PER_DIMENSION = 5;
/** Raw sum ceiling: six dimensions times five points each. Internal use only. */
export const RAW_TOTAL = 30;
/** The displayed/stored overall score is rescaled onto this ceiling. */
export const SCORE_MAX = 100;
// Discord's hard limit is 2000; notify.mjs already trims to 1900. Format to the
// same bar so a long week is truncated here, where it is tested, not silently
// there.
const DISCORD_BUDGET = 1900;

const BANDS = [
  [90, "A"],
  [80, "B"],
  [70, "C"],
  [60, "D"],
];

// The bar a post must clear to be schedulable. Noah set this at 95 on
// 2026-08-02 when scores came from rubric v1, whose corpus averaged 88.5.
// The rubric was then recalibrated to v2, which deliberately redefines a 5 as
// "exceptional and rare" and a 4 as "the honest default for solid writing,"
// shifting the whole distribution down roughly 8 points; v2's own text says a
// good post lands "around 4s, which is roughly 80 out of 100." A 95 bar on
// that scale demanded near-perfection where good work scores 80, and it froze
// the queue: zero of 50 posts cleared it, best unpublished draft scored 80.
// Noah rescaled the bar to 88 on 2026-08-07 to restore the original intent
// (a stretch target, not a current-average description) on the v2 scale.
// With six 0-5 dimensions the reachable totals near the bar are quantized:
// 87 (26 raw) and 90 (27 raw), nothing between, so 88 functions as "27 of 30
// raw," i.e. three 5s and three 4s. Raising or lowering it is Noah's call,
// not a tuning knob.
export const PUBLISH_BAR = 88;

export function meetsBar(overall) {
  return overall >= PUBLISH_BAR;
}

/** Letter band for a 0-100 overall score. */
export function bandFor(total) {
  for (const [floor, letter] of BANDS) {
    if (total >= floor) return letter;
  }
  return "F";
}

/**
 * Validate an LLM-produced score object into exactly the six dimensions.
 * Throws rather than coercing: a malformed grade must not land in the table as
 * a quiet zero, because zeros drag the trend Noah reads.
 */
export function normalizeScores(raw) {
  if (raw === null || typeof raw !== "object") {
    throw new Error("scores must be an object");
  }
  const out = {};
  for (const dim of DIMENSIONS) {
    if (!(dim in raw)) throw new Error(`scores missing dimension: ${dim}`);
    const value = raw[dim];
    if (!Number.isInteger(value) || value < 0 || value > MAX_PER_DIMENSION) {
      throw new Error(`${dim} must be an integer 0 to ${MAX_PER_DIMENSION}, got ${JSON.stringify(value)}`);
    }
    out[dim] = value;
  }
  return out;
}

/** Sum of the six dimensions, 0 to 30. Internal use only; not stored or shown. */
export function rawTotalOf(scores) {
  return DIMENSIONS.reduce((sum, dim) => sum + scores[dim], 0);
}

/** The stored/displayed overall: the raw 0-30 sum rescaled to 0-100. */
export function overallOf(scores) {
  return Math.round((rawTotalOf(scores) / RAW_TOTAL) * SCORE_MAX);
}

/**
 * Disk refs that have no grade row yet, order preserved and deduped. This is
 * what makes the sweep idempotent: run it twice and the second run writes zero.
 */
export function pendingRefs(diskRefs, gradedRefs) {
  const graded = new Set(gradedRefs);
  const seen = new Set();
  const out = [];
  for (const ref of diskRefs) {
    if (graded.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Split an array into consecutive groups of at most `size` items, order
 * preserved. Used by the sweep to chunk Supabase inserts into small batches
 * instead of one bulk call; see grade-sweep.mjs for why that matters.
 */
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

/** Aggregate grade rows. Returns null when there is nothing to aggregate. */
export function summarize(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const byDimension = {};
  for (const dim of DIMENSIONS) {
    const total = rows.reduce((sum, row) => sum + row.scores[dim], 0);
    byDimension[dim] = round1(total / rows.length);
  }

  // Ties go to the earlier dimension in DIMENSIONS, which is why this is a
  // reduce over that array and not a sort of Object.entries.
  const weakestDim = DIMENSIONS.reduce((worst, dim) =>
    byDimension[dim] < byDimension[worst] ? dim : worst,
  );

  const avgOverall = round1(rows.reduce((sum, row) => sum + row.overall, 0) / rows.length);

  return {
    count: rows.length,
    avgOverall,
    byDimension,
    weakest: { dim: weakestDim, avg: byDimension[weakestDim] },
  };
}

const signed = (n) => (n > 0 ? `+${round1(n)}` : `${round1(n)}`);

/**
 * The weekly Discord message. Built to a character budget: the header, summary
 * and trend are always kept, and the per-post list is truncated to fit.
 */
export function formatReportCard({ summary, recent = [], prevSummary = null, skipped = [] }) {
  const lines = ["**Post report card**"];

  if (!summary) {
    lines.push("", "Nothing new to grade this week.");
    if (skipped.length) lines.push("", `Skipped (unparseable): ${skipped.join(", ")}`);
    return lines.join("\n").slice(0, DISCORD_BUDGET);
  }

  // avgOverall is already a 0-100 average (each row.overall is a 0-100 score),
  // so bandFor(Math.round(summary.avgOverall)) reads it on the same 0-100
  // scale bandFor expects. No second rescale here.
  const trend = prevSummary ? ` (${signed(summary.avgOverall - prevSummary.avgOverall)} vs last period)` : "";
  const clearingBar = recent.filter((row) => meetsBar(row.overall)).length;
  lines.push(
    "",
    `${summary.count} post${summary.count === 1 ? "" : "s"} graded, average ${summary.avgOverall}/100 = ${bandFor(Math.round(summary.avgOverall))}${trend}`,
    `Weakest dimension: ${summary.weakest.dim} at ${summary.weakest.avg}/5`,
    `${clearingBar} of ${summary.count} clear the ${PUBLISH_BAR} bar`,
    "",
    // Per-dimension detail stays on the 0-5 rubric scale, labeled /5 so it is
    // never mistaken for a slice of the 0-100 overall.
    DIMENSIONS.map((dim) => `${dim} ${summary.byDimension[dim]}/5`).join("  |  "),
  );

  const head = lines.join("\n");
  const tail = skipped.length ? `\n\nSkipped (unparseable): ${skipped.join(", ")}` : "";

  const postLines = [];
  let used = head.length + tail.length + 2;
  for (const row of recent) {
    const note = row.notes ? `: ${row.notes}` : "";
    const line = `${row.grade} ${row.overall}/100  ${row.post_title}${note}`;
    if (used + line.length + 1 > DISCORD_BUDGET) {
      const remaining = recent.length - postLines.length;
      const more = `...and ${remaining} more`;
      if (used + more.length + 1 <= DISCORD_BUDGET) postLines.push(more);
      break;
    }
    postLines.push(line);
    used += line.length + 1;
  }

  const body = postLines.length ? `${head}\n\n${postLines.join("\n")}` : head;
  return `${body}${tail}`.slice(0, DISCORD_BUDGET);
}
