/**
 * Background task core — the minimal registry behind non-blocking subagents.
 *
 * Design (the deliberate cut of a larger plan):
 * - a subagent child that outlives its adoption threshold keeps running while
 *   the parent turn moves on; when it settles, one wake message delivers the
 *   result as a followUp user message — a real transcript entry, so recall can
 *   find it again after compaction (no status tool, no polling, no bg tool)
 * - the registry is in-memory and session-scoped: pi reloads and exits run
 *   session_shutdown, which kills running children — an orphaned child burns
 *   API tokens with nobody consuming the result, so nothing outlives the
 *   session (the existing PI_SUBAGENT_TIMEOUT_MS hard kill still applies while
 *   running in the background)
 * - fire-once completion: a killed task never wakes, a completed task wakes
 *   exactly once (no notification storms)
 * - full replies over the wake cap are stashed beside the session at
 *   <sessionDir>/bg/<id>.txt with a pointer in the wake (the overflow pattern);
 *   with no session dir the text is hard-capped and says so
 * - PI_BG_WAKE=0 disables wake messages; the terminal notification still fires
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Chars of a child's reply that ride inline in the wake message. */
export const WAKE_TEXT_CAP = 4_000;

export interface BgTask {
  id: string;
  name: string;
  kind: "subagent";
  state: "running" | "done" | "failed" | "killed";
  startedAt: number;
  endedAt?: number;
}

/** The handle runChild hands over at adoption: the child's eventual outcome, plus a kill switch. */
export interface AdoptedHandle<T = { text: string; usage?: unknown }> {
  completion: Promise<T>;
  kill: () => void;
  /** Child spawn time (ms epoch), so wakes can report total runtime, not just background time. */
  startedAt: number;
}

export interface BackgroundDeps {
  /** Wake channel — receives the followUp user message text. */
  sendUserMessage?: (text: string) => void;
  /** Terminal notification channel (ctx.ui.notify); optional for headless modes. */
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  /** Footer status channel (ctx.ui.setStatus); optional for headless modes. */
  setStatus?: (key: string, text: string | undefined) => void;
  /** PI_BG_WAKE=0 — suppress wake messages, keep notifications. */
  wakeEnabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface BackgroundRegistry {
  /** Register a running task; returns its id (bg-1, bg-2, …). */
  adopt(record: { name: string; kind: "subagent"; kill: () => void }): string;
  /** Record the outcome and deliver the wake exactly once; a no-op for unknown or non-running tasks. */
  complete(id: string, wake: { ok: boolean; text: string }): void;
  /** Tasks still running, oldest first. */
  running(): BgTask[];
  /** Kill every running task and mark it killed — no wakes fire for killed tasks. Returns how many were killed. */
  killAll(): number;
}

/** Millis before a subagent child is adopted into the background. */
export const DEFAULT_BG_AFTER_MS = 120_000;

export function parseBgAfterMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.PI_SUBAGENT_BG_AFTER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BG_AFTER_MS;
}

const WAKE_OFF = new Set(["0", "false", "no", "off"]);

/** Wake delivery defaults to on; only an explicit falsy value disables it. */
export function parseWakeEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.PI_BG_WAKE?.trim().toLowerCase();
  return raw === undefined || raw === "" ? true : !WAKE_OFF.has(raw);
}

/** Stash file for an adopted task's full reply, next to the session so it survives resume. */
export function stashPath(sessionDir: string, id: string): string {
  return join(sessionDir, "bg", `${id}.txt`);
}

/** Cap a reply for the wake message; over-cap text is stashed when a session dir is available. */
export function capResultText(
  text: string,
  sessionDir: string | undefined,
  id: string,
  cap: number = WAKE_TEXT_CAP,
): { text: string; resultPath?: string } {
  if (text.length <= cap) return { text };
  if (!sessionDir) {
    return { text: `${text.slice(0, cap)}\n[… truncated — no session dir to stash the full reply …]` };
  }
  const resultPath = stashPath(sessionDir, id);
  try {
    mkdirSync(join(sessionDir, "bg"), { recursive: true });
    writeFileSync(resultPath, text);
  } catch {
    return { text: `${text.slice(0, cap)}\n[… truncated — stashing the full reply failed …]` };
  }
  return { text: `${text.slice(0, cap)}\n[… truncated — full reply: ${resultPath} …]`, resultPath };
}

/** Compact duration for wake headers: 4m12s, 38s. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m${s % 60}s`;
}

/** The wake message for a completed subagent task. */
export function formatSubagentWake(
  name: string,
  id: string,
  opts: { ok: boolean; durationMs: number; text: string; usageLine?: string },
): string {
  const header = `[background] subagent "${name}" (${id}, ${formatDuration(opts.durationMs)}) ${
    opts.ok ? "completed" : "failed"
  }${opts.usageLine ? ` — ${opts.usageLine}` : ""}:`;
  const body = opts.text ? `\n${opts.text}` : "";
  return `${header}${body}`;
}

/** Create a session-scoped registry. Pure over its injected channels. */
export function createBackgroundRegistry(deps: BackgroundDeps = {}): BackgroundRegistry {
  const now = deps.now ?? Date.now;
  const tasks = new Map<string, BgTask & { kill: () => void }>();
  let counter = 0;

  const refreshStatus = () => {
    const n = [...tasks.values()].filter((t) => t.state === "running").length;
    deps.setStatus?.("bg", n > 0 ? `${n} running` : undefined);
  };

  return {
    adopt(record) {
      const id = `bg-${++counter}`;
      tasks.set(id, {
        id,
        name: record.name,
        kind: record.kind,
        state: "running",
        startedAt: now(),
        kill: record.kill,
      });
      refreshStatus();
      return id;
    },
    complete(id, wake) {
      const task = tasks.get(id);
      if (!task || task.state !== "running") return; // fire-once; killed tasks never wake
      task.state = wake.ok ? "done" : "failed";
      task.endedAt = now();
      refreshStatus();
      if (deps.wakeEnabled !== false) deps.sendUserMessage?.(wake.text);
      deps.notify?.(wake.text.split("\n")[0], wake.ok ? "info" : "error");
    },
    running() {
      return [...tasks.values()]
        .filter((t) => t.state === "running")
        .map(({ kill: _kill, ...rest }) => rest)
        .sort((a, b) => a.startedAt - b.startedAt);
    },
    killAll() {
      let killed = 0;
      for (const task of tasks.values()) {
        if (task.state !== "running") continue;
        task.state = "killed"; // set first: the child's close event must find a non-running task
        task.endedAt = now();
        killed++;
        try {
          task.kill();
        } catch {
          // a failed kill on shutdown is reported by the process exit, not here
        }
      }
      refreshStatus();
      return killed;
    },
  };
}
