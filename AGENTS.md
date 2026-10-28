# AGENTS.md

## Project

Personal [pi](https://pi.dev) coding-agent extension package: extensions in `extensions/` plus shared core in `lib/`, TypeScript, no build step. pi loads this directory in-place (`pi install ~/Code/pi-extensions`, verify with `pi list`), so edits go live on `/reload`.

Extension API types come from `@earendil-works/pi-coding-agent`, pinned in devDependencies — keep the pin aligned with the installed pi (`pi --version`); it drifts when pi auto-updates.

Deeper docs: `README.md` (per-extension behavior, configuration), `docs/` (design specs).

## Commands

```sh
npm run check                # tsc --noEmit + vitest — must pass before reporting any change done
npm test                     # vitest only
npx tsc --noEmit             # typecheck only
npm run format               # prettier --write (run before committing; check:format to verify)
npm run test:coverage
npm run bench:recall         # benchmarks; bench:review-models for the review-model sweep
npm run eval:review          # review eval
npm run warm:store           # pre-warm recall's vector store
```

`npm install` runs a postinstall (`scripts/fetch-model.mjs`) that downloads recall's embedding model into `PI_RECALL_MODEL_DIR` (default `~/.pi/agent/models`). It is fail-soft: an offline install still succeeds, and recall fail-opens to BM25-only search until you run `node scripts/fetch-model.mjs` manually.

## Conventions

- **One extension per directory.** `extensions/<name>/index.ts` is the only entry pi loads; sibling modules are never loaded separately. Pure layers live in siblings and `index.ts` re-exports their surfaces, so `import … from "../extensions/<name>"` keeps working for tests and cross-extension importers. Cross-extension imports exist (`recall` imports plan rendering from `../todo`): vendoring one directory can pull in another.
- **Config is `PI_*` env knobs** parsed through small pure `parse*` helpers; invalid values fall back to documented defaults (range-clamped), never throw. Match the surrounding read timing — at registration (recall) or per-call (subagents).
- **Every network fetch and child process is bounded** (timeout, capped buffers). Errors must carry enough detail to act on; choose fail-open vs fail-closed deliberately and say which in a comment.
- **Comment the why** — file headers record each mechanism's deliberate design cuts (see `lib/superbash.ts` for the pattern); read them before changing a mechanism, and update them plus the extension's README section when behavior changes.
- **Tests**: one vitest suite per module in `tests/<module>.test.ts`. Pure logic is exported separately from the extension entry so vitest covers it directly; boundaries (child spawn, fetch, filesystem) are injected as deps and replaced with hand-rolled fakes — prefer that over `vi.mock`. Bug fix workflow: failing test first, then fix, then `npm run check`.
- **Commits**: imperative subject, no scope tags (see `git log --oneline`); the subject says what and why in one line.

## Boundaries

- Design through-line: **keep the parent agent's context small; fail explicitly.** Extensions add capability without bloating the tool surface the main agent sees — before adding a tool, message, or wake, justify its context cost.
- Tests never launch pi or hit the network.
