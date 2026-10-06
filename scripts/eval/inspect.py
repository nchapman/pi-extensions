#!/usr/bin/env python3
"""Inspect an eval run's per-PR JSONL: quality x speed view.

Usage: python3 scripts/eval/inspect.py <run.jsonl>

Not a scorer — the judge already matched. This renders what the numbers came
from: per-PR recall, cost and wall time, derived cost-per-caught-issue, and
each missed golden issue next to that PR's finding titles for eyeballing
whether misses were near-misses (a finding gestures at it) or blind spots.
"""

import json
import sys

SEV_RANK = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}


def main(path: str) -> None:
    rows = [json.loads(line) for line in open(path)]
    tot_issues = tot_caught = tot_ch = tot_ch_caught = 0
    tot_findings = tot_unmatched = tot_tokens = tot_ms = 0.0

    print(f"{'PR':<52} {'caught':>7} {'find':>5} {'unm':>4} {'min':>5} {'ktok':>6}")
    for r in rows:
        issues = sorted(r["issues"], key=lambda i: SEV_RANK.get(i["severity"], 9))
        caught = {c[0] for c in r["caught"]}
        used = {c[1] for c in r["caught"]}
        missed = [i for i in issues if i["issue_index"] not in caught]
        key = "/".join(r["prUrl"].rstrip("/").split("/")[-3:])
        mins = r["durationMs"] / 60_000
        ktok = (r.get("totalTokens") or 0) / 1000
        tot_issues += len(issues)
        tot_caught += len(caught)
        tot_findings += len(r["findings"])
        tot_unmatched += len(r["findings"]) - len(used)
        tot_ms += r["durationMs"]
        tot_tokens += ktok
        tot_ch += sum(1 for i in issues if i["severity"] in ("Critical", "High"))
        tot_ch_caught += sum(1 for i in issues if i["severity"] in ("Critical", "High") and i["issue_index"] in caught)
        print(f"{key:<52} {len(caught):>3}/{len(issues):<3} {len(r['findings']):>5} {len(r['findings']) - len(used):>4} {mins:>5.1f} {ktok:>6.0f}")
        if missed:
            for i in missed:
                print(f"  missed [{i['severity']:<8}] {i['comment'][:100]}")
            for f in sorted(r["findings"], key=lambda f: SEV_RANK.get(f["severity"], 9)):
                mark = "*" if any(c[1] == r["findings"].index(f) for c in r["caught"]) else " "
                print(f"   {mark}[{f['severity']:<10}] {f['title'][:95]}")

    prs = len(rows) or 1
    print(f"\nrecall {tot_caught}/{tot_issues} = {tot_caught / tot_issues:.0%}  "
          f"(Crit/High {tot_ch_caught}/{tot_ch} = {tot_ch_caught / tot_ch:.0%})" if tot_ch else "")
    print(f"findings/PR {tot_findings / prs:.1f} (unmatched {tot_unmatched / prs:.1f})  "
          f"time/PR {tot_ms / 60_000 / prs:.1f} min  tokens/PR {tot_tokens / prs:.0f}k")
    if tot_caught:
        print(f"cost of a caught issue: {tot_ms / 60_000 / tot_caught:.1f} min, {tot_tokens / tot_caught:.0f}k tokens")
        print(f"  ( * = finding the judge matched to a golden issue )")


if __name__ == "__main__":
    main(sys.argv[1])
