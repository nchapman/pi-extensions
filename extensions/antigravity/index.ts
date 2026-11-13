/**
 * Antigravity / Cloud Code Assist provider for pi — a slim in-repo fork of
 * Rahul Arya's `pi-antigravity` v0.12.0 (MIT; see LICENSE-pi-antigravity).
 * https://github.com/Rahularya01/pi-antigravity
 *
 * Why fork: the npm package carries a large surface we never use and lags pi
 * releases. This fork keeps only the parts we run daily — the model bit — so
 * the wire-protocol code (streaming, model catalog) is something we can patch
 * ourselves. Everything under extensions/antigravity/ stays close to upstream
 * file-for-file, so upstream fixes can still be cherry-picked by diff.
 *
 * Kept: the `antigravity` provider (custom streamSimple over Cloud Code Assist),
 * OAuth login/refresh, and dynamic model discovery + grouping with a persisted
 * last-known-good catalog. That is the whole surface: models, nothing else.
 *
 * Cut vs upstream: the `google_search` and `generate_image` tools (search/ and
 * image/ modules deleted, not disabled), multi-account store + 429 account
 * failover, usage/quota and all /antigravity.* slash commands, the native
 * image-API registration, and the undici dependency. A hard quota wall
 * surfaces as a plain error pi can retry; forced catalog refresh is the 4h
 * TTL + session start (ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS=0 refreshes
 * every session).
 *
 * Auth reuse: the provider id and the OAuth credential shape (refresh/access/
 * expires/projectId/email, same Google desktop client id) are identical to
 * upstream, so the credentials already stored in ~/.pi/agent/auth.json under
 * "antigravity" keep working — pi resolves and refreshes them through the
 * handlers below with no re-login. `pi remove npm:pi-antigravity` before
 * enabling this fork; both register the same provider id.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiKey, loginAntigravity, refreshAntigravityToken } from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { getCurrentAntigravityCatalog, PROVIDER_ID, PROVIDER_NAME, refreshAntigravityModels } from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";

export default function (pi: ExtensionAPI): void {
  // Print and RPC modes do not refresh catalogs before resolving --model. Refresh on
  // session start so a stale cache is replaced before the prompt, and so the next
  // headless process hydrates new models from the persisted store.
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) return;
    if (typeof ctx.modelRegistry?.refresh !== "function") return;
    try {
      const refresh = ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
      if (ctx.hasUI) void refresh.catch(() => {});
      else await refresh;
    } catch {
      // Last-known-good catalog stays in place.
    }
  });

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: getCurrentAntigravityCatalog().models,
    refreshModels: (context) => refreshAntigravityModels(context),
    oauth: {
      name: PROVIDER_NAME,
      // Antigravity access is quota-backed by the Google account, not metered per token.
      // Pi uses this for the footer's (sub) marker and subscription-aware cost display.
      isSubscription: true,
      login: (callbacks) => loginAntigravity(callbacks),
      // Forward pi's abort signal into the token refresh request.
      refreshToken: (credentials, signal) => refreshAntigravityToken(credentials, signal),
      getApiKey,
    },
    streamSimple: streamAntigravity,
  });
}
