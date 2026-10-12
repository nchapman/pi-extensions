/**
 * Goal lifecycle events — the explicit producer-owned contract between the
 * goal extension and its consumers (pushover notifications, anything later).
 *
 * Design cut: pi's event bus has no custom channels for extensions (`pi.on`
 * is typed to pi's own built-in events, and extensions get no `emit`), so the
 * bus is a listener map here. Consumers subscribe to a typed payload instead
 * of reverse-engineering another extension's tool input/output shapes, which
 * is brittle by construction.
 *
 * The map hangs off a Symbol.for process-global, NOT a module-scoped object:
 * pi loads each extension file through its own jiti instance with the runtime
 * module cache disabled, so the producer (goal.ts) and a consumer (pushover.ts)
 * can hold two separate copies of this module — a module-scoped map would
 * silently never connect emitter to listener while passing every test (tests
 * share one module graph). This is the same cut as lib/superbash.ts's shared
 * task registry. Registration is owner-keyed: a /reload's fresh module copy
 * re-registers under its owner key and replaces the stale entry instead of
 * stacking a duplicate.
 *
 * Events are gossip, and every rule follows from that:
 * - producers never await, never block, and never see consumer errors;
 * - a listener that throws is isolated (its error is logged-and-dropped);
 * - zero listeners is the normal case, not a special one.
 * New lifecycle events (blocked, stopped, …) belong here with their payload
 * types — the producer decides when they are true, not the tool surface.
 */

export interface GoalCompletedEvent {
  /** The goal's monotonic id. */
  id: number;
  objective: string;
  /** Gate-validated completion summary from the completing call. */
  summary: string;
  /** How many criteria the evidence had to prove (objective counts when empty). */
  criteriaCount: number;
  /** Session working directory, so a consumer can say which project finished. */
  cwd: string;
  /** Completion time, epoch ms. */
  at: number;
}

type GoalCompletedListener = (event: GoalCompletedEvent) => void;

const SHARED_LISTENERS_KEY = Symbol.for("pi-extensions.goal-events.listeners");

function sharedListeners(): Map<string, GoalCompletedListener> {
  const globals = globalThis as Record<symbol, Map<string, GoalCompletedListener> | undefined>;
  return (globals[SHARED_LISTENERS_KEY] ??= new Map());
}

/**
 * Subscribe under an owner key (e.g. "pushover"). Registering an owner again
 * replaces its previous listener — idempotent across /reload. The returned
 * function unsubscribes, but only if this listener is still the registered one.
 */
export function onGoalCompleted(owner: string, listener: GoalCompletedListener): () => void {
  sharedListeners().set(owner, listener);
  return () => {
    const listeners = sharedListeners();
    if (listeners.get(owner) === listener) listeners.delete(owner);
  };
}

/** Fire a completion event. Never throws, never blocks on a listener. */
export function emitGoalCompleted(event: GoalCompletedEvent): void {
  // Snapshot: a listener mutating the map mid-iteration must not skip the rest.
  for (const listener of [...sharedListeners().values()]) {
    try {
      listener(event);
    } catch (error) {
      // Events must never break anything — a broken consumer is its own problem.
      console.error(`goal-events: goal-completion listener threw (dropped): ${String(error)}`);
    }
  }
}
