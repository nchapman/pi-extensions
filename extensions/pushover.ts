/**
 * Pushover extension — phone notifications for goal completion.
 *
 * Design cut: pure transport, zero model surface. It registers no tools and
 * adds no context cost; it subscribes to the typed event in lib/goal-events.ts
 * (the producer-owned contract — never another extension's tool I/O shapes)
 * and POSTs to Pushover. Everything fails open, because a notification
 * channel must never break the thing it observes: no config → inert, fetch
 * error → one log line and drop, no listeners → nobody's problem.
 *
 * Inert unless both PI_PUSHOVER_TOKEN and PI_PUSHOVER_USER are set. Each POST
 * is bounded (10s abort) and fire-and-forget; the response body is never
 * read — only the status matters.
 */
import { onGoalCompleted, type GoalCompletedEvent } from "../lib/goal-events";

const PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 10_000;
/** Pushover's documented limits. */
const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;

export interface PushoverConfig {
  token: string;
  user: string;
}

/** Both credentials present and non-blank, or null (extension stays inert). */
export function parsePushoverConfig(env: NodeJS.ProcessEnv): PushoverConfig | null {
  const token = env["PI_PUSHOVER_TOKEN"]?.trim();
  const user = env["PI_PUSHOVER_USER"]?.trim();
  if (!token || !user) return null;
  return { token, user };
}

/** Compose the notification. Pure, so tests pin exactly what a phone sees. */
export function formatPushoverMessage(event: GoalCompletedEvent): { title: string; message: string } {
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  const objective = clip(event.objective, 80);
  return {
    title: clip(`Goal #${event.id} complete: ${objective}`, MAX_TITLE),
    message: clip(
      `${event.summary || event.objective}\n${event.criteriaCount} ${event.criteriaCount === 1 ? "criterion" : "criteria"} · ${event.cwd}`,
      MAX_MESSAGE,
    ),
  };
}

export interface PushoverDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Failure sink; defaults to console.error. One actionable line per failure. */
  log?: (line: string) => void;
}

/** Build the completion listener. Sync and never-throwing; the POST inside is fire-and-forget. */
export function createPushoverNotifier(
  config: PushoverConfig,
  deps: PushoverDeps = {},
): (event: GoalCompletedEvent) => void {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? ((line) => console.error(line));
  return (event) => {
    const { title, message } = formatPushoverMessage(event);
    const body = new URLSearchParams({ token: config.token, user: config.user, title, message });
    fetchFn(PUSHOVER_ENDPOINT, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) log(`pushover: notification for goal #${event.id} rejected (HTTP ${res.status}) — dropped`);
      })
      .catch((error: unknown) => {
        log(`pushover: notification for goal #${event.id} failed (${String(error)}) — dropped`);
      });
  };
}

export default function registerPushover(): void {
  const config = parsePushoverConfig(process.env);
  // Unconfigured is the normal case for a notification channel: register nothing.
  if (!config) return;
  // Owner-keyed: a /reload's fresh module copy replaces this registration
  // instead of stacking a duplicate (see lib/goal-events.ts).
  onGoalCompleted("pushover", createPushoverNotifier(config));
}
