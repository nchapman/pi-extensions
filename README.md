# pi-extensions

Personal [pi](https://pi.dev) coding agent extensions. Installed as a local pi package, so edits are live: change a file, then `/reload` in a pi session.

## Extensions

| Extension | Description |
|---|---|
| `extensions/llamswap.ts` | Registers the local `yeti` and `spark` llamswap gateways (OpenAI-compatible) with dynamic model discovery via `GET /v1/models`. |

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
