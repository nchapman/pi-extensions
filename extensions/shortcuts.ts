/**
 * Shortcuts extension — a grab bag of convenience slash commands.
 *
 * Pi ships a fixed set of commands (e.g. /quit, /compact), but people naturally
 * reach for aliases that don't exist — like /exit for /quit. This extension
 * registers a small curated set of such shortcuts so you can just type them.
 *
 * To add your own: append a Shortcut to the SHORTCUTS list below. Each shortcut
 * is a name, a description (shown in the / menu), and a `run` function that
 * receives the command context. See the built-in ExtensionCommandContext for
 * what's available (ctx.shutdown, ctx.compact, ctx.ui.notify, etc.).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** A single shortcut: a slash-command name mapped to an action. */
type Shortcut = {
  name: string;
  description: string;
  run: (ctx: ExtensionCommandContext) => void | Promise<void>;
};

/** Alias /quit — the classic thing people type as "exit". */
async function shutdownAction(ctx: ExtensionCommandContext): Promise<void> {
  ctx.shutdown();
}

/** Alias /compact — compaction with a sensible default instruction. */
async function compactAction(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify("Compacting session…", "info");
  ctx.compact({
    customInstructions:
      "Summarize this session concisely, preserving all decisions, open issues, and actionable next steps.",
  });
}

/** Report lightweight session state via a notification. */
async function infoAction(ctx: ExtensionCommandContext): Promise<void> {
  const name = ctx.sessionManager.getSessionName();
  const usage = ctx.getContextUsage();
  const lines = [
    `session: ${name ?? "(unnamed)"}`,
    `dir: ${ctx.cwd}`,
    usage ? `context: ${usage.tokens}/${usage.contextWindow}` : "context: unknown",
  ];
  ctx.ui.notify(lines.join("     "), "info");
}

/** Show the current date/time. */
async function timeAction(ctx: ExtensionCommandContext): Promise<void> {
  ctx.ui.notify(new Date().toString(), "info");
}

/**
 * Curated grab bag of shortcuts. Edit this list to add/remove your own.
 * Names are chosen to avoid colliding with pi's built-in commands.
 */
export const SHORTCUTS: Shortcut[] = [
  { name: "exit", description: "Exit pi (alias for /quit)", run: shutdownAction },
  { name: "bye", description: "Exit pi (alias for /quit)", run: shutdownAction },
  { name: "q", description: "Exit pi (alias for /quit)", run: shutdownAction },
  { name: "close", description: "Exit pi (alias for /quit)", run: shutdownAction },
  { name: "comp", description: "Compact this session (alias for /compact)", run: compactAction },
  { name: "summarize", description: "Compact this session (alias for /compact)", run: compactAction },
  { name: "info", description: "Show session name, dir, and context usage", run: infoAction },
  { name: "time", description: "Show current date/time", run: timeAction },
];

/** Register every shortcut in SHORTCUTS as a / command. */
export function registerShortcuts(pi: ExtensionAPI): void {
  for (const shortcut of SHORTCUTS) {
    pi.registerCommand(shortcut.name, {
      description: shortcut.description,
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        try {
          await shortcut.run(ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Shortcut "/${shortcut.name}" failed: ${message}`, "error");
        }
      },
    });
  }
}

export default registerShortcuts;
