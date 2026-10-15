# Goal loop control architecture

**Status: design, not yet implemented.** Source: post-mortem of the 2026-10-13/14
warp3090 autonomous campaign (session `01a12bc2`, 26h, four goals), followed by an
adversarial expert review of two candidate designs. This document is the contract for
the next revision of `extensions/goal.ts`; where it conflicts with the current code,
the code is the incumbent and this is the change plan.

The design principle throughout: as simple as possible, but not simpler. The loop must
finish work **without the user**; the user is needed only to change intent and to
re-authorize spend. Everything else — approach changes, re-derivations, bail decisions
with evidence — completes autonomously, and every halt leaves a decision packet, never
a dead end.

## Why this design exists: two mirror failures

Both happened in the same session, and neither was a failure of effort.

### F1 — runaway grind (goal #2 endgame)

5.3h wall, 1.3M tokens, 20 continuations across two budget windows (a user
pause/resume silently reset the counter). The settle judge approved every continuation
because the work digest showed real effort — commits landed, root-causes found,
already-met criteria re-stamped — while the **unmet** criteria were flat for six hours
(one sat at ~475 t/s against a 1542 gate whose target was derived from an *assumed,
never-measured* vLLM number). Mid-loop the agent wrote, in plain text: "we're now on
the asymptote, and two of the four criteria are provably unreachable… the remaining
gap is a scope decision, not an engineering unknown." The loop had no channel for that
sentence and ran five more continuations until the user killed it manually at 14/25.

### F2 — premature bail (goal #3)

After 4.5h the agent called `blocked` claiming "the measured structural floor sits
3.5ms/round above the target" (steady 920 vs the 1066 gate). The call was accepted
with zero scrutiny → 5.5h idle. The user manually reframed — one clean measurement, a
recon of the vendored reference implementation, a fresh lever list — and the same
agent beat the same gate in 2h. Post-mortem: the "structural" verdicts rested on 1–2
datapoints and one profile window contaminated by prefill work (a hazard the agent had
itself documented the previous evening, then repeated), and the goal's scope-cap
language ("each lever gets at most two root-caused attempts") let *named lever
exhausted* masquerade as *component impossible*.

### What the failures teach

- Completion was already gated; the ungated decisions were **spending** and
  **stopping**.
- Effort is not progress. Progress is criterion-level movement on **unmet** criteria,
  held as a trajectory across turns — exactly the thing the agent's context loses to
  compaction and the judge must therefore hold.
- Both exits are claims about the future ("no path exists from here") and deserve
  adversarial review, with **asymmetric standards**: a false `complete` is the worst
  outcome (the user believes a lie); a false continue is unbounded spend; a false stop
  costs a night. Under uncertainty, park — but park *richly*.
- A breaker must bound **money units** (wall-clock, tokens), not counts: a
  continuation can be 5 minutes or 3h45m.

## Responsibility: who owns what

| | User | Agent | Judge | Breaker (deterministic) |
|---|---|---|---|---|
| Owns | intent + authorization | effort, diagnosis, all semantic state transitions | trajectory, evidence standards | budgets, caps, counters |
| Authors | goal text, criteria, pivot allowance, budgets | work; `complete` / `blocked` requests | verdicts + procedural mandates (advisory, escaped) | halt latches only |
| Ratifies | resumed goals, re-scopes, spend beyond budget | — (single write path preserved) | stops and reframes | — |
| Forbidden | — (sovereign) | resetting budgets; self-certifying a bail | steering tactics; mutating state; spending | any semantics |
| Absent default | — | keep working within epoch | fail-open to continue (semantics) / fail-safe to park (bail requests) | fail-closed on spend |

The division compensates each party's observed bias: the agent can't hold trajectory
(compaction) and shouldn't hold the wallet; the judge can't see the repo and must never
steer; the breaker is the user's enforcement proxy while they are away.

## The design: one question, three verdicts, two bounds, one counter

### ONE question

> **Should this goal keep spending as framed?**

Asked by three callers at the settle boundary: routinely (every due settle), on the
agent's `blocked` request (now a *request*, not an action), and forced by the breaker
when budget or cap is hit. One judge pass, one verdict machine — but a per-caller
failure table, because "Continue by default" is only correct for one caller:

| Caller | Judge dead / no opinion |
|---|---|
| Routine settle | Continue, plain (fail-open — a dead judge must not kill a healthy run) |
| `blocked` request | Park — packet notes "bail requested, unverifiable" (never a forced grind) |
| Breaker (budget/cap) | Stop regardless (deterministic; the packet notes the judge was unavailable) |

### THREE verdicts

1. **Continue** — the default. May carry a **procedural reframe**: a mandate to produce
   evidence (clean-window re-measure → enumerate wall components against the reference
   implementation → propose a fresh lever list), never a tactical instruction (never
   *which* lever or optimization). A reframe consumes one pivot.
2. **Stop** — parks the **loop latch**; it never writes `goal.status` (the agent stays
   the single author of semantic state). Emits a decision packet:
   - free text (the case),
   - a **typed flavor**: `impasse \| premise \| budget \| work-appears-complete`,
   - `resumeRequires`: `goal-change \| spend \| evidence`,
   - cumulative spend,

   and a `GoalParked` event on the shared bus so an out-of-band channel (pushover) can
   reach an absent user — a park that waits 12h for a decision the user never hears
   about has saved money and lost the night. The `work-appears-complete` flavor is the
   exception that does not park: it re-engages once with "call complete with
   per-criterion evidence," preserving the wrap-up path for verify-less goals.
3. **Complete** — the existing structural gate (per-criterion evidence + verify exit
   0). The judge never completes anything by verdict.

**Stop initiators — the initiator rule.** Semantic stops are agent-initiated only (the
scrutinized `blocked` request); system stops are deterministic only (budget/cap). The
judge alone can never stop a run: a false flat burns one pivot (bounded, and the
reframe's first rung — the clean re-measure — generates exactly the data that corrects
it), while a false stop costs the whole night. A rejected `blocked` request becomes a
reframe if a pivot remains, else a park with the contested case. Optional stricter
variant (only if budget-floor stops prove too slow in the field): a flat verdict that
follows the judge's own mandated reframe may stop.

### TWO bounds

- **Spend budget** — wall-clock first; tokens once per-turn parent-loop usage is
  confirmed to be exposed at the settle boundary (child-run spend is meterable, parent
  spend unverified). Judge-child spend counts inside the same budget: a per-settle
  judge call is spend too.
- **Continuation cap** — the count backstop, unchanged.

### ONE counter

**Pivots** (`PI_GOAL_MAX_PIVOTS`, default 1; `0` restores today's behavior exactly) —
the only system-granted continuation-budget refresh. A pivot does not reset the total
spend budget, the pivot count itself, met criteria, or the trajectory baseline: the new
epoch is judged against the same criterion gap. A user resume re-authorizes
deliberately and loudly — cumulative spend shown, no silent re-arm (the exact hole F1
walked through).

## The payload contract (the load-bearing plumbing)

Three invariants that F1 proved load-bearing, stated explicitly so they cannot rot
into "implied":

1. Measurement covers **unmet criteria only** — already-met criteria never re-certify
   progress (re-stamping is what masked six flat hours).
2. The trajectory is **criterion-level measured history across turns**, persisted in
   the `goal.state` branch entry — reload and compaction must not eat the judge's
   memory the way they eat the agent's.
3. **Unmeasured settles contribute no evidence** (measurement-starved runs trip the
   breaker; the current code already enforces this for triage-skipped turns).

Concretely: a typed `TrajectoryPoint` per measured settle — `{settle#, unmet-criterion
measured values OR the stable verdict+remaining string when the goal has no verify,
budget remaining, pivot#}`. The **plumbing** (not the small model) computes the
feasibility projection — observed rate vs remaining gap vs remaining budget — and hands
it to the judge to cite. "Flat" thereby stops being a vibe: slow-but-feasible projects
to completion (not flat); F1's six flat hours project to "cannot close by budget"
(reframe). Stated caveat: extrapolation is wrong on plateau-then-breakthrough curves —
that is precisely what the pivot is: one bounded bet on non-linearity. The flat label
is only offered to the judge at ≥2 measured points.

## Grounding: a warning, not a gate

A set-time hard gate on baseline provenance is unimplementable (provenance is
semantic, and at set time every baseline is unmeasured — that is what "assumed number"
means) and anti-purpose (it would block the measurement work that grounds the goal).
Instead, a chain that catches F1 at settle #1 instead of hour six:

1. The set result **warns the user out-of-band** when criteria cite numbers with no
   measured provenance in session — the user supplied the number; the agent will only
   argue with a warning it reads.
2. The existing set-time baseline verify seeds **trajectory point zero**, so the first
   assessment compares criteria gates against a measured baseline.
3. A premise contradiction at any later settle stops with flavor `premise`,
   `resumeRequires: goal-change`.

Warning → point zero → premise-flavored Stop is the hard gate, arriving one settle
later, autonomously, with evidence instead of a refusal.

## Cuts (this design is net-simpler than today's code)

- **The settle triage child pass** — merged into the one question: "Continue,
  measurement not due" is a triage verdict wearing the new vocabulary. The judge pass
  sees trajectory age + digest; its Continue can carry "measure this turn" as
  plumbing. `PI_GOAL_CHECK_EVERY` keeps decoupling measurement cadence from assessment
  cadence (a 10-minute verify at every settle is the cost triage existed to avoid).
- **The `ProgressJudge` seam and `PI_GOAL_MAX_PROGRESS_RESETS`** — pivots replace
  judge resets and are strictly safer: the spend budget, not a reset count, is the
  bound.

Net effect: fewer child LLM calls per cycle and one fewer knob than today.

## Replay checks

- **F1** → set-time warning to the user + baseline as point zero → unmet-only
  trajectory flat, projection infeasible → Continue + reframe (pivot: measure the
  oracle) → premise contradicted → Stop(premise) + packet + phone push; the spend
  budget is the floor regardless of judge health.
- **F2** → `blocked` request → impasse standard rejects it (2 datapoints, contaminated
  window, lever-exhausted ≠ component-impossible) → Continue + reframe → succeeds
  without the user. The impasse standard carries F2's lessons verbatim as prompt
  invariants: clean-window measurements, mechanisms refuted rather than attempts
  spent, the gate re-grounded.

## Implementation order (dependency-driven)

1. **Persisted counters + trajectory** (`goal.state` entries: continuations, pivots,
   spend, `TrajectoryPoint[]`; loud resume). Everything reads this. — SHIPPED
2. **The `blocked`-request path** — the per-caller failure table and the impasse
   second-opinion behind the existing planned judge seam; typed park flavors +
   `GoalParked` event (pushover already subscribes to the bus pattern). — SHIPPED
   (impasse flavor only; premise/budget/work-appears-complete flavors arrive with 4)
3. **Pivot plumbing** — counter, budget refresh semantics, the procedural reframe
   prompt template (the ladder). — SHIPPED
4. **The merged judge** — one pass with trajectory + feasibility projection; delete
   the triage child and the `ProgressJudge` seam + knob in the same motion. — SHIPPED

## Deferred / open

- Token metering for the parent loop (verify what pi exposes at settle before
  promising token budgets).
- Pivot default >1 only if field data shows false flats stealing the pivot a real
  reframe needed (the projection guard exists to make that unlikely).
- The post-reframe-flat stop variant (only if budget-floor stops prove too slow).
- The untrusted-digest framing and clip caps on judge free text ride along unchanged;
  free-text Stop reasons widen the laundering surface, so the typed fields carry the
  routing and the prose stays clipped.

## Slice 4 execution plan (the one remaining item)

Slices 1–3 are shipped (see Implementation order). Slice 4 is a rewrite of the
`agent_before_settle` handler (~512 lines in extensions/goal/index.ts) plus
judge.ts restructure; ~110 test references touch the seams being deleted.
Suggested sub-commits, each independently green:

1. **Feasibility projection, pure and additive** (`judge.ts` or a new
   `projection.ts`): `projectCompletion(trajectory, budgetRemainingMs)` →
   `"projects-complete" | "cannot-close-by-budget" | "insufficient-data"`.
   Input: the persisted trajectory tail (capped verify outputs) + spend
   remaining. Tests first; no wiring.
2. **Typed park flavors for the system stops**: premise (contradiction
   detected) and budget (breaker) park paths emitting `GoalParked` with the
   right flavor/resumeRequires; work-appears-complete re-engages ONCE with
   "call complete with per-criterion evidence" instead of parking. The
   ParkPacket/GoalParkedEvent unions already carry all four flavors.
3. **Merged verdict machine**: extend `SettleVerdict` to the design's
   vocabulary — Continue (may carry `reframe: true`, consuming a pivot via the
   slice-3 refresh), Stop (flavor + resumeRequires; parks the LOOP LATCH
   `stopped=true` WITHOUT writing goal.status), Complete. Trajectory +
   projection handed to the judge to cite; flat label offered only at ≥2
   measured points.
4. **The deletions, in the same motion**: `SettleTriage` +
   `createLlmSettleTriage` + `buildTriageTask` + `parseTriageVerdict` +
   `PI_GOAL_TRIAGE*` envs; `ProgressJudge` + `defaultProgressJudge` +
   `PI_GOAL_MAX_PROGRESS_RESETS` + `resetsUsed`/`maxProgressResets` (keep
   `resetsUsed` in the loop-state type one release for state-file
   compatibility, ignored). Rewrite the ~110 test references: triage tests
   become merged-verdict tests; progress-judge cap tests become
   budget-flavor park tests.
5. **Settle-time pivot consumption**: a Continue-with-reframe at a routine
   settle consumes a pivot exactly like the blocked-rejection path (slice 3's
   `pivotsUsed`/window-refresh logic), reusing `renderReframePrompt`.

Failure table (already half-built in the blocked handler) completes here:
routine settle judge-dead → Continue plain (fail-open, exists); breaker
(budget/cap) → deterministic Stop regardless of judge health, packet notes
judge-unavailable; judge Stop at a routine settle → latch-park + packet +
`GoalParked` (pushover already subscribes).
