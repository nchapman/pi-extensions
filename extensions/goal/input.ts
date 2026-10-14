/** Raw terminal-input observation: the alt+x kill key for an in-flight check
 * and the listener that feeds it. Terminal boundary only — no rendering. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Key that kills the settle-path check (see the settle handler). Chosen so
 * no ordinary gesture produces it: pi binds a bare Esc to app.interrupt (and
 * its editor has a double-Esc action), popup dismissals emit Esc, and plain
 * keys type into the editor — but alt+x is bound by nothing in pi's defaults
 * and is never an editing gesture, so observing it is attribution enough. */
export const GOAL_KILL_KEY = "alt+x";

/**
 * Best-effort raw-input hook for the settle boundary, where pi exposes no
 * abort signal (agent.signal is cleared before agent_before_settle fires, and
 * session.abort() then blocks in waitForIdle until the handler returns — so
 * an unkillable multi-minute verify here wedges Esc too). Forwards every key
 * to `onInput` for the check's duration only; the caller applies pi-tui's
 * own key semantics (matchesKey), so a bare Esc stays distinguishable from
 * arrow keys ("\x1b[A" → "up") and Alt-combos, and non-Esc input can break
 * a pending key pair. Observe-only — the handler returns undefined, so pi's
 * key handling (including run abort) still sees the key. A no-op when there
 * is no interactive UI.
 */
export function listenForTerminalInput(
  ui: Pick<ExtensionContext["ui"], "onTerminalInput"> | undefined,
  onInput: (data: string) => void,
): () => void {
  if (!ui || typeof ui.onTerminalInput !== "function") return () => {};
  const unsubscribe = ui.onTerminalInput((data) => {
    onInput(data);
    return undefined; // observe only — pi's own key handling still runs
  });
  return () => unsubscribe();
}
