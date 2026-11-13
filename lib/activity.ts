/**
 * Extension-owned background activity, independent of tools and terminal integrations.
 * Holds describe unfinished work, not Pi scheduler state: never override isIdle(),
 * keep a turn open, or send model messages. Owners release in finally; teardown
 * releases the whole scope, and late releases cannot affect a replacement scope.
 *
 * Pi's independent jiti graphs need Symbol.for sharing. Stores are keyed by session
 * id, reference-counted by runtime bindings, and dropped when the last binding leaves.
 * No persistent state: resumed jobs reacquire holds when their owner adopts them.
 * Observers are advisory and fail open; they must never break the work they observe.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ReleaseActivity = () => void;
export type ActivityListener = (count: number) => void;
export interface ActivitySource {
  readonly count: number;
  subscribe(listener: ActivityListener): () => void;
}

export function createActivityStore() {
  const holds = new Set<symbol>();
  const listeners = new Set<ActivityListener>();
  const notify = (listener: ActivityListener) => {
    try {
      listener(holds.size);
    } catch {
      // A broken reporter must not prevent adoption, completion, or cancellation.
    }
  };
  const publish = () => {
    for (const listener of listeners) notify(listener);
  };
  return {
    get count() {
      return holds.size;
    },
    hold(owner: string): ReleaseActivity {
      const token = Symbol(owner);
      holds.add(token);
      publish();
      return () => {
        if (holds.delete(token)) publish();
      };
    },
    subscribe(listener: ActivityListener): () => void {
      listeners.add(listener);
      notify(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

type Store = ReturnType<typeof createActivityStore>;
type Shared = Map<string, { store: Store; users: number }>;
const KEY = Symbol.for("pi-extensions.activity.v1");
function sharedStores(): Shared {
  const globals = globalThis as Record<symbol, Shared | undefined>;
  return (globals[KEY] ??= new Map());
}

/** Bind once in an extension factory. Acquire holds only after session_start. */
export function bindActivity(
  pi: Pick<ExtensionAPI, "on">,
  owner: string,
): ActivitySource & {
  hold(): ReleaseActivity;
} {
  let store: Store | undefined;
  let disconnect: (() => void) | undefined;
  const releases = new Set<ReleaseActivity>();
  const listeners = new Map<ActivityListener, (() => void) | undefined>();
  const cleanup = () => {
    // Detach observers before dropping holds, so a torn-down reporter emits nothing.
    for (const [listener, unsubscribe] of listeners) {
      unsubscribe?.();
      listeners.set(listener, undefined);
    }
    for (const release of releases) release();
    disconnect?.();
    disconnect = undefined;
    store = undefined;
  };
  pi.on("session_start", (_event, ctx) => {
    cleanup();
    const key = ctx.sessionManager.getSessionId();
    const stores = sharedStores();
    let entry = stores.get(key);
    if (!entry) {
      entry = { store: createActivityStore(), users: 0 };
      stores.set(key, entry);
    }
    const connection = entry;
    connection.users++;
    store = connection.store;
    disconnect = () => {
      if (--connection.users === 0 && stores.get(key) === connection) stores.delete(key);
    };
    for (const listener of listeners.keys()) listeners.set(listener, store.subscribe(listener));
  });
  pi.on("session_shutdown", cleanup);
  return {
    get count() {
      return store?.count ?? 0;
    },
    hold() {
      // Factories and late callbacks after shutdown must not resurrect activity.
      if (!store) return () => {};
      const drop = store.hold(owner);
      const release = () => {
        if (!releases.delete(release)) return;
        drop();
      };
      releases.add(release);
      return release;
    },
    subscribe(listener) {
      listeners.get(listener)?.();
      listeners.set(listener, store?.subscribe(listener));
      return () => {
        listeners.get(listener)?.();
        listeners.delete(listener);
      };
    },
  };
}
