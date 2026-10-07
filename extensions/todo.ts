/**
 * Todo extension — whole-list task tracking with branch-safe state.
 *
 * Design (mirrors Claude Code's TodoWrite / Codex's update_plan):
 * - One `todo` tool; every call sends the FULL list and replaces the old one
 * - Statuses: pending | in_progress | completed | cancelled, at most one
 *   in_progress — structurally invalid lists are rejected with the current
 *   state so the model self-corrects in one retry
 * - Updates that drop unfinished items are accepted with a note naming them:
 *   deliberate restructuring (reword, split, abandon) stays friction-free
 *   while accidental drops remain visible
 * - State is persisted as `todo.state` custom entries via pi.appendEntry on
 *   every successful write (the shared branch-state pattern from lib/branchstate:
 *   same mechanism pi's codemode store uses) and reconstructed on
 *   session_start/session_tree by scanning the branch — durable, invisible to
 *   the model, correct across reload/rewind/resume. Tool-result `details` are
 *   render-only
 * - One-shot reminders on before_agent_start when the plan is unfinished and
 *   stale (or compaction wiped it — summaries never carry the plan: recall
 *   re-injects it as a tail message after mid-run drafts, and this reminder
 *   covers every other compaction). Wake-driven starts (background task
 *   completions and check-ins from superbash) don't count toward staleness:
 *   the plan is blocked on the very task the wake reports, and counting them
 *   churned reminders during long waits
 * - /todos renders the list full-screen in the TUI
 */

import { isWakeMessage } from "../lib/superbash";
import { scanCustomState } from "../lib/branchstate";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export const TODO_TOOL_NAME = "todo";
export const REMINDER_MIN_TURNS = 4;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Snapshot carried by every todo tool result — render-only; durable state
 * lives in todo.state branch entries (see TODO_STATE_TYPE). */
export interface TodoDetails {
  todos: TodoItem[];
  error?: string;
  /** What this call changed — the news for the collapsed result row. */
  changes?: TodoChanges;
}

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

const MAX_TODOS = 50;

/** Shape guard shared by streamed arguments and replayed snapshots. */
function isTodoItem(t: unknown): t is TodoItem {
  const item = t as { content?: unknown; status?: unknown } | null;
  return (
    typeof item?.content === "string" &&
    item.content.trim() !== "" &&
    typeof item.status === "string" &&
    TODO_STATUSES.includes(item.status as TodoStatus)
  );
}

/** Model-facing ASCII markers (UI uses theme-colored glyphs instead). */
const PLAIN_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[-]",
};

const TodoParams = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Short imperative task description" }),
      status: Type.Union(
        TODO_STATUSES.map((s) => Type.Literal(s)),
        {
          description: "At most one item may be in_progress",
        },
      ),
    }),
    { description: "The full list; replaces the previous list entirely" },
  ),
});

/**
 * Validate a submitted list. Returns the trimmed list, or an error naming the
 * first problem so the model can retry with a corrected list.
 */
export function validateTodoList(input: unknown): { todos: TodoItem[]; error?: string } {
  if (!Array.isArray(input)) return { todos: [], error: "todos must be an array" };
  const todos: TodoItem[] = [];
  for (const [i, raw] of input.entries()) {
    const item = raw as { content?: unknown; status?: unknown } | null;
    if (typeof item?.content !== "string" || item.content.trim() === "") {
      return { todos: [], error: `todos[${i}].content must be a non-empty string` };
    }
    if (typeof item.status !== "string" || !TODO_STATUSES.includes(item.status as TodoStatus)) {
      return { todos: [], error: `todos[${i}].status must be one of: ${TODO_STATUSES.join(", ")}` };
    }
    todos.push({ content: item.content.trim(), status: item.status as TodoStatus });
  }
  const active = todos.filter((t) => t.status === "in_progress");
  if (active.length > 1) {
    return {
      todos: [],
      error: `at most one todo may be in_progress (found ${active.length}); finish or cancel items before starting new ones`,
    };
  }
  if (todos.length > MAX_TODOS) {
    return {
      todos: [],
      error: `at most ${MAX_TODOS} todos (got ${todos.length}); mark stale items cancelled, then replace resolved items`,
    };
  }
  const contents = new Set(todos.map((t) => t.content));
  if (contents.size < todos.length) {
    return { todos: [], error: "duplicate item content; items must be unique" };
  }
  return { todos };
}

export interface TodoProgress {
  resolved: number;
  total: number;
  active?: TodoItem;
}

export function summarizeTodos(todos: TodoItem[]): TodoProgress {
  return {
    resolved: todos.filter((t) => t.status === "completed" || t.status === "cancelled").length,
    total: todos.length,
    active: todos.find((t) => t.status === "in_progress"),
  };
}

/**
 * Unfinished items from `previous` that vanish from `next`. Whole-list rewrite
 * makes silent drift possible; naming these drops in the result keeps them
 * visible without blocking deliberate restructuring. Resolved items may drop
 * freely.
 */
export function droppedUnfinishedItems(previous: TodoItem[], next: TodoItem[]): TodoItem[] {
  const kept = new Set(next.map((t) => t.content));
  return previous.filter((t) => (t.status === "pending" || t.status === "in_progress") && !kept.has(t.content));
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Plain-text checklist for tool results (the model reads content, not details). */
export function renderPlainList(todos: TodoItem[]): string {
  const p = summarizeTodos(todos);
  const header = `${p.resolved}/${p.total} resolved`;
  return [header, ...todos.map((t) => ` ${PLAIN_MARKERS[t.status]} ${t.content}`)].join("\n");
}

/** Reminder injected as a one-shot custom message when the plan goes stale. */
export function renderReminder(todos: TodoItem[]): string {
  const p = summarizeTodos(todos);
  const lines = [
    `TODO REMINDER — current plan (${p.resolved}/${p.total} resolved):`,
    ...todos.map((t) => ` ${PLAIN_MARKERS[t.status]} ${t.content}`),
    "Keep statuses current: mark an item in_progress before starting it, completed or cancelled once resolved.",
  ];
  return lines.join("\n");
}

export interface ReminderState {
  unfinished: boolean;
  turnsSinceUpdate: number;
  compactedSinceUpdate: boolean;
}

/** Remind when there is unfinished work the model has neglected (or lost to compaction). */
export function shouldRemind(state: ReminderState): boolean {
  return state.unfinished && (state.compactedSinceUpdate || state.turnsSinceUpdate >= REMINDER_MIN_TURNS);
}

/** Collapsed call row: `todo 2/5 — active item`, `— next: …`, or ` ✓` when all resolved. */
export function renderTodoCall(args: { todos?: unknown }, theme: Pick<Theme, "fg" | "bold">): string {
  if (!Array.isArray(args?.todos)) return theme.fg("toolTitle", theme.bold("todo"));
  // Items stream in partially (any key order); keep only well-formed ones.
  const todos = (args.todos as unknown[]).filter(isTodoItem);
  const p = summarizeTodos(todos);
  let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("accent", `${p.resolved}/${p.total}`);
  if (p.active) text += theme.fg("dim", ` — ${clip(p.active.content, 60)}`);
  else {
    const nextItem = todos.find((t) => t.status === "pending");
    if (nextItem) text += theme.fg("dim", ` — next: ${clip(nextItem.content, 55)}`);
    else if (p.total > 0 && p.resolved === p.total) text += theme.fg("success", " ✓");
  }
  return text;
}

const GLYPHS: Record<TodoStatus, { mark: string; color: "success" | "accent" | "muted" | "dim" }> = {
  completed: { mark: "✓", color: "success" },
  in_progress: { mark: "▸", color: "accent" },
  pending: { mark: "○", color: "muted" },
  cancelled: { mark: "✗", color: "dim" },
};

/** What one todo call changed, matched by exact item text. */
export interface TodoChanges {
  completed: string[];
  started: string[];
  added: string[];
  cancelled: string[];
}

export function summarizeChanges(prev: TodoItem[], next: TodoItem[]): TodoChanges {
  const before = new Map(prev.map((t) => [t.content, t.status]));
  const changes: TodoChanges = { completed: [], started: [], added: [], cancelled: [] };
  for (const t of next) {
    const was = before.get(t.content);
    if (was === undefined) changes.added.push(t.content);
    else if (was !== "completed" && t.status === "completed") changes.completed.push(t.content);
    else if (was === "pending" && t.status === "in_progress") changes.started.push(t.content);
    else if (was !== "cancelled" && t.status === "cancelled") changes.cancelled.push(t.content);
  }
  return changes;
}

/** Names for one change category: `max` quoted names, then +N. When several
 * categories fire in one call, callers pass max=1 so the collapsed row stays
 * close to one line — expand is the dump view. */
function clipNames(names: string[], max: number): string {
  const shown = names
    .slice(0, max)
    .map((n) => `"${clip(n, 40)}"`)
    .join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}

/** Result row: progress counts, then what changed; full checklist when expanded. */
export function renderTodoResult(
  details: TodoDetails | undefined,
  options: { expanded: boolean },
  theme: Pick<Theme, "fg">,
): string {
  if (details?.error) return theme.fg("error", `✗ ${details.error}`);
  const todos = details?.todos ?? [];
  const p = summarizeTodos(todos);
  if (todos.length === 0) return theme.fg("dim", "no todos");

  const allDone = p.resolved === p.total;
  const ch = details?.changes;
  const fired = [ch?.completed, ch?.started, ch?.added, ch?.cancelled].filter((c) => c !== undefined && c.length > 0);
  const max = fired.length > 1 ? 1 : 2;
  const parts: string[] = [];
  if (ch?.completed.length) parts.push(theme.fg("success", `✓ ${clipNames(ch.completed, max)}`));
  if (ch?.started.length) parts.push(theme.fg("accent", `▸ ${clipNames(ch.started, max)}`));
  if (ch?.added.length) parts.push(theme.fg("muted", `+ ${clipNames(ch.added, max)}`));
  if (ch?.cancelled.length) parts.push(theme.fg("dim", `✗ ${clipNames(ch.cancelled, max)}`));
  if (parts.length === 0 && p.active) parts.push(theme.fg("accent", `▸ ${clip(p.active.content, 60)}`));
  if (allDone) parts.push(theme.fg("dim", "all resolved"));

  let text = theme.fg(allDone ? "success" : "muted", `${p.resolved}/${p.total}`);
  if (parts.length > 0) text += ` ${parts.join(theme.fg("dim", " · "))}`;
  if (options.expanded) {
    const list = todos
      .map((t) => {
        const g = GLYPHS[t.status];
        const content = t.status === "in_progress" ? theme.fg("text", t.content) : theme.fg("dim", clip(t.content, 72));
        return `  ${theme.fg(g.color, g.mark)} ${content}`;
      })
      .join("\n");
    text += `\n${list}`;
  }
  return text;
}

/** Reuse the prior render component when available (pi renderer idiom). */
function reuseText(context: { lastComponent?: unknown } | undefined): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

/** Full-screen checklist shown by /todos. */
class TodoListComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private todos: TodoItem[],
    private theme: Pick<Theme, "fg">,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    const lines: string[] = [""];

    const title = th.fg("accent", " Todos ");
    const header =
      th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(header, width), "");

    if (this.todos.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
    } else {
      const p = summarizeTodos(this.todos);
      lines.push(truncateToWidth(`  ${th.fg("muted", `${p.resolved}/${p.total} resolved`)}`, width), "");
      for (const t of this.todos) {
        const g = GLYPHS[t.status];
        const content = t.status === "in_progress" ? th.fg("text", t.content) : th.fg("dim", t.content);
        lines.push(truncateToWidth(`  ${th.fg(g.color, g.mark)} ${content}`, width));
      }
    }

    lines.push("", truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  // Required by pi's Component interface; the width-keyed render cache makes
  // this a no-op for width changes, but pi may call it for other reasons.
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** customType of the durable todo-state entries (pi.appendEntry): the single
 * source of truth for the list across reload/rewind/resume. */
export const TODO_STATE_TYPE = "todo.state";

interface TodoStateData {
  todos: TodoItem[];
}

function isTodoStateData(d: unknown): d is TodoStateData {
  const data = d as Partial<TodoStateData> | null;
  return !!data && typeof data === "object" && Array.isArray(data.todos);
}

/** Loose entry shape so the scan accepts both SessionEntry[] and test doubles. */
type TodoBranchEntry = {
  type?: string;
  customType?: unknown;
  data?: unknown;
  // Branches mix entry kinds (messages, compactions); the scan only reads the
  // fields above — `message` keeps foreign entries type-compatible in tests.
  message?: unknown;
};

/** Newest todo list recorded on the session branch (todo.state entries carry the state). */
export function lastTodoSnapshot(branch: TodoBranchEntry[]): TodoItem[] {
  const data = scanCustomState(branch, TODO_STATE_TYPE, isTodoStateData).data;
  // Filter in place — a malformed item inside a valid-shaped entry must not
  // surface as a phantom task (recall renders this list verbatim).
  return data ? data.todos.filter(isTodoItem) : [];
}

/** Title of the plan block in recall's post-compaction plan message. */
export const PLAN_SECTION_HEADER = "## Current Plan";

/** customType of the message recall chains after a mid-run draft compaction to carry the plan at the context tail. */
export const PLAN_MESSAGE_TYPE = "todo.plan";

/** customType of this extension's one-shot staleness/compaction reminder message. */
export const TODO_REMINDER_TYPE = "todo.reminder";

/** Message types that carry the plan across a compaction — a resume scan treats any of them as "not hidden". */
const PLAN_CARRIERS = new Set([PLAN_MESSAGE_TYPE, TODO_REMINDER_TYPE]);

/**
 * Adopt the last todo snapshot recorded on the session branch. Tool results
 * always carry the full list, so the last one on the branch is the state.
 * Also reports whether a compaction that hides the plan follows that snapshot
 * — a plan message after the compaction (recall's mid-run draft carrier)
 * means it was not hidden.
 */
function reconstructFromSession(ctx: ExtensionContext): { todos: TodoItem[]; planHiddenByCompaction: boolean } {
  const branch = ctx.sessionManager.getBranch() as TodoBranchEntry[];
  const { data, index: lastIndex } = scanCustomState(branch, TODO_STATE_TYPE, isTodoStateData);
  // Filter in place — a malformed item inside a valid-shaped entry must not
  // resurrect as a phantom task.
  const todos = data ? data.todos.filter(isTodoItem) : [];
  // Only the newest compaction after the snapshot decides: a later one folds
  // the earlier and is what the context actually shows.
  let lastCompactionIndex = -1;
  for (let i = branch.length - 1; i > lastIndex; i--) {
    if (branch[i].type === "compaction") {
      lastCompactionIndex = i;
      break;
    }
  }
  const planHiddenByCompaction =
    todos.length > 0 &&
    lastCompactionIndex !== -1 &&
    !branch
      .slice(lastCompactionIndex + 1)
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          typeof entry.customType === "string" &&
          PLAN_CARRIERS.has(entry.customType),
      );
  return { todos, planHiddenByCompaction };
}

export function registerTodoTool(pi: ExtensionAPI): void {
  let todos: TodoItem[] = [];
  let turnsSinceUpdate = 0;
  let compactedSinceUpdate = false;

  const adoptBranchState = (ctx: ExtensionContext) => {
    const state = reconstructFromSession(ctx);
    todos = state.todos;
    compactedSinceUpdate = state.planHiddenByCompaction;
  };

  pi.on("session_start", (_event, ctx) => {
    adoptBranchState(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    adoptBranchState(ctx);
  });
  pi.on("session_compact", () => {
    // Summaries never carry the plan, so every compaction re-arms the reminder
    // and the list is re-injected at the next run start. Mid-run draft
    // compactions fire no session_compact — recall chains a plan message
    // after them instead, and the resume scan above recognizes that carrier.
    compactedSinceUpdate = true;
  });

  pi.on("before_agent_start", (event) => {
    // Wake-driven runs are machine starts, not agent work: the plan is
    // typically blocked on the very task the wake reports. Freezing (not
    // resetting) the counter keeps genuine neglect detectable on the next
    // agent-driven turn, while a compaction below still reminds on a wake —
    // the plan vanished there and the model needs it back to act on the wake.
    if (!isWakeMessage(event.prompt)) turnsSinceUpdate++;
    const p = summarizeTodos(todos);
    if (!shouldRemind({ unfinished: p.resolved < p.total, turnsSinceUpdate, compactedSinceUpdate })) return;
    // Consume the trigger so the reminder fires once, not every turn.
    turnsSinceUpdate = 0;
    compactedSinceUpdate = false;
    return {
      message: {
        customType: TODO_REMINDER_TYPE,
        content: renderReminder(todos),
        display: false,
      },
    };
  });

  pi.registerTool({
    name: TODO_TOOL_NAME,
    label: "Todo",
    description:
      "Record a plan that must outlive the context window. Use for work that will span many tool calls or a likely compaction (multi-file changes, long test/fix loops, migrations), or when the user asks for a plan or visible progress. Skip it when a few tool calls and thinking suffice — do not use it to organize your own thoughts. Send the FULL list on every call (it replaces the previous list); update when items resolve, batching several changes per call; at most one item may be in_progress. Items match by exact text; if an update drops unfinished items, the result names them — re-add if unintended, otherwise ignore the note (that was a reword, split, or abandonment).",
    parameters: TodoParams,
    async execute(_id, params) {
      const { todos: next, error } = validateTodoList(params.todos);
      if (error) {
        const current = todos.length > 0 ? renderPlainList(todos) : "(no todos)";
        return {
          content: [{ type: "text", text: `Error: ${error}\nCurrent list:\n${current}` }],
          details: { todos: [...todos], error } as TodoDetails,
        };
      }
      const dropped = droppedUnfinishedItems(todos, next);
      const changes = summarizeChanges(todos, next);
      todos = next;
      // Durable state: the branch entry is the single source of truth across
      // reload/rewind/resume; the tool-result details below are render-only.
      pi.appendEntry(TODO_STATE_TYPE, { todos: todos.map((t) => ({ ...t })) });
      turnsSinceUpdate = 0;
      compactedSinceUpdate = false;
      const note =
        dropped.length > 0
          ? `Note: dropped unfinished item(s): ${dropped.map((t) => `"${t.content}"`).join(", ")}. Re-add them if unintended; otherwise ignore this note.\n`
          : "";
      return {
        content: [{ type: "text", text: note + renderPlainList(todos) }],
        details: { todos: [...todos], changes } as TodoDetails,
      };
    },
    renderCall(args, theme, context) {
      // Arguments stream in partially; tolerate a missing todos array.
      const text = reuseText(context);
      text.setText(renderTodoCall((args ?? {}) as { todos?: unknown }, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      const text = reuseText(context);
      text.setText(renderTodoResult(result.details as TodoDetails | undefined, { expanded: options.expanded }, theme));
      return text;
    },
  });

  pi.registerCommand("todos", {
    description: "Show the current task list",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoListComponent(todos, theme, () => done());
      });
    },
  });
}

export default registerTodoTool;
