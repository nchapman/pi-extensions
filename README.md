# pi-extensions

Personal [pi](https://pi.dev) coding agent extensions. Installed as a local pi package, so edits are live: change a file, then `/reload` in a pi session.

## Extensions

| Extension | Description |
|---|---|
| `extensions/mcp.ts` | MCP gateway on `@modelcontextprotocol/sdk`. One proxy tool: status, list, search, describe, call. Servers from `~/.pi/agent/mcp.json` connect lazily, tool metadata is cached, connections close on idle (`unref`'d timer + `session_shutdown`) so pi can always exit. |
| `extensions/subagents.ts` | Subagent delegation. Agents are markdown files in `~/.pi/agent/agents/` (YAML frontmatter via the `yaml` package: `description`, `tools` as string/array/per-tool map, optional `model`/`thinking`). `subagent` runs one task; `subagents` runs a batch in parallel. Children are headless pi runs (`pi -p --mode json`) with isolated context, custom system prompt, and restricted tools. Pass `agent_md` for an ad-hoc specialist; with neither `agent` nor `agent_md`, a read-only generic investigator runs. Each agent also gets a matching `/name` slash command — `/name task` sends a user message that delegates `task` to that subagent (names colliding with pi built-ins or duplicates are skipped with a warning). Tool-call rows show the agent name (`subagent code-reviewer — task…`; batches show `subagents (n) names`). Timeout via `PI_SUBAGENT_TIMEOUT_MS` (default 10m); parallelism via `PI_SUBAGENT_CONCURRENCY` (default 4). |
| `extensions/llamswap.ts` | Registers the local `yeti` and `spark` llamswap gateways (OpenAI-compatible) with dynamic model discovery via `GET /v1/models`. Bounded fetch (15s) with fallback to the last persisted catalog on gateway blips. Gateway hosts/ports are hardcoded constants — edit `PROVIDERS` at the top of the file to repoint. |

## Design notes

The through-line: **keep the parent agent's context small** and **fail explicitly**. Each extension adds capability without bloating the tool surface the main agent sees, and every network/child boundary is bounded and reports errors with enough detail to act on.

### MCP: one proxy tool, lazy connections
- **Context cost**: a single `mcp` tool in context instead of every server's full tool schema. Discover with `search`, inspect with `describe`, call with `tool: "server__tool"`. Bare names work when unambiguous; ambiguous names list their qualified options.
- **Lazy connect**: servers connect on first use — a targeted call connects only the server it needs, while `search`/`describe` connect all to build the index. Tool metadata is cached after the first connect.
- **Clean exit**: idle connections close after 30s via an `unref()`'d timer, and all clients close on `session_shutdown`, so open MCP servers never keep pi alive.
- **Bounded everywhere**: connect (20s), list (20s), and call (120s) are each wrapped in a timeout; in-flight calls are tracked so an idle close never fires mid-call.

### Subagents: isolated headless pi runs
- **Isolation**: children run with `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-session`, so they see only their system prompt, the task, and the built-in tools their frontmatter allows — no feedback loop, no context bleed.
- **Delegation contract**: the child's final reply is the only thing the parent sees, so agent prompts push children to make that reply complete and self-contained.
- **Fail closed on tools**: an unknown tool name warns and is dropped; a per-tool map entry with no value disables the tool. A broken restriction never silently widens a child's powers.
- **Bounded**: per-task timeout (`PI_SUBAGENT_TIMEOUT_MS`, default 10m) via a `unref()`'d timer that SIGKILLs; parallel batch concurrency via `PI_SUBAGENT_CONCURRENCY` (default 4); stdout/stderr buffers are capped so a runaway child can't OOM the parent.

### llamswap: resilient model discovery
- Bounded `GET /v1/models` (15s). On a gateway blip, fall back to the last persisted catalog so the provider keeps working; only throw if there is no cached catalog at all.

## Development

```sh
npm install        # once
npm run check      # typecheck + full test suite
npm test           # vitest only
npx tsc --noEmit   # typecheck only
```

Pure logic (config parsing, frontmatter splitting, tool-name resolution, result serialization) is exported separately and covered by vitest suites in `tests/`; the spawn boundary is injected so child runs are testable without launching pi.

pi loads the TypeScript directly; the dev dependency on `@earendil-works/pi-coding-agent` (pinned to the installed pi version) provides the types at edit time.

## Wiring

```sh
pi install /Users/nchapman/Code/pi-extensions   # one-time; loads in-place
pi list                                          # verify
```
