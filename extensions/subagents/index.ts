/**
 * Subagents extension — delegate focused, isolated work to child pi sessions.
 *
 * Design: a subagent is a fresh pi run (`-p --mode json --no-session`, no
 * skills/prompt-templates/MCP) with the agent definition's system prompt and
 * tool restrictions. Extensions are opt-in per agent (`extensions:`
 * frontmatter, or PI_SUBAGENT_EXTENSIONS as the default-for-all knob):
 * named extensions load into the child via explicit `-e` paths — discovery
 * stays off, so the default child remains fully isolated and deterministic,
 * while an agent can be granted capabilities like ssh_bash or gateway
 * providers. The parent sees only the child's final text, so every task must
 * carry its own context. The child binary matches the
 * parent's (pi-bolt spawns pi-bolt; PI_SUBAGENT_BIN overrides). Runs are
 * bounded by a hard timeout (PI_SUBAGENT_TIMEOUT_MS) plus an idle watchdog
 * (PI_SUBAGENT_IDLE_TIMEOUT_MS, on by default at 5 minutes) that kills a
 * child whose LLM request has gone silent — tool executions exempt, since
 * silence there is healthy work. Children run on the agent's pinned model or
 * inherit the session's; thinking defaults to low (call param > agent file >
 * default; pi clamps per model). A shared task registry (lib/superbash)
 * powers backgrounding: `background: true` (or PI_SUBAGENT_BG_AFTER_MS)
 * hands the still-running child to the registry and returns a task id; the
 * result is delivered later as a steering wake — turn-boundary delivery that
 * sleep-polling can never beat — and session shutdown kills the orphans
 * (persistent bash tasks are the exception: they run detached with their
 * state on disk, so shutdown spares them and the next session's start scan
 * re-adopts or settles them — lib/superbash's resumePersistedTasks).
 * Batch calls run with bounded concurrency (PI_SUBAGENT_CONCURRENCY) and sum
 * their per-child usage so cost accounting survives failures. Each agent
 * file also gets a `/name` command (pi built-ins take precedence).
 */

/**
 * Module map (pure layers below the wiring; this file owns the tool schemas,
 * tool registration, and the extension lifecycle):
 * - agents.ts  agent-file discovery/parsing + one /command per agent
 * - child.ts   the child runner: spawn, stream parsing, timeouts, adoption
 * - render.ts  what the user sees: tool-call and result rows
 */

import { Type } from "typebox";
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AdoptedHandle,
  type TaskRegistry,
  createBashTool,
  createTaskKillTool,
  createTaskRemindTool,
  createTaskRegistry,
  createTasksCommand,
  createTaskTool,
  parseBashBgAfterMs,
  parseBgAfterMs,
  parseWakeEnabled,
  publishSharedTaskRegistry,
  resumePersistedTasks,
} from "../../lib/superbash";
import {
  AGENTS_DIR,
  effectiveAgent,
  extractAssistantText,
  loadAgents,
  refLabel,
  registerCommandsForAgents,
  resolveAgentDef,
} from "./agents";
import {
  DEFAULT_SUBAGENT_THINKING,
  THINKING_LEVELS,
  adoptSubagentTask,
  backgroundedNotice,
  defaultSpawn,
  isValidThinkingLevel,
  parseConcurrency,
  parseIdleTimeoutMs,
  parseTimeoutMs,
  childModelPlan,
  resolveChildThinking,
  runChild,
  runWithLimit,
  sumUsages,
} from "./child";
import type { AgentDef, ChildRun, ChildUsage, RunChildOptions, SpawnFn } from "./child";
import { renderSubagentCall, renderSubagentsCall, renderSubagentResult, reuseText } from "./render";

export * from "./agents";
export * from "./child";
export * from "./render";

const taskField = Type.String({ description: "The task to delegate, with full context" });
const thinkingField = Type.Optional(
  Type.String({
    description: `Thinking level (${THINKING_LEVELS.join("|")}) — adjust speed/quality on the fly: off for fast mechanical runs, high for hard ones. Defaults to the agent definition's level, then ${DEFAULT_SUBAGENT_THINKING}.`,
  }),
);
const backgroundField = Type.Optional(
  Type.Boolean({
    description:
      "Run in the background: return immediately with a task id, then end your turn if you have nothing else to do — the result is delivered to you automatically as your next message, even mid-run.",
  }),
);
const taskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Named agent from the available list" })),
  agent_md: Type.Optional(
    Type.String({
      description:
        "Inline agent definition: markdown with optional frontmatter (name, description, tools, thinking) followed by the system prompt. Takes precedence over the generic default. Provide either agent or agent_md, not both.",
    }),
  ),
  task: taskField,
  thinking: thinkingField,
  background: backgroundField,
});

export function registerSubagentTools(
  pi: ExtensionAPI,
  agentsDir: string = AGENTS_DIR,
  spawnFn: SpawnFn = defaultSpawn,
  preloadedAgents?: AgentDef[],
  registry?: TaskRegistry,
): void {
  const agents = preloadedAgents ?? loadAgents(agentsDir);
  // The description's agent list is fixed at registration, but execute
  // re-reads the directory so edited agent files take effect without
  // reloading the extension.
  const agentList = agents.length
    ? agents.map((a) => `- ${a.name}: ${a.description || "(no description)"}`).join("\n")
    : `(no agents found in ${agentsDir})`;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a focused task to a subagent: a fresh pi session with its own context, system prompt, and tool restrictions.
Available agents:
${agentList}
Alternatively pass agent_md: a full agent definition in markdown (frontmatter + system prompt) for an ad-hoc specialist. With neither, a generic read-only investigator runs.
The subagent runs to completion and returns its final response. Use for reviews, research, and any work that benefits from an isolated context.
By default the call blocks until the subagent finishes — waiting on a tool call costs nothing. Pass background: true for long work you have other work to do alongside: the tool returns a task id immediately and the result is delivered to you automatically as your next message, even mid-run — if you have nothing else to do, end your turn; the wake re-engages you. Never sleep or poll to wait.`,
    promptSnippet: "Delegate a task to a focused subagent (isolated pi session)",
    promptGuidelines: [
      "Use subagent for self-contained work (reviews, research, audits); the subagent only sees the task text you pass, so include all needed context.",
      "For a bespoke specialist, pass agent_md with the exact instructions and tool restrictions instead of forcing a named agent to fit.",
      "Subagents block until they finish — waiting costs nothing. Pass background: true only when you have other work to do alongside; the backgrounded result arrives as your next message, even mid-run — end your turn if you have nothing else to do. Never sleep or poll to wait.",
    ],
    parameters: taskItem,
    renderCall(args, theme, context) {
      // Arguments stream in partially; guard until `task` arrives.
      const task = typeof args?.task === "string" ? args.task : "";
      const text = reuseText(context);
      text.setText(renderSubagentCall(refLabel(args ?? {}), task, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      // On errors pi replaces details with {}; fall back to the call arguments
      // so the agent name survives every path.
      const d = result.details as { agent?: string; backgrounded?: boolean } | undefined;
      const info = { agent: d?.agent ?? refLabel(context?.args ?? {}), backgrounded: d?.backgrounded };
      const text = reuseText(context);
      text.setText(
        renderSubagentResult(
          extractAssistantText(result.content),
          info,
          {
            isPartial: options.isPartial,
            expanded: options.expanded,
            isError: context?.isError ?? false,
          },
          theme,
        ),
      );
      return text;
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const list = loadAgents(agentsDir);
      const agent = resolveAgentDef(list, params);
      // Adoption is wired only when a registry is present; without one the
      // tool waits synchronously exactly as before.
      if (params.thinking !== undefined && !isValidThinkingLevel(params.thinking)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid thinking "${params.thinking}" — must be one of ${THINKING_LEVELS.join("|")}.`,
            },
          ],
          details: { kind: "subagent" },
          isError: true,
        };
      }
      const options: RunChildOptions = {
        timeoutMs: parseTimeoutMs(process.env),
        idleTimeoutMs: parseIdleTimeoutMs(process.env),
        onUpdate,
        signal,
        thinking: resolveChildThinking(params.thinking, agent.thinking),
      };
      if (registry) {
        options.adoptAfterMs = params.background ? 0 : parseBgAfterMs(process.env);
        options.onAdopted = (handle: AdoptedHandle<ChildRun>) =>
          adoptSubagentTask(registry, agent.name, handle, ctx?.sessionManager?.getSessionDir());
      }
      // Read per call so PI_SUBAGENT_EXTENSIONS changes apply live. A model
      // the child can't resolve retries once on the fallback (pinned ->
      // session -> pi default) instead of failing the run.
      const plan = childModelPlan(agent.model, ctx?.model);
      const run = await runChild(
        effectiveAgent(agent),
        params.task,
        plan.model,
        { ...options, fallbackModel: plan.fallbackModel },
        spawnFn,
      );
      if ("adopted" in run) {
        return {
          content: [{ type: "text", text: backgroundedNotice(agent.name, run.id) }],
          details: { agent: agent.name, backgrounded: true, id: run.id },
        };
      }
      return {
        content: [{ type: "text", text: run.text }],
        details: { agent: agent.name },
        ...(run.usage ? { usage: run.usage } : {}),
      };
    },
  });

  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description: `Run multiple subagents in parallel. Each task gets an isolated pi session.
Available agents:
${agentList}
Each task may instead include agent_md (an inline agent definition) or omit both to use the generic read-only investigator.
By default the call blocks until every subagent finishes — waiting on a tool call costs nothing. Pass background: true per task for long work you have other work to do alongside: that task returns a task id immediately and its result is delivered to you automatically as your next message, even mid-run — if you have nothing else to do, end your turn; the wake re-engages you. Never sleep or poll to wait.`,
    promptSnippet: "Run several subagent tasks in parallel",
    promptGuidelines: [
      "Use subagents for independent, self-contained tasks that benefit from parallel isolated sessions; each subagent only sees its own task text, so include all needed context.",
      "Subagents block until they finish — waiting costs nothing. Pass background: true per task only when you have other work to do alongside; backgrounded results arrive as your next message, even mid-run — end your turn if you have nothing else to do. Never sleep or poll to wait.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(taskItem, { minItems: 1, description: "Tasks to run in parallel" }),
    }),
    renderCall(args, theme, context) {
      // Arguments stream in partially; guard until `tasks` is a complete array.
      const names = Array.isArray(args?.tasks) ? args.tasks.map((t) => refLabel(t ?? {})) : [];
      const text = reuseText(context);
      text.setText(renderSubagentsCall(names, theme));
      return text;
    },
    renderResult(result, options, theme, context) {
      // Prefer the result's count; fall back to complete call arguments when
      // pi replaced the details (error path).
      const d = result.details as { count?: number; backgrounded?: number } | undefined;
      const tasks = Array.isArray(context?.args?.tasks) ? context.args.tasks : [];
      const info = { count: d?.count ?? (tasks.length || undefined), backgrounded: d?.backgrounded };
      const text = reuseText(context);
      text.setText(
        renderSubagentResult(
          extractAssistantText(result.content),
          info,
          {
            isPartial: options.isPartial,
            expanded: options.expanded,
            isError: context?.isError ?? false,
          },
          theme,
        ),
      );
      return text;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      const list = loadAgents(agentsDir);
      const timeoutMs = parseTimeoutMs(process.env);
      const idleTimeoutMs = parseIdleTimeoutMs(process.env);
      for (const t of params.tasks) {
        if (t.thinking !== undefined && !isValidThinkingLevel(t.thinking)) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid thinking "${t.thinking}" for task ${t.task.slice(0, 40)} — must be one of ${THINKING_LEVELS.join("|")}.`,
              },
            ],
            details: { kind: "subagents" },
            isError: true,
          };
        }
      }
      const sessionDir = ctx?.sessionManager?.getSessionDir();
      const results = await runWithLimit(
        params.tasks.map((t) => () => {
          const agent = resolveAgentDef(list, t);
          const options: RunChildOptions = {
            timeoutMs,
            idleTimeoutMs,
            signal,
            thinking: resolveChildThinking(t.thinking, agent.thinking),
          };
          if (registry) {
            options.adoptAfterMs = t.background ? 0 : parseBgAfterMs(process.env);
            options.onAdopted = (handle: AdoptedHandle<ChildRun>) =>
              adoptSubagentTask(registry, agent.name, handle, sessionDir);
          }
          const plan = childModelPlan(agent.model, ctx?.model);
          return runChild(
            effectiveAgent(agent),
            t.task,
            plan.model,
            { ...options, fallbackModel: plan.fallbackModel },
            spawnFn,
          );
        }),
        parseConcurrency(process.env),
      );
      const sections = results.map((r, i) => {
        const label = refLabel(params.tasks[i]);
        const body =
          r.status === "rejected"
            ? `ERROR: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
            : "adopted" in r.value
              ? `Still running — backgrounded as ${r.value.id}.`
              : r.value.text;
        return `### ${label}\n${body}`;
      });
      // Failed children still spent tokens — recover the spend attached by
      // runChild's rejection instead of dropping it from the batch total.
      // Adopted children's usage rides in their wake messages instead: the
      // inline total covers only what finished here.
      const usage = sumUsages(
        results.map((r) =>
          r.status === "fulfilled"
            ? "adopted" in r.value
              ? undefined
              : r.value.usage
            : (r.reason as { usage?: ChildUsage })?.usage,
        ),
      );
      const backgroundedCount = results.filter((r) => r.status === "fulfilled" && "adopted" in r.value).length;
      // One shared footer, not a paragraph per task: N repetitions of the
      // same contract trains skimming, and the batch is where several long
      // runs land at once.
      const bgFooter = backgroundedCount
        ? `\n\n${backgroundedCount} task${backgroundedCount > 1 ? "s" : ""} still running — if you have nothing else to do, end your turn; the wakes re-engage you. Never sleep or poll to wait, and don't arm check-ins just to wait — results arrive on their own.`
        : "";
      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") + bgFooter }],
        details: { count: params.tasks.length, ...(backgroundedCount ? { backgrounded: backgroundedCount } : {}) },
        ...(usage ? { usage } : {}),
      };
    },
  });
}

/** Register the extension against pi. Extracted from the default export so
 * tests can drive the full wiring — registry, tools, commands, lifecycle —
 * with a fake pi and injected spawn. */
export function registerSubagentsExtension(
  pi: ExtensionAPI,
  opts: { agentsDir?: string; spawnFn?: SpawnFn; bgOperations?: () => BashOperations } = {},
): void {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
  const agents = loadAgents(agentsDir);
  // UI channels arrive with the first event context; the wake channel is pi itself.
  let ui: ExtensionContext["ui"] | undefined;
  // Wakes steer in rather than follow up: a followUp message queues until the
  // run ends, so a model that "waits" by calling tools — sleep-polling — can
  // never receive it (delivery is turn-boundary-based, not time-based).
  // Steering lands at the parent's next turn boundary, even mid-run: a busy
  // model gets the result as its next message, and a sleep-polling model gets
  // it the moment its sleep returns — the livelock is impossible by mechanism,
  // not by instruction.
  const steer = (text: string) => {
    // The registry's deliver() and the resume path both swallow rejections —
    // a rejected steer (session gone) must not become an unhandled rejection.
    try {
      const sent = pi.sendUserMessage(text, { deliverAs: "steer" }) as unknown;
      if (sent != null && typeof (sent as { then?: unknown }).then === "function") {
        void (sent as Promise<unknown>).catch(() => {});
      }
    } catch {
      // a synchronous failure (session gone) must not surface on the wake path
    }
  };
  const registry = createTaskRegistry({
    sendUserMessage: steer,
    notify: (message, level) => ui?.notify(message, level),
    setStatus: (key, text) => ui?.setStatus(key, text),
    wakeEnabled: parseWakeEnabled(process.env),
  });
  // Cross-extension visibility (goal's settle check defers while tasks run):
  // publish after creation so readers never see a half-built registry. A
  // re-registration (reload, session replacement) publishes the new registry.
  publishSharedTaskRegistry(registry);
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    // Reconcile durable background tasks with this fresh runtime: finished
    // ones wake with their outcome, expired ones die, live ones are re-adopted.
    // Floating and fail-open — session start must never block on disk I/O, and
    // the scan itself never throws (per-task failures are swallowed there).
    const sessionDir = ctx?.sessionManager?.getSessionDir?.();
    if (sessionDir) {
      // The wake seam carries the resume-time notices (re-adopted,
      // unverifiable); settled outcomes go through the registry's channels.
      // Same PI_BG_WAKE gate as the registry: PI_BG_WAKE=0 silences every
      // resume-time steer, not just the settled wakes — one turn per task at
      // every session start is exactly what the knob turns off.
      const wake = parseWakeEnabled(process.env) ? steer : undefined;
      void resumePersistedTasks(registry, sessionDir, { wake }).catch(() => {});
    }
  });
  pi.on("session_shutdown", (event) => {
    // Every shutdown reason converges here — quit, reload, and session
    // replacement (new/resume/fork): the registry and its children belong to
    // the runtime being torn down, and an orphaned subagent burns tokens with
    // nobody consuming the result. Replacement kills break the promised wake,
    // so they say so; quit and reload need no explanation. Persistent bash
    // tasks are the exception: they were spawned detached with their state on
    // disk, so they are spared (handed off, not killed) — the next session's
    // scan re-adopts or settles them.
    const persistent = registry.running().filter((t) => t.persistent).length;
    const killed = registry.killAll({ sparePersistent: true });
    if (killed > 0 && (event.reason === "new" || event.reason === "resume" || event.reason === "fork")) {
      ui?.notify(
        `Background tasks killed (${event.reason}): killed ${killed}, their results will not arrive.`,
        "warning",
      );
    }
    if (persistent > 0) {
      ui?.notify(
        `${persistent} persistent background task${persistent === 1 ? "" : "s"} keep${persistent === 1 ? "s" : ""} running across this restart.`,
        "info",
      );
    }
  });
  registerSubagentTools(pi, agentsDir, opts.spawnFn ?? defaultSpawn, agents, registry);
  // The unified bash tool replaces the built-in by name: wait: inline delegates
  // to pi's own bash tool; auto/background promote to this registry like subagents.
  // The wait window is read per call so PI_BASH_BG_AFTER_MS changes apply live.
  pi.registerTool(
    createBashTool(registry, {
      // bgOperations is a test harness faking pi's own LOCAL bash operations —
      // declare it local so the persistence gate keeps passing under tests.
      operations: opts.bgOperations?.(),
      persistent: opts.bgOperations ? { localOperations: true } : undefined,
      waitMs: () => parseBashBgAfterMs(process.env),
    }),
  );
  // Task management: peek (pull-based check-in), kill, and scheduled check-ins.
  pi.registerTool(createTaskTool(registry));
  pi.registerTool(
    createTaskKillTool(registry, { onKilled: (id) => ui?.notify(`Background task killed: ${id}`, "warning") }),
  );
  pi.registerTool(createTaskRemindTool(registry));
  pi.registerCommand("tasks", createTasksCommand(registry));
  registerCommandsForAgents(pi, agents);
}

export default function (pi: ExtensionAPI) {
  registerSubagentsExtension(pi);
}
