/** The Finding model: lenient parsing of finder output, deterministic merge
 * (worst severity wins), and verifier verdicts — absent or unusable verdicts
 * fail open to "unverified". */

// ---------------------------------------------------------------------------
// Findings: schema, parsing, merge, verdicts
// ---------------------------------------------------------------------------

export type Severity = "critical" | "important" | "suggestion";
export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, important: 1, suggestion: 2 };

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  title: string;
  detail: string;
  recommendation?: string;
  /** Lenses that produced the finding (merged findings keep all origins). */
  lenses: string[];
}

/** The last fenced ```json block that parses as an array; null otherwise. */
function lastJsonArray(text: string): unknown[] | null {
  const matches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // keep looking
    }
  }
  return null;
}

const SEVERITIES = new Set<Severity>(["critical", "important", "suggestion"]);
const FIELD_MAX = 2_000;

function boundedString(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s.length > FIELD_MAX ? s.slice(0, FIELD_MAX) + "…" : s;
}

/**
 * Parse a finder's findings from its final message. Lenient: takes the last
 * JSON array block, coerces fields, and drops structurally invalid entries
 * (no file, empty title) rather than failing the whole finder.
 */
export function parseFindings(text: string, lens: string): Finding[] {
  const arr = lastJsonArray(text);
  if (!arr) return [];
  const out: Finding[] = [];
  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const file = boundedString(r.file);
    const title = boundedString(r.title);
    if (!file || !title) continue;
    const severity = SEVERITIES.has(r.severity as Severity) ? (r.severity as Severity) : "suggestion";
    const lineRaw = Number(r.line);
    out.push({
      file,
      line: Number.isFinite(lineRaw) && lineRaw >= 1 ? Math.floor(lineRaw) : undefined,
      severity,
      title,
      detail: boundedString(r.detail),
      recommendation: boundedString(r.recommendation) || undefined,
      lenses: [lens],
    });
  }
  return out;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] <= SEVERITY_ORDER[b] ? a : b;
}

function severityThenLocation(a: Finding, b: Finding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.file.localeCompare(b.file) ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

/**
 * Merge finder outputs: same-file findings whose lines are near each other or
 * whose normalized titles match are one issue seen by two lenses — keep one,
 * take the worst severity (a merged verdict is never less alarming than its
 * inputs), and record every lens that found it.
 */
export function mergeFindings(lists: Finding[][]): Finding[] {
  const all = lists.flat();
  const byFile = new Map<string, Finding[]>();
  for (const f of all) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const merged: Finding[] = [];
  for (const list of byFile.values()) {
    for (const f of list) {
      const dupe = merged.find((m) => {
        if (m.file !== f.file) return false;
        const sameTitle = normalizeTitle(m.title) === normalizeTitle(f.title);
        // Proximity needs both line numbers; without them only a title match merges.
        const near = m.line !== undefined && f.line !== undefined && Math.abs(m.line - f.line) <= 3;
        return sameTitle || near;
      });
      if (dupe) {
        dupe.severity = maxSeverity(dupe.severity, f.severity);
        if (!dupe.lenses.includes(f.lenses[0])) dupe.lenses.push(f.lenses[0]);
        if (!dupe.recommendation && f.recommendation) dupe.recommendation = f.recommendation;
        if (dupe.detail.length < f.detail.length) dupe.detail = f.detail;
      } else {
        merged.push({ ...f, lenses: [...f.lenses] });
      }
    }
  }
  return merged.sort(severityThenLocation);
}

export interface Verdict {
  id: number;
  verdict: "confirmed" | "rejected" | "downgraded";
  severity?: Severity;
  reason: string;
}

/** Parse the verifier's verdicts; null when absent or unusable (fail open). */
export function parseVerdicts(text: string): Verdict[] | null {
  const arr = lastJsonArray(text);
  if (!arr) return null;
  const out: Verdict[] = [];
  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = Number(r.id);
    const verdict = r.verdict;
    if (!Number.isFinite(id) || (verdict !== "confirmed" && verdict !== "rejected" && verdict !== "downgraded")) {
      continue;
    }
    out.push({
      id: Math.floor(id),
      verdict,
      severity: SEVERITIES.has(r.severity as Severity) ? (r.severity as Severity) : undefined,
      reason: boundedString(r.reason),
    });
  }
  // A non-empty array that yielded no valid verdicts is a broken verifier, not
  // a clean pass — treat it as unparseable so findings are labeled unverified.
  return arr.length > 0 && out.length === 0 ? null : out;
}

export interface VerifiedBundle {
  findings: Finding[];
  /** Candidates the verifier rejected, with reasons (for the report footer). */
  rejected: Array<{ finding: Finding; reason: string }>;
  /** True when the verify stage produced no usable verdicts. */
  unverified: boolean;
}

/** Apply verdicts to numbered candidates. Candidates without a verdict stay. */
export function applyVerdicts(candidates: Finding[], verdicts: Verdict[] | null): VerifiedBundle {
  if (verdicts === null) {
    return { findings: candidates, rejected: [], unverified: candidates.length > 0 };
  }
  const byId = new Map<number, Verdict>();
  for (const v of verdicts) {
    // A 0-based or hallucinated id must not re-target another candidate.
    if (v.id >= 1 && v.id <= candidates.length) byId.set(v.id, v);
  }
  const findings: Finding[] = [];
  const rejected: VerifiedBundle["rejected"] = [];
  candidates.forEach((finding, i) => {
    const v = byId.get(i + 1);
    if (!v) {
      findings.push(finding);
      return;
    }
    if (v.verdict === "rejected") {
      rejected.push({ finding, reason: v.reason });
      return;
    }
    if (v.verdict === "downgraded" && v.severity) finding.severity = v.severity;
    findings.push(finding);
  });
  findings.sort(severityThenLocation);
  return { findings, rejected, unverified: false };
}
