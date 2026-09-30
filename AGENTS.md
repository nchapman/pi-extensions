# AGENTS.md

Personal [pi](https://pi.dev) coding-agent extension package. pi loads this directory in-place (`pi install /Users/nchapman/Code/pi-extensions`, verify with `pi list`), so **there is no build step** — pi runs the TypeScript directly and edits go live on `/reload`. Extension API types come from `@earendil-works/pi-coding-agent`, pinned in devDependencies to the installed pi version.

## Commands

```sh
npm run check      # typecheck + full test suite — the gate to run before every commit
npm test           # vitest only
npx tsc --noEmit   # typecheck only
npm run format     # prettier --write extensions lib tests
npm run check:format
npm run test:coverage  # vitest with V8 coverage report
```

`npm run check` must pass before reporting any change done.

## Layout

- `extensions/*.ts` — one file per extension; every file here is auto-registered via `pi.extensions` in `package.json` (cross-extension imports exist — e.g. `recall.ts` imports plan rendering from `todo.ts`, so vendoring one file can pull in another)
- `lib/` — shared core modules (e.g. the background-task registry) imported by extensions and tests alike
- `tests/*.test.ts` — one vitest suite per module/extension; keep new tests in the matching file

## Code conventions

- TypeScript with lint-grade strictness beyond `strict: true` (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and more). No unused anything; type-only imports use `import type`.
- Prettier enforced: double quotes, semicolons, 2-space indent, 120-col width, trailing commas. Run `npm run format` before committing.
- Comment the *why* — file headers explain the deliberate design cut (see `lib/background.ts` for the pattern), not a narration of the code.
- Configuration is environment knobs (`PI_*`) parsed through small pure `parse*` helpers; invalid values fall back to documented defaults (range-clamped), never throw. Read timing varies — at registration (overflow, recall) or per-call (subagents) — match the surrounding code.
- Every network fetch and child process is bounded (timeout, capped buffers). Errors must carry enough detail to act on; choose fail-open vs fail-closed deliberately and say which in a comment.

## Testing conventions

- Pure logic (config parsing, name resolution, formatting, serialization) is exported separately from the extension entry so vitest can cover it directly.
- Boundaries (child spawn, fetch, filesystem) are injected as deps and replaced with hand-rolled fakes in tests — the house pattern; there is no `vi.mock` in the suite, prefer injected fakes over it. Tests never launch pi or hit the network.
- Bug fix workflow: write the failing test first, then fix, then re-run `npm run check`.

## Design through-line

**Keep the parent agent's context small; fail explicitly.** Extensions add capability without bloating the tool surface the main agent sees. Before adding a tool, message, or wake, justify its context cost. The README's Design Notes section records the reasoning behind each mechanism — read it before changing one, and update the relevant extension's table row and design note when behavior changes.

## Commit messages

Imperative subject, no scope tags (see `git log --oneline`): "Add a bg tool for backgrounding shell commands". Subject says what and why in one line; bullets below for anything non-obvious.
