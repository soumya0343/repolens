import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { API_BASE_URL } from "../lib/apiConfig";
import Tooltip from "../components/Tooltip";

const authHdr = () => ({ Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` });

async function apiFetch<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: authHdr() });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

interface FlakyTest {
  ci_run_id: number;
  run_name: string;
  head_sha: string;
  conclusion: string;
  flakiness_prob: number;
  total_errors: number;
  failure_signatures: { template: string; count: number }[];
}

interface CIStats {
  pipeline_status: string;
  total_duration_seconds: number;
  test_coverage: number;
  coverage_delta: number;
  unit_tests_passed: number;
  unit_tests_total: number;
  unit_duration_seconds: number;
  unit_flaky_count: number;
  integration_tests_passed: number;
  integration_tests_total: number;
  integration_duration_seconds: number;
  integration_failures: number;
  branch: string;
  head_sha: string;
  run_started_at: string;
  job_log: string[];
}

function fmtDuration(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function timeAgo(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "18px 20px",
};

interface WorkflowCheck {
  has_workflows: boolean;
  owner: string;
  name: string;
}

const YAML_TEMPLATES: { label: string; lang: string; yaml: string }[] = [
  {
    label: "Node.js",
    lang: "node",
    yaml: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test`,
  },
  {
    label: "Python",
    lang: "python",
    yaml: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - run: pytest`,
  },
  {
    label: "Go",
    lang: "go",
    yaml: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: stable }
      - run: go test ./...`,
  },
];

export default function CITests() {
  const { repoId } = useParams<{ repoId: string }>();
  const [stats, setStats] = useState<CIStats | null>(null);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workflowCheck, setWorkflowCheck] = useState<WorkflowCheck | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncDone, setResyncDone] = useState(false);
  const [copiedLang, setCopiedLang] = useState<string | null>(null);
  const [activeTemplate, setActiveTemplate] = useState(0);

  useEffect(() => {
    if (!repoId) return;
    Promise.all([
      apiFetch<CIStats>(`${API_BASE_URL}/repos/${repoId}/ci/stats`),
      apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
    ]).then(([s, f]) => {
      setStats(s);
      setFlaky(Array.isArray(f) ? f : []);
      setLoading(false);
      if (!s) {
        apiFetch<WorkflowCheck>(`${API_BASE_URL}/repos/${repoId}/ci/workflow-check`)
          .then(wc => setWorkflowCheck(wc));
      }
    });
  }, [repoId]);

  async function triggerResync() {
    if (!repoId || resyncing) return;
    setResyncing(true);
    await fetch(`${API_BASE_URL}/repos/${repoId}/backfill`, { method: "POST", headers: authHdr() });
    setResyncing(false);
    setResyncDone(true);
  }

  function copyYaml(yaml: string, lang: string) {
    navigator.clipboard.writeText(yaml);
    setCopiedLang(lang);
    setTimeout(() => setCopiedLang(null), 2000);
  }

  const statusColor =
    stats?.pipeline_status === "success"
      ? "var(--accent)"
      : stats?.pipeline_status === "failure"
      ? "var(--danger)"
      : "var(--warning)";

  const statusLabel =
    stats?.pipeline_status === "success"
      ? "PASSED ✓"
      : stats?.pipeline_status === "failure"
      ? "FAILED ✗"
      : (stats?.pipeline_status ?? "UNKNOWN").toUpperCase();

  if (!loading && !stats) {
    const ghOwner = workflowCheck?.owner;
    const ghName = workflowCheck?.name;
    const hasWorkflows = workflowCheck?.has_workflows;
    const actionsUrl = ghOwner && ghName ? `https://github.com/${ghOwner}/${ghName}/actions` : null;

    return (
      <Layout activeNav="ci" repoId={repoId}>
        <div style={{ padding: "32px 36px", maxWidth: 860, overflowY: "auto", height: "100%", boxSizing: "border-box" }}>

          {/* Status banner */}
          <div style={{ ...card, marginBottom: 24, display: "flex", alignItems: "center", gap: 16, borderColor: hasWorkflows ? "var(--warning)" : "var(--border)" }}>
            <div style={{ fontSize: 32 }}>{hasWorkflows ? "⏳" : "⚙️"}</div>
            <div>
              <div style={{ fontFamily: "var(--heading)", fontSize: 18, fontWeight: 700, color: "var(--text-h)", marginBottom: 4 }}>
                {hasWorkflows ? "Workflows Found — No Runs Yet" : "No CI Pipeline Detected"}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
                {hasWorkflows
                  ? "GitHub Actions workflows exist in .github/workflows but haven't run yet, or RepoLens hasn't ingested any runs. Try resyncing below."
                  : "No GitHub Actions workflows found. Add one to start tracking build status, test coverage, and flaky tests here."}
              </div>
            </div>
          </div>

          {/* Action row */}
          <div style={{ display: "flex", gap: 12, marginBottom: 32, flexWrap: "wrap" }}>
            {actionsUrl && (
              <a href={actionsUrl} target="_blank" rel="noreferrer" style={{
                background: "var(--accent)", color: "#000", borderRadius: 4, padding: "8px 16px",
                fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, textDecoration: "none", letterSpacing: "0.05em",
              }}>
                VIEW ACTIONS TAB →
              </a>
            )}
            <button
              onClick={triggerResync}
              disabled={resyncing || resyncDone}
              style={{
                background: "transparent", border: "1px solid var(--border-bright)", color: resyncDone ? "var(--accent)" : "var(--text)",
                borderRadius: 4, padding: "8px 16px", fontFamily: "var(--mono)", fontSize: 12, cursor: resyncing || resyncDone ? "default" : "pointer",
                letterSpacing: "0.05em", opacity: resyncing ? 0.6 : 1,
              }}
            >
              {resyncDone ? "✓ RESYNC QUEUED" : resyncing ? "RESYNCING…" : "↻ RESYNC CI DATA"}
            </button>
            <a href="https://docs.github.com/en/actions/quickstart" target="_blank" rel="noreferrer" style={{
              background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)",
              borderRadius: 4, padding: "8px 16px", fontFamily: "var(--mono)", fontSize: 12, textDecoration: "none", letterSpacing: "0.05em",
            }}>
              ACTIONS DOCS
            </a>
          </div>

          {/* Quick-start templates */}
          {!hasWorkflows && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 14 }}>
                QUICK-START TEMPLATES
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {YAML_TEMPLATES.map((t, i) => (
                  <button key={t.lang} onClick={() => setActiveTemplate(i)} style={{
                    background: activeTemplate === i ? "var(--accent-bg)" : "transparent",
                    border: `1px solid ${activeTemplate === i ? "var(--accent-border)" : "var(--border)"}`,
                    color: activeTemplate === i ? "var(--accent)" : "var(--text-muted)",
                    borderRadius: 4, padding: "5px 14px", fontFamily: "var(--mono)", fontSize: 12, cursor: "pointer",
                  }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div style={{ position: "relative" }}>
                <pre style={{
                  background: "var(--code-bg)", border: "1px solid var(--border)", borderRadius: 6,
                  padding: "16px 16px 16px 16px", fontFamily: "var(--mono)", fontSize: 12,
                  color: "var(--text)", margin: 0, overflow: "auto", lineHeight: 1.7,
                }}>
                  {YAML_TEMPLATES[activeTemplate].yaml}
                </pre>
                <button
                  onClick={() => copyYaml(YAML_TEMPLATES[activeTemplate].yaml, YAML_TEMPLATES[activeTemplate].lang)}
                  style={{
                    position: "absolute", top: 10, right: 10, background: "var(--surface)",
                    border: "1px solid var(--border-bright)", color: copiedLang === YAML_TEMPLATES[activeTemplate].lang ? "var(--accent)" : "var(--text-muted)",
                    borderRadius: 4, padding: "4px 10px", fontFamily: "var(--mono)", fontSize: 11, cursor: "pointer",
                  }}
                >
                  {copiedLang === YAML_TEMPLATES[activeTemplate].lang ? "✓ COPIED" : "COPY"}
                </button>
              </div>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginTop: 8 }}>
                Save to <span style={{ color: "var(--accent)" }}>.github/workflows/ci.yml</span> and push to trigger first run.
              </div>
            </div>
          )}

          {/* Ghost preview of what you'd see */}
          <div>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 14 }}>
              WHAT YOU'LL SEE HERE
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 12, opacity: 0.35 }}>
              {[["PIPELINE STATUS", "PASSED ✓"], ["TOTAL DURATION", "2m 34s"], ["TEST COVERAGE", "82.4%"]].map(([label, val]) => (
                <div key={label} style={{ ...card }}>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em" }}>{label}</div>
                  <div style={{ color: "var(--text-h)", fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700 }}>{val}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, opacity: 0.35 }}>
              {[["Unit Tests", "47/47 pass"], ["Integration Tests", "12/12 pass"]].map(([label, pass]) => (
                <div key={label} style={{ ...card }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "var(--text-h)", fontWeight: 600, fontSize: 14 }}>{label}</span>
                    <span style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)", color: "var(--accent)", borderRadius: 3, padding: "2px 8px", fontFamily: "var(--mono)", fontSize: 11 }}>{pass}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </Layout>
    );
  }

  return (
    <Layout activeNav="ci" repoId={repoId}>
      <div style={{ padding: "32px 36px", maxWidth: 1100, overflowY: "auto", height: "100%", boxSizing: "border-box" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>
                branch:
              </span>
              <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12 }}>
                {stats?.branch ?? "master"}
              </span>
              <span style={{ color: "var(--border-bright)" }}>›</span>
              <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>
                {stats?.head_sha?.slice(0, 7) ?? "—"}
              </span>
              {stats?.run_started_at && (
                <>
                  <span style={{ color: "var(--border-bright)" }}>›</span>
                  <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>
                    {timeAgo(stats.run_started_at)}
                  </span>
                </>
              )}
            </div>
            <h1 style={{ fontFamily: "var(--heading)", fontSize: 28, fontWeight: 700, color: "var(--text-h)", margin: 0, letterSpacing: "-0.5px" }}>
              CI Pipeline Execution
            </h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0", lineHeight: 1.5, maxWidth: 520 }}>
              Live view of your build pipeline — test coverage, duration, and flaky tests that pass sometimes and fail others for no obvious reason.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={{
              background: "transparent",
              border: "1px solid var(--border-bright)",
              color: "var(--text)",
              borderRadius: 4,
              padding: "8px 16px",
              fontFamily: "var(--mono)",
              fontSize: 12,
              cursor: "pointer",
              letterSpacing: "0.05em",
            }}>
              CANCEL BUILD
            </button>
            <button style={{
              background: "var(--accent)",
              border: "none",
              color: "#000",
              borderRadius: 4,
              padding: "8px 16px",
              fontFamily: "var(--mono)",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              letterSpacing: "0.05em",
            }}>
              RE-RUN JOBS
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em" }}>PIPELINE STATUS</div>
            <div style={{ color: statusColor, fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700 }}>
              {loading ? "—" : statusLabel}
            </div>
          </div>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em" }}>TOTAL DURATION</div>
            <div style={{ color: "var(--text-h)", fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700 }}>
              {loading ? "—" : stats?.total_duration_seconds != null ? fmtDuration(stats.total_duration_seconds) : "—"}
            </div>
          </div>
          <div style={{ ...card }}>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 4 }}>TEST COVERAGE <Tooltip text="Percentage of your code that is exercised by automated tests. Higher is better — low coverage means bugs can hide undetected." position="bottom" /></div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ color: "var(--text-h)", fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700 }}>
                {loading ? "—" : stats?.test_coverage != null ? `${stats.test_coverage.toFixed(1)}%` : "—"}
              </span>
              {stats?.coverage_delta != null && (
                <span style={{ color: stats.coverage_delta >= 0 ? "var(--accent)" : "var(--danger)", fontFamily: "var(--mono)", fontSize: 13 }}>
                  {stats.coverage_delta >= 0 ? "+" : ""}{stats.coverage_delta.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Test Breakdown */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 14 }}>TEST BREAKDOWN</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {/* Unit Tests */}
            <div style={{ ...card }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ color: "var(--text-h)", fontWeight: 600, fontSize: 15 }}>Unit Tests</span>
                <span style={{
                  background: "var(--accent-bg)",
                  border: "1px solid var(--accent-border)",
                  color: "var(--accent)",
                  borderRadius: 3,
                  padding: "2px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}>
                  {loading ? "—" : stats ? `${stats.unit_tests_passed}/${stats.unit_tests_total} pass` : "—"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 24 }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4 }}>EXECUTION TIME</div>
                  <div style={{ color: "var(--text)", fontFamily: "var(--mono)", fontSize: 14 }}>
                    {stats?.unit_duration_seconds != null ? fmtDuration(stats.unit_duration_seconds) : "—"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4 }}>FLAKY TESTS</div>
                  <div style={{ color: (stats?.unit_flaky_count ?? 0) > 0 ? "var(--warning)" : "var(--text)", fontFamily: "var(--mono)", fontSize: 14 }}>
                    {stats?.unit_flaky_count ?? 0}
                  </div>
                </div>
              </div>
            </div>
            {/* Integration Tests */}
            <div style={{ ...card }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ color: "var(--text-h)", fontWeight: 600, fontSize: 15 }}>Integration Tests</span>
                <span style={{
                  background: "var(--accent-bg)",
                  border: "1px solid var(--accent-border)",
                  color: "var(--accent)",
                  borderRadius: 3,
                  padding: "2px 8px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                }}>
                  {loading ? "—" : stats ? `${stats.integration_tests_passed}/${stats.integration_tests_total} pass` : "—"}
                </span>
              </div>
              <div style={{ display: "flex", gap: 24 }}>
                <div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4 }}>EXECUTION TIME</div>
                  <div style={{ color: "var(--text)", fontFamily: "var(--mono)", fontSize: 14 }}>
                    {stats?.integration_duration_seconds != null ? fmtDuration(stats.integration_duration_seconds) : "—"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 4 }}>FAILURES</div>
                  <div style={{ color: (stats?.integration_failures ?? 0) > 0 ? "var(--danger)" : "var(--text)", fontFamily: "var(--mono)", fontSize: 14 }}>
                    {stats?.integration_failures ?? 0}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Job Log */}
        <div style={{ marginBottom: 28 }}>
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, cursor: "pointer" }}
            onClick={() => setLogExpanded(p => !p)}
          >
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em" }}>JOB LOG</div>
            <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12 }}>
              {logExpanded ? "▲ COLLAPSE" : "▼ EXPAND"}
            </span>
          </div>
          <div style={{
            background: "var(--code-bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "14px 16px",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--text)",
            maxHeight: logExpanded ? 400 : 120,
            overflow: "auto",
            transition: "max-height 0.2s ease",
            lineHeight: "1.7",
          }}>
            {(stats?.job_log ?? []).length === 0
              ? <div style={{ color: "var(--text-muted)" }}>no log output</div>
              : (stats?.job_log ?? []).map((line, i) => (
                <div key={i} style={{ color: line.startsWith("$") ? "var(--accent)" : line.startsWith("FAIL") ? "var(--danger)" : "var(--text)" }}>
                  {line}
                </div>
              ))}
          </div>
        </div>

        {/* Flaky CI Runs */}
        <div>
          <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>FLAKY CI RUNS <Tooltip text="Tests or jobs that produce inconsistent results — passing on one run, failing on the next with no code change. Flaky tests erode trust in your CI pipeline." position="right" /></div>
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["RUN NAME", "SHA", "CONCLUSION", "FLAKINESS", "ERRORS", "TOP FAILURE"].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-muted)", fontSize: 11, fontWeight: 500, letterSpacing: "0.06em" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {h}
                        {h === "FLAKINESS" && <Tooltip text="Probability (0–100%) that this CI run is flaky. Calculated from repeated failure patterns on the same code." position="top" />}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flaky.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: "20px 16px", color: "var(--text-muted)", textAlign: "center" }}>
                      {loading ? "loading…" : "no flaky runs detected"}
                    </td>
                  </tr>
                ) : flaky.map((row) => {
                  const conclusionColor =
                    row.conclusion === "success" ? "var(--accent)"
                    : row.conclusion === "failure" ? "var(--danger)"
                    : "var(--warning)";
                  const topFailure = row.failure_signatures?.[0]?.template ?? "—";
                  return (
                    <tr key={row.ci_run_id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 16px", color: "var(--text-h)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.run_name}
                      </td>
                      <td style={{ padding: "10px 16px", color: "var(--text-muted)" }}>
                        {row.head_sha?.slice(0, 7) ?? "—"}
                      </td>
                      <td style={{ padding: "10px 16px" }}>
                        <span style={{ color: conclusionColor, textTransform: "uppercase", fontSize: 11 }}>
                          {row.conclusion}
                        </span>
                      </td>
                      <td style={{ padding: "10px 16px", minWidth: 120 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{
                              height: "100%",
                              width: `${(row.flakiness_prob * 100).toFixed(0)}%`,
                              background: row.flakiness_prob > 0.6 ? "var(--danger)" : row.flakiness_prob > 0.3 ? "var(--warning)" : "var(--accent)",
                              borderRadius: 2,
                            }} />
                          </div>
                          <span style={{ color: "var(--text-muted)", fontSize: 11, minWidth: 32 }}>
                            {(row.flakiness_prob * 100).toFixed(0)}%
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: "10px 16px", color: row.total_errors > 0 ? "var(--danger)" : "var(--text-muted)" }}>
                        {row.total_errors}
                      </td>
                      <td style={{ padding: "10px 16px", color: "var(--text-muted)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {topFailure}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </Layout>
  );
}
