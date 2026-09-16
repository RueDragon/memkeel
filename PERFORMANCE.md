# Performance baseline

This file records what the program actually costs, on a stated machine, with a reproducible script.
It exists because the plan asks for the bottleneck to be found before anything is optimised, and for
improvements to be shown rather than felt. Nothing here is a target; the numbers are observations, and
the one thing that has not been done yet is stated as not done.

## How to reproduce

```bash
node scripts/perf-bench.mjs --events=1000                 # one scale
node scripts/perf-bench.mjs --all                         # 1k, 10k, 100k
node scripts/perf-bench.mjs --events=10000 --json=out.json # machine-readable
```

The dataset is seeded (`--seed`, default `20260916`), so two runs at the same scale produce the same
store. Each run creates its own memory home and store; set `MEMKEEL_PERF_ROOT` to place them somewhere
specific.

## Method, and three things that would otherwise make the numbers meaningless

1. **The dataset is written straight into the journal, not through `record()`.** That is a consequence
   of what the code does, not a way around it: `record()` replays the whole journal and recomputes the
   preference projection on *every* write (`lib/core.mjs:476` and `:482`), so generating N events
   through it costs O(N²). The generator's job is to produce a realistic store; the write path is
   measured separately, on a few writes, against the finished dataset — and that measurement is where
   the bottleneck shows up.
2. **Percentiles are observed samples, not interpolations.** `p50`/`p95`/`max` are values that
   occurred; the mean is reported next to them rather than instead of them.
3. **Cold and warm are separated.** `first` is the first call after process start and `p50` is the
   steady state. For a hook that runs once per session, `first` is the number a user feels.

Iteration counts shrink with the scale (10 at 1k, 5 at 10k, 3 at 100k) because repeating a
second-scale operation ten times measures patience rather than latency. Each row reports its `n`.

The synthetic shape deliberately includes the cases that make reduction expensive rather than only the
easy one: 8 workspaces, a long context body on every fourth event (at the 1600-character contract
ceiling — beyond it `validateLearning` rejects the event, so a dataset that ignored that would not be
a store this program can hold), a repeated fact key on most events, roughly one in six of those
carrying an explicit `supersedes`, and the rest left as conflicts.

## Baseline environment

| | |
| --- | --- |
| CPU | 12th Gen Intel Core i7-12700 |
| RAM | 32 GB |
| OS | Windows (win32) |
| Node | 22.22.3 |
| Arch | x64 |

These numbers are only comparable to runs on the same machine and version. A recorded baseline that
does not state its machine is not a baseline.

## Results

Times in milliseconds.

### 1,000 events, 8 workspaces — store 1.9 MiB, index build 32.9 ms, RSS 157 MiB

| operation | first | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| loadEvents (full replay) | 539.5 | 1.8 | 2.5 | 2.5 |
| refreshIndex (cached) | 15.9 | 15.8 | 21.0 | 21.0 |
| refreshIndex (force) | – | 32.2 | 33.3 | 33.3 |
| bootstrap | 304.9 | 321.5 | 497.1 | 497.1 |
| recallFacts | 25.4 | 25.1 | 27.1 | 27.1 |
| recallLearning | 139.3 | 141.1 | 150.7 | 150.7 |
| settingsSnapshot | 20.8 | 20.2 | 27.3 | 27.3 |
| accessLogSummary | 0.4 | 0.04 | 0.1 | 0.1 |
| **record (write)** | – | **890.7** | **1294.2** | 1294.2 |
| consolidate | – | 12.6 | 1055.3 | 1055.3 |
| http /api/overview | 72.0 | 12.9 | 15.0 | 15.0 |
| http /api/detail | 4.9 | 4.6 | 5.5 | 5.5 |
| http /api/events | 6.9 | 6.3 | 7.3 | 7.3 |

### 10,000 events, 8 workspaces — store 18.5 MiB, index build 333.4 ms, RSS 366 MiB

| operation | first | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| loadEvents (full replay) | 12018.9 | 11.9 | 14.2 | 14.2 |
| refreshIndex (cached) | 127.1 | 129.0 | 169.6 | 169.6 |
| refreshIndex (force) | – | 371.0 | 371.0 | 371.0 |
| bootstrap | 2994.4 | 3271.5 | 3387.7 | 3387.7 |
| recallFacts | 556.9 | 402.5 | 764.7 | 764.7 |
| recallLearning | 223.9 | 218.3 | 225.9 | 225.9 |
| settingsSnapshot | 23.5 | 23.6 | 24.5 | 24.5 |
| accessLogSummary | 0.7 | 0.2 | 0.6 | 0.6 |
| **record (write)** | – | **8483.2** | **11435.3** | 11435.3 |
| consolidate | – | **25611.9** | 25611.9 | 25611.9 |
| http /api/overview | 71.3 | 70.2 | 71.9 | 71.9 |
| http /api/detail | 14.4 | 13.1 | 16.4 | 16.4 |
| http /api/events | 14.4 | 15.5 | 17.5 | 17.5 |

Correctness measured from the same stores: 1k → 1010 events read, 8 topics, 126 current facts, 739
conflicts, 145 supersede links; 10k → 10010 events, 8 topics, 1251 current facts, 7292 conflicts, 1467
supersede links. The conflict and supersede counts are re-derived independently from the journal by
`test/perf.test.mjs`, so a projection that quietly stopped honouring `supersedes` would fail there
rather than read as a speed-up.

## What the numbers say

**The bottleneck is a full journal replay on every write, and it makes the write path O(N²).** A
single `record()` costs 890 ms against 1k events and 8483 ms against 10k — 10× the events, 9.5× the
cost. The mechanism is visible in the code: `lib/core.mjs:476` calls `loadEvents(config)`, and
`lib/core.mjs:482` runs `preferenceProjection` over every event, both on each write. The parse itself
is cached (`lib/core.mjs:406-408`), but an append invalidates the cache, so the next call re-parses
every journal file: the cold replay is 539 ms at 1k and 12 s at 10k, and each write pays it again.

The same shape shows up one level up. At 10k, `bootstrap` is 3.3 s and `consolidate` is 25.6 s. Those
are not "a bit slow" — a nightly consolidate or a session-start hook at that size is unusable, and the
growth from 1k to 10k is roughly linear in N, which means it does not flatten out at 100k.

**`refreshIndex` is not free when it has nothing to do.** 15.8 ms at 1k and 129 ms at 10k, on a call
whose contract is "return the current index". That is a hot-path cost proportional to the store, and
it is the cheapest of the three to fix.

What is *not* a problem, which is worth recording so effort does not go there: `settingsSnapshot`
(20-24 ms, independent of N — it reads configuration), `accessLogSummary` (0.04-0.2 ms),
`recallLearning` (141 → 218 ms for 10× the events, so sublinear), and the HTTP layer itself
(`/api/detail` and `/api/events` are 5-16 ms; the first `/api/overview` call pays the cold replay and
then costs 13-70 ms).

## What has not been done

**No optimisation has been made, so there is no before/after comparison yet.** That is deliberate. The
plan requires that performance work not change retrieval or reduction semantics, and the obvious fix —
caching parsed blocks per journal file keyed by `(mtimeMs, size)` so an append re-parses only the file
that changed — has a real hazard: `validateEvent` is configuration-dependent, and the current cache
fingerprint covers only the event files, not the configuration. A change there could start accepting
an event it previously rejected, or reuse a parse that was validated against a different topic set.
That needs its own design and its own tests; shipping it at the end of a session without them would be
exactly the "felt improvement" the plan warns against.

The order to try next, cheapest and safest first:

1. `refreshIndex` does work when the fingerprint is unchanged — make the no-op actually a no-op, and
   measure it. Low risk, and it is on every dashboard request.
2. Per-file parse caching for the journal, with the validation semantics preserved: cache the parsed
   JSON, re-run `validateEvent` each call, and extend the fingerprint to cover the configuration keys
   validation reads. Verify with the full suite plus the correctness block in `test/perf.test.mjs`.
3. Only then consider the write path itself. Bounding `consolidate` and `bootstrap` may matter more
   than the per-write cost.

## Not measured at all

- **100,000 events.** The script supports `--events=100000`, but the run did not complete in this
  session: at the measured scaling a single write there would cost minutes and `consolidate` far
  longer. Any 100k figure would be an extrapolation, and extrapolation is not a measurement.
- **Peak memory during a single operation.** Only process RSS after each scale is reported (157 MiB at
  1k, 366 MiB at 10k); no per-operation peak was sampled.
- **Disk IO.** No read/write byte counters or syscall counts were collected.
- **Cold process start per scale.** "Cold" here means the first call in a warm process, which is what a
  long-lived dashboard sees; a genuinely cold process start was not measured separately.
- **A 100k store under the dashboard.** Only the direct read paths were exercised at the larger scales.
