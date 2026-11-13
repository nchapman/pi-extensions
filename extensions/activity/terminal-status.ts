/**
 * Compatibility adapter for Pi 1.5.2's public Terminal.setProgramStatus seam.
 * Pi has no activity/status middleware yet. Decorate the setter rather than emit
 * a second OSC: even a momentary native `done` can satisfy an external waiter.
 * Pi still owns encoding, capability negotiation, blocked/error/clear semantics,
 * and its cached status for replay. No private fields or stdout interception.
 *
 * A last-release grace bridges ordinary sendUserMessage microtasks. Its void API
 * offers no acceptance acknowledgment: a slow input hook (>100 ms) can still leave
 * a gap. Bounded grace is preferable to remaining busy forever on a rejected wake.
 */
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import type { ActivitySource } from "../../lib/activity";

export const RELEASE_GRACE_MS = 100;
export type StatusTerminal = Pick<Terminal, "setProgramStatus">;

/** Retain the unmodified report across /reload, including an idle error/blocked state. */
const CACHE = Symbol.for("pi-extensions.activity.native-status.v1");
function nativeStatuses(): WeakMap<StatusTerminal, ProgramStatus> {
  const globals = globalThis as Record<symbol, WeakMap<StatusTerminal, ProgramStatus> | undefined>;
  return (globals[CACHE] ??= new WeakMap());
}

export function attachProgramStatus(
  terminal: StatusTerminal,
  activity: ActivitySource,
  initial: ProgramStatus,
  resume = false,
): () => void {
  const original = terminal.setProgramStatus;
  if (typeof original !== "function") return () => {};
  const cache = nativeStatuses();
  let native = (resume && cache.get(terminal)) || initial;
  let count = activity.count;
  let grace = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let last: string | undefined;
  const cancelGrace = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    grace = false;
  };
  const report = () => {
    if (!active) return;
    const status: ProgramStatus =
      (count > 0 || grace) && (native.state === "idle" || native.state === "done")
        ? { ...native, state: "working" }
        : native;
    const key = JSON.stringify(status);
    if (key === last) return;
    original.call(terminal, status);
    last = key;
  };
  const wrapper = (status: ProgramStatus) => {
    if (!active) {
      original.call(terminal, status);
      return;
    }
    native = { ...status };
    cache.set(terminal, native);
    // A new native working report takes over from a completed background job.
    // Attention/clear reports are always authoritative, even during the grace.
    if (status.state !== "idle" && status.state !== "done") cancelGrace();
    report();
  };
  terminal.setProgramStatus = wrapper;
  const unsubscribe = activity.subscribe((next) => {
    const previous = count;
    count = next;
    if (count > 0) {
      cancelGrace();
      report();
    } else if (previous > 0) {
      grace = true;
      timer = setTimeout(() => {
        timer = undefined;
        grace = false;
        report();
      }, RELEASE_GRACE_MS);
      timer.unref?.();
    }
    // With no holds, wait for Pi: don't overwrite a pre-existing native report
    // merely because the extension was just installed into an idle session.
  });
  return () => {
    active = false;
    cancelGrace();
    unsubscribe();
    // Do not clobber a newer decorator. If retained in its chain, ours is inert.
    if (terminal.setProgramStatus === wrapper) terminal.setProgramStatus = original;
  };
}
