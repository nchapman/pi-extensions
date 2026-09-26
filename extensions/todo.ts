/**
 * Todo extension — whole-list task tracking with branch-safe state.
 *
 * Design (mirrors Claude Code's TodoWrite / Codex's update_plan):
 * - One `todo` tool; every call sends the FULL list and replaces the old one
 * - Statuses: pending | in_progress | completed | cancelled, at most one
 *   in_progress — invalid lists are rejected with the current state so the
 *   model self-corrects in one retry
 * - State snapshots ride in tool-result `details`; replaying the session
 *   branch on session_start/session_tree restores the right list for every
 *   branch, rewind, and resume (no filesystem, nothing desyncs)
 * - One-shot reminders on before_agent_start when the plan is unfinished and
 *   stale (or compaction wiped it) — the anti-drift mechanism Codex lacks
 * - /todos renders the list full-screen in the TUI
 */

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

/** Snapshot carried by every todo tool result (see reconstruct). */
export interface TodoDetails {
	todos: TodoItem[];
	error?: string;
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
			status: Type.Union(TODO_STATUSES.map((s) => Type.Literal(s)), {
				description: "At most one item may be in_progress",
			}),
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
		return { todos: [], error: `at most ${MAX_TODOS} todos (got ${todos.length}); split the work or drop stale items` };
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

/** Collapsed call row: `todo 2/5 — active item`. */
export function renderTodoCall(args: { todos?: unknown }, theme: Pick<Theme, "fg" | "bold">): string {
	if (!Array.isArray(args?.todos)) return theme.fg("toolTitle", theme.bold("todo"));
	// Items stream in partially (any key order); keep only well-formed ones.
	const todos = (args.todos as unknown[]).filter(isTodoItem);
	const p = summarizeTodos(todos);
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("accent", `${p.resolved}/${p.total}`);
	if (p.active) text += theme.fg("dim", ` — ${clip(p.active.content, 60)}`);
	return text;
}

const GLYPHS: Record<TodoStatus, { mark: string; color: "success" | "accent" | "muted" | "dim" }> = {
	completed: { mark: "✓", color: "success" },
	in_progress: { mark: "▸", color: "accent" },
	pending: { mark: "○", color: "muted" },
	cancelled: { mark: "✗", color: "dim" },
};

/** Result row: one-line progress collapsed; full checklist when expanded. */
export function renderTodoResult(
	details: TodoDetails | undefined,
	options: { expanded: boolean },
	theme: Pick<Theme, "fg">,
): string {
	if (details?.error) return theme.fg("error", `✗ ${details.error}`);
	const todos = details?.todos ?? [];
	const p = summarizeTodos(todos);
	if (todos.length === 0) return theme.fg("dim", "no todos");

	let text =
		theme.fg(p.resolved === p.total ? "success" : "muted", `${p.resolved}/${p.total}`) +
		(p.active ? theme.fg("accent", ` ▸ ${clip(p.active.content, 60)}`) : "");
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
		const header = th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
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

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Adopt the last todo snapshot recorded on the session branch. Tool results
 * always carry the full list, so the last one on the branch is the state.
 * Also reports whether a compaction entry follows that snapshot — the model's
 * context no longer contains the plan then, so a reminder is due.
 */
function reconstructFromSession(ctx: ExtensionContext): { todos: TodoItem[]; planHiddenByCompaction: boolean } {
	const branch = ctx.sessionManager.getBranch();
	let todos: TodoItem[] = [];
	let lastIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
		if (msg.role !== "toolResult" || msg.toolName !== TODO_TOOL_NAME) continue;
		const d = msg.details as TodoDetails | undefined;
		if (!Array.isArray(d?.todos)) continue;
		todos = d!.todos.filter(isTodoItem);
		lastIndex = i;
	}
	const planHiddenByCompaction = todos.length > 0 && branch.some((e, i) => i > lastIndex && e.type === "compaction");
	return { todos, planHiddenByCompaction };
}

export function registerTodoTool(pi: ExtensionAPI): void {
	let todos: TodoItem[] = [];
	let turnsSinceUpdate = 0;
	let compactedSinceUpdate = false;

	const adoptBranchState = (ctx: ExtensionContext) => {
		const state = reconstructFromSession(ctx);
		todos = state.todos;
		compactedSinceUpdate ||= state.planHiddenByCompaction;
	};

	pi.on("session_start", (_event, ctx) => {
		adoptBranchState(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		adoptBranchState(ctx);
	});
	pi.on("session_compact", () => {
		compactedSinceUpdate = true;
	});

	pi.on("before_agent_start", () => {
		turnsSinceUpdate++;
		const p = summarizeTodos(todos);
		if (!shouldRemind({ unfinished: p.resolved < p.total, turnsSinceUpdate, compactedSinceUpdate })) return;
		// Consume the trigger so the reminder fires once, not every turn.
		turnsSinceUpdate = 0;
		compactedSinceUpdate = false;
		return {
			message: {
				customType: "todo.reminder",
				content: renderReminder(todos),
				display: false,
			},
		};
	});

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description:
			"Manage the session task list for multi-step work (3+ distinct steps). Send the FULL list on every call — it replaces the previous list. At most one item may be in_progress; mark an item in_progress immediately before starting it, and completed or cancelled as soon as it is resolved. Skip this tool for simple tasks.",
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
			todos = next;
			turnsSinceUpdate = 0;
			compactedSinceUpdate = false;
			return {
				content: [{ type: "text", text: renderPlainList(todos) }],
				details: { todos: [...todos] } as TodoDetails,
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
