# pi-extensions

Personal [pi](https://pi.dev) coding agent extensions. Installed as a local pi package, so edits are live: change a file, then `/reload` in a pi session.

## Extensions

| Extension | Description |
|---|---|
| `extensions/mcp.ts` | MCP gateway on `@modelcontextprotocol/sdk`. One proxy tool: status, search, describe, call. Servers from `~/.pi/agent/mcp.json` connect lazily, tool metadata is cached, connections close on idle (`unref`'d timer + `session_shutdown`) so pi can always exit. |
| `extensions/subagents.ts` | Subagent delegation. Agents are markdown files in `~/.pi/agent/agents/` (frontmatter: `description`, `tools: {write: false}` restrictions, optional `model`/`thinking`). `subagent` runs one task; `subagents` runs a batch in parallel. Children are headless pi runs (`pi -p --mode json`) with isolated context, custom system prompt, and restricted tools. Timeout via `PI_SUBAGENT_TIMEOUT_MS` (default 10m). |
| `extensions/llamswap.ts` | Registers the local `yeti` and `spark` llamswap gateways (OpenAI-compatible) with dynamic model discovery via `GET /v1/models`. Bounded fetch (15s) with fallback to the last persisted catalog on gateway blips. |

## Design notes

- **MCP cost**: one `mcp` tool in context instead of every server tool schema. Discover with `search`, call with `tool: "server__tool"`.
- **Subagent isolation**: children run with `--no-extensions --no-skills --no-prompt-templates --no-context-files --no-session`, so they see only their system prompt, the task, and the built-in tools allowed by the agent's frontmatter.

## Development

```sh
npm install        # once, for typechecking
npx tsc --noEmit   # typecheck
```

pi loads the TypeScript directly; the dev dependency on `@earendil-works/pi-coding-agent` (pinned to the installed pi version) provides the types at edit time.

## Wiring

```sh
pi install /Users/nchapman/Code/pi-extensions   # one-time; loads in-place
pi list                                          # verify
```
