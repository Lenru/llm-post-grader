# llm-post-grader

Grades social media posts against a brand's own written rubric with Claude, and blocks anything below the brand's bar from being scheduled.

I built it for the content system I run at my studio, Watson's Media. It decided which client posts were allowed to publish. This repo is that grader pulled out so it runs on its own, with a fictional brand to try it on.

## Real output

The example brand is a fictional physio clinic. One deliberately bad post, one decent one:

```
$ npm run grade
northside-physio: 2 post(s) to grade, 3 sample(s) each, via claude CLI
   28 F       BLOCKED back-pain-miracle.md
        Sourcing is zeroed by three hard-rule breaches: "we can fix it in ONE session" and
        "gets results every time" are outcome promises, and "94% of back pain is caused by
        poor posture" is an invented statistic absent from the claims bank. Voice collapses
        on hype the guide bans outright ...
   88 B ±1    ships   hip-pain-runners.md
        No hard-rule breaches ... 'build strength around the hip so it can take the miles
        again' extends the tendon-loading claim to a hip/running case the bank does not
        cover, which is the main sourcing deduction.
```

The grader only knows the 94% figure is invented because it's checking against the brand's claims bank in [voice.md](example/northside-physio/voice.md). The same check caught the good post stretching a real claim further than the bank supports.

Calibration grades the client's own approved posts. If the grader marks those down, the grader is the thing that's wrong:

```
$ npm run calibrate
  04-written-plan.md: grade failed (unparseable JSON)     <- retried, not dropped
   89 B ±1            03-tendon-rest.md
   90 A               04-written-plan.md
   89 B ±3            05-two-clinics.md

3 post(s) the client approved: floor 89, median 89, top 90. Worst run-to-run drift 3.
```

## How it works

1. Load the brand folder: the rubric, the voice guide and claims bank, and posts the client approved without changing a word.
2. Put a few approved posts in the prompt as the standard to grade against.
3. Grade each post three times with tools switched off, and take the median.
4. Add up the total, the letter grade and the ship/blocked verdict in code, never trusting the model's arithmetic.

```
example/northside-physio/
  post-rubric.md   dimensions, weights, hard rules
  voice.md         voice guide + the only facts a post may state
  approved/        posts the client signed off with no edits
  posts/           posts to grade
```

## What I learned building it

The interesting parts are in the commit history and the comments. The short version:

- **A rubric is not a standard.** I graded 13 posts the client had approved word for word, and they scored 51 to 87. The one marked "approved verbatim, do not edit a word" scored 65. The rubric covers the criteria, but only the client's accepted work shows what good looks like. Putting three approved posts in the prompt raised the lowest score from 51 to 70.
- **One run is not a grade.** The same post drifted about 8 points between runs, which matters when a bar decides whether it ships. Each post is graded three times and the median wins. With an even number of good runs it takes the *lower* middle, so a failed sample can't flatter a post.
- **The model's arithmetic is not trusted.** An early run returned dimension scores adding up to 42 and an "overall" of 32. Totals are calculated from the per-dimension scores, in tested code.
- **Some formats are skipped rather than scored wrong.** On a real queue, Threads posts averaged 60 with eleven F grades while every other platform sat around 77. The rubric was measuring their length and calling it quality. Video and Threads are skipped until there's a rubric that fits them, because a wrong number on a publishing gate is worse than no number.
- **Each brand's bar comes from its data.** For one client, approved posts scored 69 to 89 and unapproved drafts 64 to 81. Those ranges overlap, so no bar separates them cleanly. The bar sits at 69, the lowest score on work they approved, so it never blocks something they've already said yes to. `--approved` runs that calibration.
- **The grader can't touch anything.** It runs with tools switched off: `--tools ""` (it turns out `--allowedTools ""` switches nothing off).

## Run it

Needs Node 20.12+, plus either [Claude Code](https://claude.com/claude-code) logged in or an `ANTHROPIC_API_KEY`.

```bash
npm test             # 40 tests, no model calls
npm run grade        # grade example/northside-physio/posts
npm run calibrate    # grade the client-approved posts to find where the bar belongs
node src/grade-brand.mjs --brand=<your brand folder> --samples=1 --ref=<filename>
```

## Provenance

Taken out of the system I run day to day, with its git history kept as it was: the first commit is from July 2026. Client names are replaced with "Clinic" and "Community". The last commit swaps the database and dashboard for plain folders so it runs anywhere.

MIT licensed.
