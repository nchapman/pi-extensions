/** The verify boundary: execute the goal's check command under timeout and
 * process-tree discipline, return a capped, structured result. Pure of goal
 * state — callers inject it (VerifyRunner) so tests replace it wholesale. */

import { spawn } from "node:child_process";
import { VERIFY_TIMEOUT_MS_DEFAULT } from "./config";

export const MAX_VERIFY_OUTPUT = 4096;

/**
 * Result of running a goal's verify command. `ok` is true only on a clean exit 0
 * with no timeout/spawn error/abort; `aborted` marks a run cut short by the
 * agent run's abort signal (Esc) or a session teardown; `output` is a capped
 * tail of combined output.
 */
export interface VerifyResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted?: boolean;
  spawnError?: string;
  output: string;
}

/** The verify boundary: execute a command, return its result. Injected in tests. */
export type VerifyRunner = (
  command: string,
  opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal },
) => Promise<VerifyResult>;

export const VERIFY_TRUNCATION_PREFIX = "…(truncated) ";
export function capVerifyOutput(s: string, n = MAX_VERIFY_OUTPUT): string {
  return s.length > n ? `${VERIFY_TRUNCATION_PREFIX}${s.slice(-n)}` : s;
}

/** Abort closures for checks currently running at the settle boundary — the
 * verify's shell tree or the milestone judge's child — drained on
 * session_shutdown so a reload mid-check doesn't leave an orphaned gate suite
 * or a half-spawned judge holding locks and GPUs (the timeout timer dies with
 * the host process). Each closure aborts its check's controller, which kills
 * the whole process tree; the pending runVerify/child then resolves `aborted`
 * (not a fabricated failure), so callers treat a teardown kill exactly like Esc. */
export const liveCheckAborts = new Set<() => void>();

/** Probe a process group: true while any member still exists. EPERM means the
 * group exists but is foreign — report it as alive (conservative). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Grace window (ms) between the shell's exit and stream close. A gap larger
 * than this means a descendant held the inherited stdio open — the check
 * backgrounded its work — so the shell's exit code is not the work's verdict.
 * Normal foreground verifies close within a few ms of exit (stream drain). */
const EXIT_TO_CLOSE_GRACE_MS = 250;

/**
 * Run a verify command in a bounded shell: hard timeout + capped output + whole
 * process-tree kill on timeout/abort. This is the boundary the model cannot
 * fake — the extension executes the command and reads the exit code, so
 * completion reflects reality, not a claim.
 *
 * Deliberately NOT routed through pi's local bash backend (unlike superbash):
 * that backend's grace-based wait reports the *shell's* exit while background
 * work still runs, and a verify that backgrounds its check (`gate.sh &`) would
 * then pass the completion gate on a shell exit alone — a trust-boundary
 * bypass. Here the wait is close-based (a pipe-holding descendant holds the
 * verdict open until the timeout), and after the shell exits the process group
 * is probed: live leftover members mean the check backgrounded work — they are
 * killed on any exit, and on a clean exit 0 the result is a failure, never a
 * pass (the check has not finished).
 *
 * `signal` cuts the run short with `aborted: true`; a signal already aborted at
 * entry skips the spawn entirely. Known cut: a hard host crash mid-verify can
 * still orphan the tree (pi's detached-child tracker is not public API); the
 * session_shutdown drain covers reloads and clean exits.
 */
export function runVerify(
  command: string,
  opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS_DEFAULT;
  const cwd = opts.cwd ?? process.cwd();
  const outer = opts.signal;
  // A controller of our own chains the run's signal and session_shutdown into
  // one kill switch — aborting it kills the tree and settles `aborted`.
  const ctrl = new AbortController();
  const abortNow = () => ctrl.abort();
  if (outer?.aborted) ctrl.abort();
  outer?.addEventListener("abort", abortNow, { once: true });
  liveCheckAborts.add(abortNow);
  const cleanup = () => {
    outer?.removeEventListener("abort", abortNow);
    liveCheckAborts.delete(abortNow);
  };
  return new Promise<VerifyResult>((resolve) => {
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let exitedAt: number | undefined;
    const cap = () => capVerifyOutput(out);
    const onData = (d: Buffer) => {
      if (out.length < MAX_VERIFY_OUTPUT * 4) out += d.toString();
    };
    // Detached (own process group) so a negative-pid kill reaches the shell's
    // descendants too; killing only the shell orphans grandchildren. Windows
    // has no group kill — the fallback degrades to the shell alone (these
    // verifies are bash-isms on a *nix host).
    const killGroup = () => {
      if (child?.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    };
    const finish = (r: VerifyResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    const onAbort = () => {
      killGroup();
      finish({ ok: false, exitCode: null, timedOut: false, aborted: true, output: cap() });
    };
    if (ctrl.signal.aborted) {
      onAbort();
      return;
    }
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn(command, { shell: true, cwd, detached: true, windowsHide: true });
    } catch (e) {
      finish({
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnError: e instanceof Error ? e.message : String(e),
        output: "",
      });
      return;
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    timer = setTimeout(() => {
      killGroup();
      finish({ ok: false, exitCode: null, timedOut: true, output: cap() });
    }, timeoutMs);
    child.on("error", (e) => {
      finish({ ok: false, exitCode: null, timedOut: false, spawnError: e.message, output: cap() });
    });
    child.on("exit", () => {
      exitedAt = Date.now();
    });
    child.on("close", (code) => {
      // Trust boundary: the shell's exit alone is not the verdict. Two shapes
      // mean the check backgrounded its work: (a) group members still alive at
      // close (redirected descendants), (b) close arriving materially after
      // exit — a descendant with inherited stdio held the pipes open, and the
      // work's outcome (not the shell's) is unknowable. Either way: kill the
      // leftovers, and never let a shell exit 0 count as a pass. (A descendant
      // that escapes the group entirely — setsid, double-fork — is a documented
      // cut: undetectable without pid namespaces.)
      const heldByDescendant = exitedAt !== undefined && Date.now() - exitedAt > EXIT_TO_CLOSE_GRACE_MS;
      if (child?.pid !== undefined && (groupAlive(child.pid) || heldByDescendant)) {
        killGroup();
        if (code === 0) {
          finish({
            ok: false,
            exitCode: code,
            timedOut: false,
            spawnError:
              "verify left background processes running; a verify must run its check in the foreground and exit",
            output: cap(),
          });
          return;
        }
      }
      finish({ ok: code === 0, exitCode: code, timedOut: false, output: cap() });
    });
  });
}
