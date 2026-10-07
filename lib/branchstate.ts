/**
 * Shared branch-state scan for extensions that persist durable state via
 * `pi.appendEntry(customType, data)`.
 *
 * Why custom entries (not tool-result details): pi's own state table says
 * tool-result `details` are for render/tool state, while durable data excluded
 * from model context belongs in custom entries — the same pattern pi's
 * built-in codemode store uses (append on every write, scan the branch on
 * read). Entries ride the branch, so rewind/resume/reload all land on the
 * state of the branch position with zero filesystem and no desync; they are
 * invisible to the LLM, so storage never pollutes context.
 *
 * Every writer appends the FULL compact state (not a delta): the newest valid
 * entry alone reconstructs everything, so any entry being the last survivor of
 * a compaction is enough — no replay ordering to get wrong.
 */

/** Loose branch-entry shape so scans accept both SessionEntry[] and test doubles. */
export interface BranchEntryLike {
  type?: string;
  customType?: unknown;
  data?: unknown;
}

/**
 * Newest custom state entry of `customType` whose data passes `validate`,
 * with its index (-1 when none). Malformed entries never win — the scan keeps
 * the last valid one, so a corrupted write degrades to the prior state.
 */
export function scanCustomState<T>(
  branch: BranchEntryLike[],
  customType: string,
  validate: (data: unknown) => data is T,
): { data: T | null; index: number } {
  let state: T | null = null;
  let index = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== customType) continue;
    if (!validate(entry.data)) continue;
    state = entry.data;
    index = i;
  }
  return { data: state, index };
}
