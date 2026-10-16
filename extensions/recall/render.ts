/** What the user sees: the collapsed/expanded recall tool rows, the read-mode
 * full-text expansion of an entry, and the one-shot reminder that rides behind
 * every compaction commit. */

import { Text } from "@earendil-works/pi-tui";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { extractEntrySections, kindLabel } from "./chunks";

const REMINDER_TYPE = "recall.reminder";
/** The reminder rides behind the compaction commit — after the kept tail,
 * before whatever the user sends next. At that position it is background
 * framing; the old "re-orient now" wording was written for a front position
 * it no longer holds, and made the model answer the note instead of the
 * user when before_agent_start injection strayed there. One calm sentence:
 * compactions repeat every ~60 turns at the glm-5.3 target, so the note's
 * two jobs — newer wins, recall exists — must fit the frequency without
 * becoming noise. */
const REMINDER_TEXT =
  "Earlier history is compacted into the summary above; newer messages take precedence. Compacted turns stay verbatim-searchable via `recall` if detail is needed.";

export function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Collapsed call row: `recall — description…`. */
export function renderRecallCall(
  args: { description?: unknown; queries?: unknown; mode?: unknown; id?: unknown },
  theme: Pick<Theme, "fg" | "bold">,
): string {
  if (args?.mode === "read" || (!args?.description && !args?.queries && args?.id))
    return theme.fg("toolTitle", theme.bold("recall read"));
  const d = typeof args?.description === "string" ? args.description.trim() : "";
  const qs = Array.isArray(args?.queries)
    ? (args.queries as unknown[]).filter((q): q is string => typeof q === "string")
    : [];
  const shown = d !== "" ? d : qs.join(" · ");
  return theme.fg("toolTitle", theme.bold("recall ")) + theme.fg("dim", clip(shown, 60));
}

/** Result row: `n hits` collapsed; hit lines when expanded. */
export function renderRecallResult(
  details: { hits?: Array<{ snippet: string }>; read?: { total: number } } | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg">,
): string {
  if (details?.read) return theme.fg("muted", `read · ${details.read.total.toLocaleString()} chars`);
  const hits = details?.hits ?? [];
  if (hits.length === 0) return theme.fg("dim", "no matches");
  let text = theme.fg("muted", `${hits.length} hit${hits.length === 1 ? "" : "s"}`);
  if (options.expanded) {
    const lines = hits.map((h) => `  ${theme.fg("dim", clip(h.snippet.replace(/\s+/g, " "), 88))}`);
    text += `\n${lines.join("\n")}`;
  }
  return text;
}

export interface RecallDetails {
  mode: "search" | "read";
  scope: "session" | "project";
  hits?: Array<{ ref: string; kind: string; session: string; score: number; snippet: string }>;
  read?: { ref: string; total: number };
}

/** Full text of one entry for read mode (all sections, unchunked). */
export function entryFullText(entry: SessionEntry): string {
  return extractEntrySections(entry)
    .map((s) =>
      s.kind === "toolCall" || s.kind === "toolResult" ? `[${kindLabel(s.kind, s.label)}]\n${s.text}` : s.text,
    )
    .join("\n\n");
}

export function reminderMessage(): { customType: string; content: string; display: boolean } {
  return {
    customType: REMINDER_TYPE,
    content: REMINDER_TEXT,
    display: false,
  };
}
