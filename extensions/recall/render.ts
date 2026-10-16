/** What the user sees: the collapsed/expanded recall tool rows and the
 * read-mode full-text expansion of an entry. */

import { Text } from "@earendil-works/pi-tui";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { extractEntrySections, kindLabel } from "./chunks";

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
