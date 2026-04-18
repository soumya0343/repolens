import { useEffect, useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { API_BASE_URL } from "../lib/apiConfig";
import Layout from "../components/Layout";

interface GithubRepo {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  updated_at?: string;
  language?: string;
  stargazers_count?: number;
}

interface ConnectedRepo {
  id: string;
  name: string;
  owner: string;
  synced_at?: string;
}

function timeAgo(iso?: string) {
  if (!iso) return null;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

export default function Setup() {
  const [available, setAvailable] = useState<GithubRepo[]>([]);
  const [connected, setConnected] = useState<ConnectedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "connected" | "available">("all");
  const navigate = useNavigate();

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) { navigate("/"); return; }
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      axios.get(`${API_BASE_URL}/repos/`, { headers }),
      axios.get(`${API_BASE_URL}/repos/github/available`, { headers }),
    ]).then(([c, a]) => {
      setConnected(c.data ?? []);
      setAvailable(a.data ?? []);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, [navigate]);

  function findConnected(repo: GithubRepo) {
    return connected.find(c => c.owner === repo.owner.login && c.name === repo.name);
  }

  async function handleConnect(repo: GithubRepo) {
    const token = localStorage.getItem("token");
    setConnecting(repo.id);
    try {
      const res = await axios.post(`${API_BASE_URL}/repos/`, {
        github_id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
      }, { headers: { Authorization: `Bearer ${token}` } });
      const connRes = await axios.get(`${API_BASE_URL}/repos/`, { headers: { Authorization: `Bearer ${token}` } });
      setConnected(connRes.data);
      const newId = res.data?.repo_id ?? connRes.data.find((r: ConnectedRepo) => r.owner === repo.owner.login && r.name === repo.name)?.id;
      if (newId) navigate(`/repo/${newId}`);
    } catch (err) {
      console.error(err);
    } finally {
      setConnecting(null);
    }
  }

  const filtered = available.filter(r => {
    const q = search.toLowerCase();
    const matchSearch = !q || `${r.owner.login}/${r.name}`.toLowerCase().includes(q);
    const conn = findConnected(r);
    if (filter === "connected") return matchSearch && !!conn;
    if (filter === "available") return matchSearch && !conn;
    return matchSearch;
  });

  const connectedCount = available.filter(r => !!findConnected(r)).length;

  return (
    <Layout activeNav="repositories" repoId={undefined}>
      {/* Top bar */}
      <header style={{
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: "1.5rem",
        padding: "0 2rem",
        height: 52,
        position: "sticky",
        top: 0,
        zIndex: 10,
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: "var(--heading)",
          fontSize: "0.85rem",
          fontWeight: 700,
          color: "var(--accent)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}>
          REPO_LENS
        </span>

        {/* Search */}
        <input
          type="text"
          placeholder="SEARCH_REPOS..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            maxWidth: 320,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            color: "var(--text)",
            fontFamily: "var(--mono)",
            fontSize: "0.72rem",
            letterSpacing: "0.06em",
            padding: "0.4rem 0.75rem",
            outline: "none",
            flex: "0 0 auto",
            width: 240,
          }}
          onFocus={e => (e.target.style.borderColor = "var(--accent-border)")}
          onBlur={e => (e.target.style.borderColor = "var(--border)")}
        />

        {/* Filter tabs */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "connected", "available"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: filter === f ? "var(--accent-bg)" : "transparent",
                border: `1px solid ${filter === f ? "var(--accent-border)" : "var(--border)"}`,
                color: filter === f ? "var(--accent)" : "var(--text-muted)",
                borderRadius: 3,
                padding: "3px 10px",
                fontFamily: "var(--mono)",
                fontSize: "0.68rem",
                cursor: "pointer",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {f}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "1.5rem" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: "0.72rem", color: "var(--text-muted)", letterSpacing: "0.08em" }}>
            {loading ? "—" : `${connectedCount}/${available.length} CONNECTED`}
          </span>
        </div>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, padding: "2.5rem 2.5rem 3rem", overflowY: "auto" }}>

        {/* Hero */}
        <div style={{ marginBottom: "2.5rem" }}>
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: "0.7rem",
            color: "var(--accent)",
            letterSpacing: "0.12em",
            marginBottom: "0.6rem",
          }}>
            // REPOSITORIES_
          </div>
          <div style={{ lineHeight: 0.9 }}>
            <div style={{
              fontFamily: "var(--heading)",
              fontSize: "clamp(2.8rem, 6vw, 5rem)",
              fontWeight: 700,
              color: "var(--text-h)",
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
            }}>
              CONNECT
            </div>
            <div style={{
              fontFamily: "var(--heading)",
              fontSize: "clamp(2.8rem, 6vw, 5rem)",
              fontWeight: 700,
              color: "var(--border-bright)",
              textTransform: "uppercase",
              letterSpacing: "-0.02em",
            }}>
              REPOSITORY
            </div>
          </div>
        </div>

        {/* Repo grid */}
        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: "1rem" }}>
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="skeleton" style={{ height: 160, borderRadius: 3 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{
            textAlign: "center", padding: "4rem 2rem",
            color: "var(--text-muted)", fontFamily: "var(--mono)",
            fontSize: "0.78rem", letterSpacing: "0.08em",
          }}>
            NO_REPOS_FOUND //
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: "1rem" }}>
            {filtered.map(repo => {
              const conn = findConnected(repo);
              const isConnecting = connecting === repo.id;
              return (
                <div
                  key={repo.id}
                  style={{
                    background: "var(--surface)",
                    border: `1px solid ${conn ? "var(--accent-border)" : "var(--border)"}`,
                    borderRadius: 3,
                    padding: "1.25rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.9rem",
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = conn ? "var(--accent)" : "var(--border-bright)")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = conn ? "var(--accent-border)" : "var(--border)")}
                >
                  {/* Header row */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <span style={{
                      background: repo.private ? "rgba(255,65,65,0.08)" : "var(--accent-bg)",
                      border: `1px solid ${repo.private ? "rgba(255,65,65,0.2)" : "var(--accent-border)"}`,
                      color: repo.private ? "var(--danger)" : "var(--accent)",
                      borderRadius: 2,
                      padding: "2px 7px",
                      fontFamily: "var(--mono)",
                      fontSize: "0.6rem",
                      letterSpacing: "0.06em",
                    }}>
                      {repo.private ? "PRIVATE" : "PUBLIC"}
                    </span>
                    {conn && (
                      <span style={{
                        display: "flex", alignItems: "center", gap: 5,
                        color: "var(--accent)", fontFamily: "var(--mono)", fontSize: "0.62rem",
                      }}>
                        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
                        CONNECTED
                      </span>
                    )}
                  </div>

                  {/* Name */}
                  <div>
                    <div style={{
                      fontFamily: "var(--mono)", fontSize: "0.65rem",
                      color: "var(--text-muted)", letterSpacing: "0.04em", marginBottom: 3,
                    }}>
                      {repo.owner.login}/
                    </div>
                    <div style={{
                      fontFamily: "var(--heading)", fontSize: "1.35rem",
                      fontWeight: 700, color: "var(--text-h)",
                      textTransform: "uppercase", letterSpacing: "-0.01em", lineHeight: 1.1,
                      wordBreak: "break-word",
                    }}>
                      {repo.name}
                    </div>
                  </div>

                  {/* Meta row */}
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {repo.language && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        {repo.language}
                      </span>
                    )}
                    {repo.stargazers_count != null && repo.stargazers_count > 0 && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        ★ {repo.stargazers_count}
                      </span>
                    )}
                    {repo.updated_at && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                        {timeAgo(repo.updated_at)}
                      </span>
                    )}
                  </div>

                  {/* Action */}
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
                    {conn ? (
                      <button
                        onClick={() => navigate(`/repo/${conn.id}`)}
                        style={{
                          width: "100%",
                          background: "var(--accent-bg)",
                          border: "1px solid var(--accent-border)",
                          color: "var(--accent)",
                          borderRadius: 3,
                          padding: "0.5rem 0",
                          fontFamily: "var(--sans)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          cursor: "pointer",
                        }}
                      >
                        VIEW ANALYSIS →
                      </button>
                    ) : (
                      <button
                        onClick={() => handleConnect(repo)}
                        disabled={isConnecting}
                        style={{
                          width: "100%",
                          background: isConnecting ? "var(--surface-raised)" : "var(--accent)",
                          border: "none",
                          color: isConnecting ? "var(--text-muted)" : "#000",
                          borderRadius: 3,
                          padding: "0.5rem 0",
                          fontFamily: "var(--sans)",
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          cursor: isConnecting ? "default" : "pointer",
                        }}
                      >
                        {isConnecting ? "CONNECTING…" : "[+] CONNECT & ANALYZE"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </Layout>
  );
}
