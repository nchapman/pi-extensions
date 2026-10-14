/** Everything the user sees: footer status, check spinner, transcript rows
 * for goal.check messages and tool calls/results, and the /goal status
 * component. Behavior stays independent of rendering (non-TUI modes). */

import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Goal, GoalDetails, GoalStatus } from "./state";
import { effectiveCriteria } from "./completion";
import { clip, formatElapsed } from "./format";

/** Structured summary of one turn-end check, carried in the goal.check custom
 * message `details` (not sent to the model) so the transcript renderer can show
 * a compact row without parsing the prompt. */
export interface GoalCheckDetails {
  continuation: number;
  max: number;
  ok: boolean;
  /** True when the check was cut short (Esc / run abort) — no measurement. */
  aborted?: boolean;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  staleContinuations: number;
  output: string;
  /** Milestone-judge label when this check came from the judge, not a verify
   * command — the renderer words the outcome from it instead of exit codes. */
  judge?: "working" | "complete" | "blocked" | "unavailable";
  /** Settle-triage outcome: the verify was skipped ("continue" — judge saw
   * mid-work) or the triage itself was aborted before deciding. */
  triage?: "continue" | "aborted";
}

/** Footer status line: `goal · <elapsed>` — presence + time only, no emoji (the
 * footer is plain text throughout). The objective lives in the /goal view and
 * the turn-end prompt; the footer is an ambient indicator and stays short so
 * other footer segments keep their room. */
export function renderGoalFooter(spendMs: number): string {
  return `goal · ${formatElapsed(spendMs)}`;
}

/** Widget key for the animated goal-check spinner shown above the editor. */
export const GOAL_CHECK_WIDGET_KEY = "goal-check";
const CHECK_SPINNER_FRAMES = ["|", "/", "-", "\\"];
const CHECK_SPINNER_INTERVAL_MS = 120;

/**
 * Animated "running goal check" row shown above the editor while the
 * settle-boundary verify runs. pi clears its own working spinner on agent_end
 * (before settle), so a slow verify would otherwise render as a dead pause —
 * this widget keeps an explicit, self-animating indicator in the chat area for
 * exactly the duration of the check.
 */
export class CheckSpinnerComponent {
  private frame = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private tui: { requestRender(): void },
    private theme: Pick<Theme, "fg">,
    private label: string,
  ) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % CHECK_SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, CHECK_SPINNER_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {
    // Width-keyed rendering isn't cached; the timer drives frame changes.
  }

  render(width: number): string[] {
    const frame = this.theme.fg("accent", CHECK_SPINNER_FRAMES[this.frame]!);
    return [truncateToWidth(` ${frame} ${this.label}`, width)];
  }
}

/** Transcript row for a goal.check message: the loop's visible heartbeat —
 * which continuation ran, what the verify said, what happens next. Registered
 * via registerMessageRenderer so the model still receives the full prompt while
 * the user sees one compact line. */
export function renderCheckMessage(
  details: GoalCheckDetails | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg">,
): string {
  if (!details) return theme.fg("dim", "goal check");
  let outcome: string;
  if (details.aborted) {
    // Aborted first: an aborted row must not read as a verify abort.
    outcome = details.triage
      ? theme.fg("muted", "triage aborted — re-triaging next settle")
      : details.judge
        ? theme.fg("muted", "milestone judge aborted — re-assessing next settle")
        : theme.fg("muted", "verify aborted — re-measuring next settle");
  } else if (details.triage === "continue") {
    outcome = theme.fg("accent", "judge: mid-work — verify skipped, continuing");
  } else if (details.judge) {
    outcome =
      details.judge === "complete"
        ? theme.fg("success", "milestone met — agent will summarize and complete")
        : details.judge === "blocked"
          ? theme.fg("error", "judge sees an impasse — agent will confirm or refute")
          : details.judge === "working"
            ? theme.fg("accent", "judge: work remaining — continuing")
            : theme.fg("muted", "judge unavailable — generic continuation");
  } else {
    outcome = details.ok
      ? theme.fg("success", "verify passed — agent will summarize and complete")
      : theme.fg(
          "accent",
          `verify ${
            details.timedOut
              ? "timed out"
              : details.spawnError
                ? `could not run (${details.spawnError})`
                : `failed (exit ${details.exitCode ?? "?"})`
          } — continuing`,
        );
  }
  const stale =
    details.staleContinuations > 0 ? theme.fg("dim", ` · measured ${details.staleContinuations} turn(s) ago`) : "";
  const head = `${theme.fg("dim", `goal check ${details.continuation}/${details.max} · `)}${outcome}${stale}`;
  if (options.expanded && details.output.trim()) {
    return `${head}\n${details.output.trim()}`;
  }
  return head;
}

const STATUS_COLORS: Record<GoalStatus, "accent" | "muted" | "error" | "success"> = {
  active: "accent",
  paused: "muted",
  blocked: "error",
  complete: "success",
};

/** Collapsed call row: `goal <objective>`, `goal complete`, or `goal blocked`. */
export function renderGoalCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
  const a = (args ?? {}) as { action?: string; objective?: unknown };
  if (a.action === "set" && typeof a.objective === "string") {
    return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("dim", clip(a.objective, 60));
  }
  if (a.action === "complete") return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("success", "complete");
  if (a.action === "blocked") return theme.fg("toolTitle", theme.bold("goal ")) + theme.fg("error", "blocked");
  return theme.fg("toolTitle", theme.bold("goal"));
}

/** Result row: `goal #N <status> — objective`, with the criteria list when expanded.
 * A `running` detail (onUpdate partial) renders the in-flight check instead. */
export function renderGoalResult(
  details: GoalDetails | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg" | "bold">,
): string {
  if (details?.error) return theme.fg("error", `✗ ${details.error}`);
  if (details?.running) {
    const id = details.goal ? ` #${details.goal.id}` : "";
    return theme.fg("accent", `⏳ goal${id} ${details.running}`);
  }
  const goal = details?.goal;
  if (!goal) return theme.fg("dim", "no goal");
  let text = theme.fg("toolTitle", theme.bold(`goal #${goal.id} `)) + theme.fg(STATUS_COLORS[goal.status], goal.status);
  text += ` ${theme.fg("dim", clip(goal.objective, 50))}`;
  if (options.expanded) {
    const list = effectiveCriteria(goal)
      .map((c) => `  • ${theme.fg("dim", c)}`)
      .join("\n");
    text += `\n${list}`;
    if (goal.status === "blocked" && goal.blockedReason)
      text += `\n  ${theme.fg("error", `blocked: ${goal.blockedReason}`)}`;
  }
  return text;
}

/** Reuse the prior render component when available (pi renderer idiom). */
export function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

/** Full-screen status shown by /goal (no arguments). */
export class GoalStatusComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private goal: Goal | null,
    private theme: Pick<Theme, "fg" | "bold">,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [""];

    const title = th.fg("accent", " Goal ");
    const header =
      th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(header, width), "");

    if (!this.goal) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", "No active goal. Set one with /goal <objective> or the goal tool.")}`, width),
      );
    } else {
      const g = this.goal;
      lines.push(truncateToWidth(`  ${th.fg("muted", `#${g.id}`)} ${th.fg("text", g.objective)}`, width));
      lines.push(truncateToWidth(`  ${th.fg(STATUS_COLORS[g.status], g.status)}`, width));
      lines.push("");
      for (const c of effectiveCriteria(g)) lines.push(truncateToWidth(`  • ${th.fg("dim", c)}`, width));
      if (g.status === "blocked" && g.blockedReason) {
        lines.push(truncateToWidth(`  ${th.fg("error", `blocked: ${g.blockedReason}`)}`, width));
      }
    }

    lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  // Required by pi's Component interface; the width-keyed render cache makes this
  // a no-op for width changes, but pi may call it for other reasons.
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
