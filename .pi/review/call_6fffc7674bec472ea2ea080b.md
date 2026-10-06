# Code review — changes ahead of upstream plus working tree

> ⚠️ Verification skipped (PI_REVIEW_VERIFY=0) — findings below are **unverified**.

## 🟠 Important

### Stale report pointer is only half fixed: the instruction file agents actually follow still says .pi/review-report.md
**`extensions/review.ts:1497`** — found by correctness
This hunk rewrites the model-facing tool description to point at `.pi/review/<callId>.md`, but that was only one of the two pointers named by the finding it implements. The global instruction file every session in this environment loads still says the opposite: /Users/nchapman/.pi/agent/AGENTS.md:8 — "Read `.pi/review-report.md` for any finding you act on." — and README.md:63 explicitly claims "the global AGENTS.md points agents there [.pi/review/<callId>.md]", which is now false in-repo (the README was not touched by this diff). Nothing writes `.pi/review-report.md` any more: the only report writer is review.ts:1542-1543 → `<cwd>/.pi/review/<safeId>.md`, and `summarizeForTool` only prints the path it was given (review.ts:1444). Meanwhile the legacy artifact `.pi/review-report.md` still exists in this repo and holds a *different* review's findings (it describes the tool-introduction diff, not the user's current change), so an agent that resolves the pointer its system prompt gives it reads another change's findings and acts on them as its own — the exact failure the description change was meant to remove.

**Fix**: Also update the global review pointer (and delete or ignore the legacy `.pi/review-report.md` so it cannot be read as current), or correct README.md:63 so it no longer claims the global file points at the per-call report.

### New end-to-end tool test escapes its sandbox: it really writes review state to /repo
**`tests/review.test.ts:738`** — found by correctness, robustness, tests
The new test creates a hermetic cwd with mkdtempSync (tests/review.test.ts:749) and stubs git and spawnFn, but deliberately leaves writeFile as reviewDeps' real default (comment at line 736) and does not set PI_REVIEW_STATE. parseReviewConfig(process.env) therefore yields persist: true (extensions/review.ts:128), and runReview persists via deps.writeFile(path.join(repoRoot, STATE_PATH), ...) (extensions/review.ts:1370-1376, STATE_PATH = '.pi/review-state.json' line 1025). repoRoot is not the tmpdir — it comes from the mocked `git rev-parse --show-toplevel`, which returns "/repo" (tests/review.test.ts:720-722) — so the test issues a real filesystem write to /repo/.pi/review-state.json through the default writer (mkdir recursive + writeFile). On any environment where / is writable (root, most CI containers) this creates /repo/.pi/review-state.json and leaves it behind, outside the tmpdir the test believes is hermetic; where / is read-only the mkdir throws and is swallowed by the best-effort catch (extensions/review.ts:1370-1377), so the state path is silently never exercised. Either way the test depends on the host filesystem, and the persistence path it appears to cover is not actually asserted.

**Fix**: Make the fake git return the test's temp `cwd` for `rev-parse --show-toplevel` (instead of "/repo") so the persist write stays inside the sandbox, or record writes with an injected `writeFile` and assert the recorded report path rather than touching the real filesystem.

## 🟡 Suggestion

### New mid-run abort guard inside the finder closure has no test that triggers it
**`extensions/review.ts:1261`** — found by tests
The added `if (signal?.aborted) throw new Error("review aborted")` (extensions/review.ts:1261) only fires when the signal trips after runWithLimit has started some runs and left others queued. The existing cancellation test (tests/review.test.ts:830-846) aborts the controller before calling runReview, so it exercises the pre-flight check at line 1251 (and the post-loop check at 1293) but never reaches the per-run closure guard: spawn.tasks is asserted empty before any run starts. Removing or inverting line 1261 would not fail any test, so the behavior it adds — a queued finder that must not spawn after mid-run cancellation — is unprotected.

**Fix**: Add a test that aborts the AbortController after the first child has started (e.g. from the fake spawn callback), then asserts the remaining queued runs never spawn and the call rejects with "review aborted".

### Report name documented as <callId> is now a mangled id, so the advertised path doesn't exist for nested calls
**`extensions/review.ts:1541`** — found by correctness, robustness
`id.replace(/[^a-zA-Z0-9_-]/g, "_") || "call"` is not injective: an empty id and the literal id `call` both map to `call.md`, and any two ids that differ only in punctuation map to the same name — the id scheme is `<parentId>/<n>` for nested/codemode calls (see `.pi/review/call_91b5a50fc63f4a7a89676192.md`, which documents that pi produces ids containing `/`), so a nested id `call_abc/1` becomes `call_abc_1.md` and collides with a top-level id `call_abc_1`. The comment two lines above (1536) claims "Unique per call: concurrent reviews or successive iterations must not overwrite each other", but that guarantee is now provided only by the raw id, not by the sanitized name. Consequence: one call's report silently overwrites another's, while `summarizeForTool` still hands the losing caller a `Full report: <path>` pointer, so the agent reads findings from a different review and acts on them as its own. The new test only exercises `call_../../evil`, which is collision-free, so nothing catches this.

**Fix**: Say "the report lands at `.pi/review/<sanitized call id>.md` (exact path returned in the result)" in the description/README, or keep the raw id for the name and reject ids the sanitizer would change.

---

**Scope reviewed**:
- Files: extensions/review.ts, tests/review.test.ts
- ⚠️ Excluded from review: .pi/review-state.json

_Reviewed 2 file(s) in 619s, 5399.6k tokens ($0.141). Next: address findings, then re-run /review — still-valid findings repeat verbatim, resolved ones stay gone._