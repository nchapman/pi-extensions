/**
 * Aggregate extension activity into Pi's own OSC 7501 reports. No tools, model
 * messages, Herdr IPC, or scheduler changes. A zero-row widget factory gives us
 * the public TUI terminal without replacing the user's footer/editor. The only
 * compatibility shim lives in terminal-status.ts and is removed on shutdown.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindActivity } from "../../lib/activity";
import { attachProgramStatus } from "./terminal-status";
export { attachProgramStatus, RELEASE_GRACE_MS } from "./terminal-status";

export default function (pi: ExtensionAPI) {
  const activity = bindActivity(pi, "program-status");
  let detach: (() => void) | undefined;
  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui" || process.env.PI_ACTIVITY_STATUS === "0") return;
    ctx.ui.setWidget("activity-status", (tui) => {
      // A UI rebuild can invoke the factory again. Never stack our decorators.
      detach?.();
      const installed = attachProgramStatus(
        tui.terminal,
        activity,
        {
          state: ctx.isIdle() ? "idle" : "working",
          app: "pi",
          message: ctx.sessionManager.getSessionName(),
        },
        event.reason === "reload",
      );
      detach = installed;
      return {
        render: () => [],
        invalidate() {},
        dispose() {
          installed();
          if (detach === installed) detach = undefined;
        },
      };
    });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    detach?.();
    detach = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("activity-status", undefined);
  });
}
