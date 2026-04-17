import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { API_BASE_URL } from "../lib/apiConfig";

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

export default function CITests() {
  const { repoId } = useParams<{ repoId: string }>();
  const [stats, setStats] = useState<CIStats | null>(null);
  const [flaky, setFlaky] = useState<FlakyTest[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoId) return;
    Promise.all([
      apiFetch<CIStats>(`${API_BASE_URL}/repos/${repoId}/ci/stats`),
      apiFetch<FlakyTest[]>(`${API_BASE_URL}/repos/${repoId}/tests/flaky`),
    ]).then(([s, f]) => {
      setStats(s);
      setFlaky(Array.isArray(f) ? f : []);
      setLoading(false);
    });
  }, [repoId]);

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

  return (
    <Layout activeNav="ci" repoId={repoId}>
      <div style={{ padding: "32px 36px", maxWidth: 1100 }}>

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
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 10, letterSpacing: "0.08em" }}>TEST COVERAGE</div>
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
            {(stats?.job_log ?? [
              "$ git checkout master",
              "$ npm ci",
              "added 1432 packages in 12.4s",
              "$ npm run test:unit",
              "PASS  src/__tests__/auth.test.ts",
              "PASS  src/__tests__/api.test.ts",
              "$ npm run test:integration",
              "PASS  integration/repo.test.ts",
            ]).map((line, i) => (
              <div key={i} style={{ color: line.startsWith("$") ? "var(--accent)" : line.startsWith("FAIL") ? "var(--danger)" : "var(--text)" }}>
                {line}
              </div>
            ))}
          </div>
        </div>

        {/* Flaky CI Runs */}
        <div>
          <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 14 }}>FLAKY CI RUNS</div>
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--mono)", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["RUN NAME", "SHA", "CONCLUSION", "FLAKINESS", "ERRORS", "TOP FAILURE"].map(h => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "var(--text-muted)", fontSize: 11, fontWeight: 500, letterSpacing: "0.06em" }}>
                      {h}
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
