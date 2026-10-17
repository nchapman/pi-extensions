# Persistent background bash tasks

**Status: Implemented (pi-extensions `main`).** Designed as r2 after an
adversarial expert review of r1; the load-bearing host claims were verified
against pi 1.3.0's dist (pi's kill paths genuinely cannot reach an untracked
spawn; shutdown always precedes the new runtime's start; a steer delivered
while idle starts a real turn). The implementation lives in
`lib/persistent-bash.ts` (pure core), `lib/superbash.ts` (`persist` path +
`resumePersistedTasks`), and `extensions/subagents/index.ts` (session_start /
session_shutdown wiring); tests in `tests/persistent-bash.test.ts`,
`tests/superbash.test.ts`, and `tests/subagents.test.ts` exercise the real
wrapper and real process spawns. The "explicitly not now" section at the end
remains the deferred list.

The design principle: **the session owns the wake, not the work.** A backgrounded
subagent burns API tokens while nobody consumes its result, so it must die with the
session. A backgrounded shell command burns nothing — the work itself is the value —
so it may outlive the runtime that started it, provided its output lands on disk
either way and its outcome is reported when the session returns.

**The second principle (added in r2): ownership of a persistent task lives on
disk, and exactly one monitor owns it at a time.** An in-memory closure that
outlives its registry (reload, session replacement) must never be able to delete
the durable state or fire the wake — sparing a task means *transferring ownership
to the metadata*, not abandoning a live monitor.

## Why this design exists: three kill layers

Restarting pi kills background bash tasks today through three independent
mechanisms, each of which the design must address or accept:

1. **pi core kills on signals and crashes.** Every shell command pi spawns is
   `detached: true` (own process group) with its pgid in
   `trackedDetachedChildPids`; `killTrackedDetachedChildren()` SIGKILLs every
   still-running group on SIGHUP/SIGTERM, on `uncaughtCrash`, and on dead-terminal
   emergency exit (pi 1.3.0 `dist/utils/shell.js`, `dist/modes/interactive/
   interactive-mode.js`). This fires before any extension runs. **Consequence:** a
   persistent task must not be spawned through pi's own bash operations, because
   those register the pid with pi's kill list. (Verified: every core kill path
   receives only tracked pids; a child pi never spawned is unreachable — including
   TUI suspend's `kill(0, SIGTSTP)`, which targets pi's own group.)
2. **We kill on every shutdown reason.** `extensions/subagents/index.ts`
   `session_shutdown` → `registry.killAll()` for quit, reload, new, resume, and
   fork alike. **Consequence:** the registry must learn to spare persistent tasks,
   and the shutdown notice must say what was spared.
3. **Piped children die of SIGPIPE.** Background tasks pipe stdout/stderr to pi,
   which streams them into `<sessionDir>/tasks/<id>.log`. If pi vanished without
   killing, the child's next write to the closed pipe raises SIGPIPE and kills it.
   **Consequence:** a persistent task must write its own log directly — the child
   holds the file descriptor, not pi. (With an inherited fd, SIGPIPE is
   structurally impossible: stdout is a file.)

Notably the existing design is already half-persistent: the log lives beside the
session "so it survives resume" — but the process never survives to fill it, and the
wake never survives to report the outcome. This design finishes what the log path
started.

## Scope cuts

- **Bash only.** Subagents stay session-scoped (token burn); `subagent`/`subagents`
  are unchanged.
- **Opt-in per call.** New `persist: true` param on the `bash` tool, valid only
  with `wait: "background"`. `PI_BG_BASH_PERSIST=1` flips the session default —
  for `wait: "background"` calls only: **auto never persists in phase 1, with or
  without the knob**, and `persist` + `wait: "auto"` is always an explicit tool
  error pointing at `wait: "background"`. Opt-in keeps the abandoned-session leak
  (below) a deliberate act, not an ambient hazard.
- **`wait: "auto"` cannot persist** (phase 1): its fds are pi's pipes from byte
  zero, and retro-detaching is impossible. (A later phase could spawn auto tasks
  child-side-logged from the start and tail the file during the blocking window,
  unifying both modes. Not now.)
- **`ssh_bash` excluded** (phase 1): a remote pid is not locally killable and the
  child-side log trick has no local fd to inherit. `persist` on a `prepare`-based
  tool is an explicit tool error.
- **Unix only.** `kill(-pgid)` semantics; on win32 `persist` is rejected up front.
- **Forks share their tasks (accepted, documented).** A fork reuses the same
  session dir, so both branches scan and adopt the same persistent tasks: each
  branch's agent gets its own wake once, and a kill from either branch stops the
  work for both. This is coherent ("the work outlives the session") and the only
  safe alternative is worse — skipping the scan on fork would leave a
  fork-then-quit with unowned tasks. If ownership should be exclusive to one
  branch, kill the task in the other.

## The on-disk contract

All under `<sessionDir>/tasks/`, beside the existing `<id>.log` and `<id>.txt`
stash (no collisions — different suffixes):

| File | Writer | Contents |
| --- | --- | --- |
| `<id>.log` | the child (stdout+stderr redirected to it, `O_APPEND`) | full output from byte zero |
| `<id>.status` | the wrapper, after the command exits | the exit code, one truncate-write |
| `<id>.task.json` | pi, **after** a successful spawn | `{version: 1, id, command, pid, startedAt, timeoutSecs?, cwd}` |

Invariant: **metadata files exist ⇔ the outcome is not yet reported.** On any
settle (completion, death, kill, timeout) the owning monitor deletes
`<id>.task.json` and `<id>.status` and keeps `<id>.log` (matching pipe mode, where
logs outlive completion for the `task` tool to point at). The invariant is enforced
in-process by the detach mechanism (below), not just hoped for.

`O_APPEND` matters: the leader and any grandchildren share one open-file
description (one offset); without append semantics their interleaved writes
overwrite each other.

**Metadata is written after spawn, not before** (r1 said the reverse — it
contradicted the `pid` field). Sequence: allocate id → open the log fd → spawn →
write `.task.json` (now the pid exists) → adopt. On spawn error, unlink the empty
log. The accepted crash window: pi dies between spawn and write leaves an
untracked, unowned process with a log but no metadata — invisible to every scan.
The window is milliseconds; documented, not machined around.

### The wrapper

The command never appears in the script text — it rides in the environment, which
eliminates every quoting question and, because `eval` parses its argument at
runtime, keeps the status write alive when the command is a syntax error:

```sh
eval "$PI_BG_TASK_COMMAND"
code=$?
printf '%s' "$code" > "$PI_BG_TASK_STATUS"
exit "$code"
```

Spawn: resolved shell (`/bin/bash` → PATH → `sh`, pi's own resolution),
`detached: true` — on POSIX this is `setsid()`: the child leads its own session
and process group (pgid == pid), has no controlling terminal, and terminal-borne
SIGHUP cannot reach it — `stdio: ["ignore", logFd, logFd]`, env from the existing
`buildBashEnv` plus the two `PI_BG_TASK_*` vars, then `child.unref()` and close the
fd in the parent.

**Known wrapper degradations (documented, accepted):** `exec cmd` and a bare
`exit N` terminate the shell before the status write — the away-wake reports
"exit code unknown" for a normally-exited command. And a self-backgrounding
command (`cmd &`, daemons that fork-and-exit) makes the wrapper exit immediately
while grandchildren keep the group alive forever, still appending to the log —
persistence removes every automatic cleanup path for them (pipe mode's
`killProcessTree` never sees them). The prompt guideline calls this out: in
persistent mode the *task* is the background mechanism; never `&` inside it.

## Lifecycle

**Spawn (bash tool, `wait: "background"` + persist).** As above; adopt into the
registry with `persistent: true`; return the backgrounded notice naming the log
path and the survive-restarts contract.

**Monitor (attached).** The child's `exit` event settles the task immediately
(code from the event — no status-file race); a slow poll (unref'd interval, 2s) is
the uniform backstop and the only mechanism that works after re-adoption. Poll
order is **status before liveness**: `kill(pid, 0)` succeeds on zombies and a
finished task's wrapper always wrote `.status` before exiting, so the status file
wins every race that matters (and a recycled pid with no status file can only ever
produce a harmless "exit code unknown"). Status reads retry briefly (≤2s) on
missing *or empty* content (the truncate-then-write window). Deadline enforcement
(`timeoutSecs` recorded in metadata): the monitor kills the group at expiry and
settles `timed out after Ns`, exactly the pipe-mode wording.

**Shutdown (all reasons) — spare means detach, not abandon.**
`registry.killAll({ sparePersistent: true })` converts each spared task's
in-memory ownership to disk-only, synchronously: the registry calls the task's
`detach` handle (registered at adopt), which (a) removes the child `exit`
listener, (b) clears the poll interval, and (c) sets a `handedOff` flag that
`settle()` checks *first* and makes a full no-op — no metadata delete, no wake, no
kill — then drops the registry entry. r1's wording ("the registry entry dies with
the runtime") was the bug: on reload/new/resume/fork the runtime dies but the
process doesn't, and a closure that outlives its registry would settle through a
torn-down extension runtime (wake lost, metadata deleted — outcome reported
nowhere) or double-settle against a scan that re-adopted. After detach, the
metadata is the single owner and the new runtime's scan is the sole claimant.
On quit this is equally correct: the process exits, the files remain.

**Re-adopt (session_start, every reason).** Scan `<sessionDir>/tasks/*.task.json`,
fail-open and non-blocking (async-floating with a catch; each `ps` check bounded
with a timeout and capped output — a slow `ps` must never stall TUI startup):

- `.status` exists → finished while pi was away: adopt-and-complete immediately
  with a wake — `exited N`, total runtime, `(finished while pi was away)`, output
  tail, log pointer. If runtime exceeded `timeoutSecs`, annotate `(overran its
  timeout)` — honesty over tidiness.
- Leader dead (`kill(pid, 0)` → ESRCH) → died without a status (killed, OOM, or
  the wrapper's group died with the command): settle as failed, `exit code
  unknown — the process disappeared while pi was away`, keep the log for
  inspection. Status-read retry before concluding.
- Alive → **identity check** (`ps -p <pid> -o etime=` with `LC_ALL=C`; parse
  `[[dd-]hh:]mm:ss`; must match `now - startedAt` within ±60s — both sides are
  wall-clock, so suspend inflates both consistently), then re-adopt. The
  verdict is tri-state: **mismatched** (a live pid with the wrong age —
  recycled) settles as lost-while-away with cleanup; **unknown** (ps missing,
  slow, EPERM — implemented as a bounded 5s probe) neither adopts nor destroys:
  the durable state stays untouched for the next start to retry, with a notice
  saying so, because destroying a healthy task's record on a ps blip would
  orphan it forever. A false "died" is the safe direction since an unverified
  pid is never killed.
- Deadline already passed → kill now, settle `timed out (deadline passed while pi
  was away)`.

Re-adopted tasks are ordinary registry entries: `task <id>` peeks the log (fresh
offsets — first peek shows the tail), `task_remind` works again from scratch (old
reminders were in-memory and are gone, by design), `task_kill` works across the
restart, and goal's settle check sees them as running work — deferral while a
persistent task runs is intended; goal's park path already handles never-waking
tasks and `/tasks kill` reaches persistent ones, so persistence adds holding, not
livelock.

**Kill.** Attached tasks hold the real `ChildProcess` — kill directly. Re-adopted
tasks kill by `-pgid` after the identity check. Kill also unlinks the metadata and
the log, matching pipe mode's kill-cleans-up contract.

**Wake delivery hardening (required, fixes a latent bug in today's wakes too).**
`deliver()` is fire-and-forget over `pi.sendUserMessage(..., { deliverAs: "steer"
})`. While idle — exactly the away-wake's path at session_start — the underlying
`prompt()` can reject asynchronously (expired auth, no model). pi registers no
`unhandledRejection` handler, so Node's default escalates it to `uncaughtException`
→ `uncaughtCrash` → `killTrackedDetachedChildren()` + exit: at session open, one
expired token would kill pi *and every running non-persistent task*. The send must
be `void promise.catch(() => {})` — a lost wake is strictly better than a crash.
(Verified: a steer at session_start lands — idle `prompt` starts a real run, so no
queuing is needed; the `notify` + `task <id>` fallback covers the swallowed case.)

## Failure modes and mitigations

- **In-process handoff races** — solved by detach (above); single-threaded JS
  makes the synchronous flag flip race-free.
- **Pid recycling.** Identity-checked before any kill or adoption of a re-adopted
  task (etime vs `startedAt`, ±60s; never kill an unverified pid). Attached tasks
  need no check — the `ChildProcess` handle *is* the identity. Mid-poll recycling
  after the wrapper died without writing status can only misreport "exit code
  unknown", never kill.
- **Two processes, one session** (resume in two terminals): both scans adopt, both
  monitors poll, each process wakes its own agent once; kills resolve to one
  killer and one "already dead" observer; divergent status reads are cosmetic.
  Benign and documented — no locks for a personal tool.
- **Abandoned sessions leak processes.** The cost of persistence, accepted for
  opt-in use. The metadata files make the leak auditable (`ls */tasks/*.task.json`)
  and `/tasks kill` reaches them whenever the session is opened again.
- **Log growth** (chatty dev servers): disk-only cost — readers are tail-bounded.
  `task <id>` and `/tasks` show each task's log size so growth is visible.
  Rotation is deliberately absent (the child holds the fd; rotation would break
  the invariant). The later reaper/TTL owns cleanup.
- **Stale metadata after a kill crash.** If pi dies between killing the group and
  unlinking, the next scan finds dead-pid metadata and finalizes it as
  died-while-away. Self-healing by construction.
- **`eval` env leakage.** `PI_BG_TASK_COMMAND`/`PI_BG_TASK_STATUS` are visible to
  the command. Same trust boundary as the command itself; namespaced; documented.

## Surfaces

- `bash` param `persist?: boolean` — "Survive pi restarts (wait background only):
  the command logs to `<sessionDir>/tasks/<id>.log` and its outcome is reported
  when this session is next opened." Prompt guidelines: use for dev servers, long
  builds and migrations whose value survives a restart; not for throwaway runs;
  never `&` inside a persistent task — the task itself is the background
  mechanism.
- `PI_BG_BASH_PERSIST` — parse in house style (`parse*` helper, falsy/truthy
  sets, invalid falls back to off), read per call like the other BG knobs;
  affects `wait: "background"` only.
- `/tasks` listing marks persistent tasks (`t-xxx (bash, 4m, persistent, log
  2.1MB)`); `/tasks kill all` still kills them — explicit user intent beats
  persistence; only shutdown spares (by detaching).
- Wake texts distinguish the away cases (`finished while pi was away`, `exit code
  unknown`, `deadline passed while pi was away`, `overran its timeout`).

## Implementation slices

Each slice lands green (`npm run check`) with its tests before the next starts;
pure logic exported from the new module so vitest covers it directly, boundaries
(spawn, ps, kill, clock, timers) injected per house pattern.

1. **`lib/persistent-bash.ts` — pure core.** Paths, wrapper script builder, meta
   read/write (post-spawn), `parseBashPersist`, etime parsing + identity check,
   scan state machine (status-first: given fakes for status/liveness/identity →
   outcome per metadata file), kill-and-cleanup, bounded-ps helper. Tests:
   `tests/persistent-bash.test.ts`.
2. **Registry support.** `BgTask.persistent`, `adopt({persistent, detach})`,
   `killAll({sparePersistent})` implemented as detach-and-drop (default unchanged
   — kills all), `deliver()` rejection swallow, display marker in
   `describeRunningTasks`. Tests in `tests/superbash.test.ts`.
3. **`createBashTool` persist path.** Param validation (mode/sessionDir/prepare/
   win32), spawn via the new module (O_APPEND log, post-spawn meta), monitor +
   deadline (status-first polling), detach handle wiring (listener removal,
   interval clear, `handedOff` no-op guard), notice text, settle cleanup. Tests
   in `tests/superbash.test.ts`.
4. **Wiring in `extensions/subagents/index.ts`.** Non-blocking fail-open scan at
   `session_start` (every reason; shared-dir fork semantics as documented),
   detach-spare at `session_shutdown` + notify wording. Tests in
   `tests/subagents.test.ts` driving `registerSubagentsExtension` with the fake
   pi.
5. **Docs.** Update the `superbash.ts` and `index.ts` header comments (the
   session-scoped cut becomes: subagents session-scoped, bash opt-in persistent),
   this document's status, and `sshbash`'s header note about the rejected
   `persist`. Full `npm run check` + review tool before commit.

## Later, explicitly not now

- Auto-mode unification (child-side logging from byte zero, pi tails the file
  during the blocking window) so `wait: "auto"` can promote into persistence.
- `ssh_bash` persistence via remote nohup + remote status files.
- A reaper for abandoned sessions (TTL on `.task.json` across all sessions) and
  group-sweep at settle for self-backgrounding stragglers.
- Log rotation (breaks the child-holds-the-fd invariant; needs a child-side
  strategy).
