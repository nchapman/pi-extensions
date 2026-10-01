/**
 * Shared benchmark machinery — side-effect free on purpose: both bench
 * variants import from here, so this file must never register tests (an
 * importable describe would silently run the other benchmark in every
 * invocation). Pure functions over RecallChunk[] only.
 */

import { tokenize, type RecallChunk } from "../extensions/recall";

/**
 * pi scopes sessions to the project cwd: the directory name is the cwd's
 * non-alphanumeric runs collapsed to "-", stripped, and wrapped in "--" on
 * each side ("/Users/x/Code/proj" -> "--Users-x-Code-proj--"; verified against
 * the real session dirs). Derived from cwd so benchmarks target this checkout
 * on any machine; BENCH_DIR overrides.
 */
export function projectSessionDir(cwd: string, home: string, join: (...parts: string[]) => string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return join(home, ".pi", "agent", "sessions", `--${slug}--`);
}

/** Grep-able token: identifiers, paths, versions — anything you'd type into a keyword search. */
export function isGreppy(t: string): boolean {
  return t.includes("_") || t.includes("/") || /\d/.test(t) || /^[a-z]+[A-Z]/.test(t) || t.length >= 7;
}

/** Description = the chunk with every grep-able token masked to prose placeholders. */
export function maskToProse(text: string): string {
  return text
    .replace(/`[^`\n]*`|"([^"\\\n]|\\.)*"/g, (s) => (/[/.]/.test(s) ? "the file" : "the name"))
    .replace(/\b[\w.-]+\/[\w./-]+\b/g, "the file")
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, "the setting")
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, "the setting")
    .replace(/\b\d[\d.,]*\b/g, "several")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export interface Target {
  chunk: RecallChunk;
  description: string;
  queries: string[];
}

/**
 * Deterministic target sampling shared by every bench variant: one chunk per
 * entry, prose-maskable and keyword-rich enough to query, even-strided across
 * eligibility order (≈ corpus/recency order) so the sample spans the horizon.
 */
export function sampleTargets(corpus: RecallChunk[], wantTargets: number): Target[] {
  const df = new Map<string, number>();
  for (const c of corpus) for (const t of new Set(tokenize(c.text))) df.set(t, (df.get(t) ?? 0) + 1);
  const eligible: Target[] = [];
  const seenEntries = new Set<string>();
  for (const c of corpus) {
    if (seenEntries.has(c.ref) || c.text.length < 240) continue;
    seenEntries.add(c.ref);
    const description = maskToProse(c.text);
    if (description.length < 120) continue;
    const toks = [...new Set(tokenize(c.text))]
      .filter(isGreppy)
      .map((t) => ({ t, rare: 1 / (df.get(t) ?? 1) }))
      .sort((a, b) => b.rare - a.rare)
      .slice(0, 6)
      .map((x) => x.t);
    if (toks.length < 4) continue;
    eligible.push({
      chunk: c,
      description,
      queries: [toks.slice(0, 2).join(" "), toks.slice(2, 4).join(" "), toks.slice(4, 6).join(" ")],
    });
  }
  const step = Math.max(1, Math.floor(eligible.length / wantTargets));
  return eligible.filter((_, i) => i % step === 0).slice(0, wantTargets);
}

export interface Metrics {
  hit1: number;
  hit5: number;
  mrr10: number;
}

export function metrics(ranks: number[]): Metrics {
  const n = ranks.length || 1;
  return {
    hit1: ranks.filter((r) => r === 1).length / n,
    hit5: ranks.filter((r) => r >= 1 && r <= 5).length / n,
    mrr10: ranks.reduce((s, r) => s + (r >= 1 && r <= 10 ? 1 / r : 0), 0) / n,
  };
}

export function fmt(m: Metrics): string {
  return `Hit@1 ${(m.hit1 * 100).toFixed(0).padStart(3)}%  Hit@5 ${(m.hit5 * 100).toFixed(0).padStart(3)}%  MRR@10 ${m.mrr10.toFixed(3)}`;
}
