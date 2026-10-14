/** What the user sees: one-line tool-call rows for `subagent`/`subagents`
 * (name + task summary / count + agent names) and the result row (running
 * status, done/failed summary, backgrounded notice, expanded preview). */

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { summarizeTask } from "./child";

const MAX_RENDERED_NAMES = 4;

/** One-line display for a `subagent` tool call: the agent's name and task. */
export function renderSubagentCall(agentName: string, task: string, theme: Pick<Theme, "fg" | "bold">): string {
  let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName);
  const summary = summarizeTask(task);
  if (summary) text += theme.fg("dim", ` — ${summary}`);
  return text;
}

/** One-line display for a `subagents` batch call: the count and agent names. */
export function renderSubagentsCall(agentNames: string[], theme: Pick<Theme, "fg" | "bold">): string {
  const shown =
    agentNames.slice(0, MAX_RENDERED_NAMES).join(", ") + (agentNames.length > MAX_RENDERED_NAMES ? ", ..." : "");
  let text = theme.fg("toolTitle", theme.bold(agentNames.length ? `subagents (${agentNames.length})` : "subagents"));
  if (shown) text += theme.fg("accent", ` ${shown}`);
  return text;
}

const RESULT_PREVIEW_LINES = 15;

/** Truncate one output line, preserving internal whitespace. */
function truncateLine(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

function firstNonEmptyLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? "";
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i];
  }
  return "";
}

/** Result-row display for both subagent tools: a status line while running
 * (with the streamed tail), a summary when done, and an optional preview of
 * the full reply when expanded. */
export function renderSubagentResult(
  text: string,
  details: unknown,
  opts: { isPartial: boolean; expanded: boolean; isError: boolean },
  theme: Pick<Theme, "fg">,
): string {
  const d = details as { agent?: string; count?: number; backgrounded?: boolean | number } | undefined;
  if (opts.isPartial) {
    const status = theme.fg("warning", `running${d?.agent ? ` (${d.agent})` : ""}...`);
    const tail = lastNonEmptyLine(text);
    return tail ? `${status}\n${theme.fg("dim", truncateLine(tail, 100))}` : status;
  }
  const batch = typeof d?.count === "number";
  // Backgrounded: the tool call's job is done even though the child's isn't.
  if (!batch && d?.backgrounded) {
    let out = theme.fg("warning", `backgrounded${d.agent ? ` (${d.agent})` : ""}`);
    const summary = firstNonEmptyLine(text);
    if (summary) out += theme.fg("dim", ` — ${truncateLine(summary, 100)}`);
    return out;
  }
  const bgCount = typeof d?.backgrounded === "number" ? d.backgrounded : 0;
  const label = opts.isError
    ? `failed${d?.agent ? ` (${d.agent})` : ""}`
    : batch
      ? `done (${d.count} subagents${bgCount ? `, ${bgCount} backgrounded` : ""})`
      : `done${d?.agent ? ` (${d.agent})` : ""}`;
  let out = theme.fg(opts.isError ? "error" : "success", label);
  const summary = firstNonEmptyLine(text);
  if (!batch && summary && summary !== "(no output)") {
    out += theme.fg("dim", ` — ${truncateLine(summary, 100)}`);
  }
  if (opts.expanded) {
    const lines = text.split("\n");
    const shown = lines.slice(0, RESULT_PREVIEW_LINES);
    out += `\n${shown.map((l) => theme.fg("dim", l)).join("\n")}`;
    const remaining = lines.length - shown.length;
    if (remaining > 0) out += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
  }
  return out;
}

/** Reuse the prior render component when available (pi renderer idiom). */
export function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}
