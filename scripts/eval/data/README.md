# Eval data — code-review-bench offline

Source: [`code-review-bench/code-review-bench`](https://huggingface.co/datasets/code-review-bench/code-review-bench) (CC-BY-4.0), offline split — 136 expert-curated golden issues over 50 real PRs from cal.com, Discourse, Grafana, Keycloak, and Sentry. The benchmark extends [Greptile's public 50-PR set](https://www.greptile.com/benchmarks) as refined by [Augment](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results).

Files:

- `crb-offline-issues.json` — the golden issues (converted once from `offline_golden_issues.parquet`)
- `diffs/*.diff` — each PR's diff, fetched once from the public GitHub API (`Accept: application/vnd.github.diff`)

Refresh (requires `pyarrow` and network; the datasets-server JSON endpoint is broken for this split):

```sh
curl -sL "https://huggingface.co/datasets/code-review-bench/code-review-bench/resolve/main/offline_golden_issues.parquet" -o /tmp/offline.parquet
python3 -c "import pyarrow.parquet as pq, json; t=pq.read_table('/tmp/offline.parquet'); print(json.dumps([{c:t.column(c)[i].as_py() for c in t.column_names} for i in range(t.num_rows)]))" > crb-offline-issues.json
# then re-fetch diffs for any new pr_urls: curl -H "Accept: application/vnd.github.diff" https://api.github.com/repos/{owner}/{repo}/pulls/{n}
```
