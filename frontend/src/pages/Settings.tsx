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

const DEFAULT_WEIGHTS = { coupling: 0.25, architecture: 0.20, bus_factor: 0.20, collaboration: 0.15, ci: 0.20 };
const DEFAULT_ALLOWLIST = '{\n  "fingerprints": [],\n  "path_globs": [],\n  "detectors": []\n}';

const card: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "20px 22px",
  marginBottom: 16,
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.1em", marginBottom: 16 }}>
      {children}
    </div>
  );
}

function SaveBtn({ onClick, saving, label, savedLabel = "SAVED ✓" }: { onClick: () => void; saving: boolean; label: string; savedLabel?: string }) {
  const [flash, setFlash] = useState(false);
  async function handle() {
    await onClick();
    setFlash(true);
    setTimeout(() => setFlash(false), 1800);
  }
  return (
    <button
      onClick={handle}
      disabled={saving}
      style={{
        background: flash ? "var(--accent-bg)" : "var(--accent)",
        border: flash ? "1px solid var(--accent-border)" : "none",
        color: flash ? "var(--accent)" : "#000",
        borderRadius: 4,
        padding: "8px 18px",
        fontFamily: "var(--mono)",
        fontSize: 12,
        fontWeight: 700,
        cursor: saving ? "default" : "pointer",
        letterSpacing: "0.05em",
        transition: "all 0.2s",
      }}
    >
      {saving ? "SAVING…" : flash ? savedLabel : label}
    </button>
  );
}

function OutlineBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent",
        border: "1px solid var(--border-bright)",
        color: disabled ? "var(--text-muted)" : "var(--text)",
        borderRadius: 4,
        padding: "8px 16px",
        fontFamily: "var(--mono)",
        fontSize: 12,
        cursor: disabled ? "default" : "pointer",
        letterSpacing: "0.05em",
      }}
    >
      {children}
    </button>
  );
}

export default function Settings() {
  const { repoId } = useParams<{ repoId: string }>();

  // Risk weights
  const [weights, setWeights] = useState<Record<string, number>>(DEFAULT_WEIGHTS);
  const [weightsSaving, setWeightsSaving] = useState(false);

  // Arch policy
  const [archPolicy, setArchPolicy] = useState("");
  const [archError, setArchError] = useState<string | null>(null);
  const [archSaving, setArchSaving] = useState(false);
  const [policyGenerating, setPolicyGenerating] = useState(false);

  // Bot prefs
  const [blockThreshold, setBlockThreshold] = useState(75);
  const [warnOnly, setWarnOnly] = useState(false);
  const [notifSaving, setNotifSaving] = useState(false);

  // LLM
  const [llmProvider, setLlmProvider] = useState<"gemini" | "openai" | "ollama">("gemini");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmSaving, setLlmSaving] = useState(false);

  // Secret allowlist
  const [allowlist, setAllowlist] = useState(DEFAULT_ALLOWLIST);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [allowlistSaving, setAllowlistSaving] = useState(false);

  useEffect(() => {
    if (!repoId) return;
    apiFetch<{ weights?: Record<string, number> }>(`${API_BASE_URL}/repos/${repoId}/risk`).then(r => {
      if (r?.weights) setWeights({ ...DEFAULT_WEIGHTS, ...r.weights });
    });
  }, [repoId]);

  async function saveWeights() {
    if (!repoId) return;
    setWeightsSaving(true);
    const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    const normalized: Record<string, number> = {};
    for (const [k, v] of Object.entries(weights)) normalized[k] = v / total;
    await fetch(`${API_BASE_URL}/repos/${repoId}`, {
      method: "PATCH",
      headers: { ...authHdr(), "Content-Type": "application/json" },
      body: JSON.stringify({ config: { weights_normalized: normalized } }),
    });
    setWeightsSaving(false);
  }

  async function generatePolicy() {
    if (!repoId) return;
    setPolicyGenerating(true);
    try {
      const r = await fetch(`${API_BASE_URL}/repos/${repoId}/policy/generate`, { method: "POST", headers: authHdr() });
      if (r.ok) {
        const data = await r.json();
        setArchPolicy(typeof data.policy === "string" ? data.policy : JSON.stringify(data.policy, null, 2));
      }
    } finally { setPolicyGenerating(false); }
  }

  async function saveArchPolicy() {
    if (!repoId) return;
    setArchError(null);
    try {
      const parsed = JSON.parse(archPolicy);
      setArchSaving(true);
      await fetch(`${API_BASE_URL}/repos/${repoId}`, {
        method: "PATCH",
        headers: { ...authHdr(), "Content-Type": "application/json" },
        body: JSON.stringify({ config: { arch_policy: parsed } }),
      });
    } catch { setArchError("Invalid JSON — fix syntax before saving."); }
    finally { setArchSaving(false); }
  }

  async function saveNotifPrefs() {
    if (!repoId) return;
    setNotifSaving(true);
    await fetch(`${API_BASE_URL}/repos/${repoId}`, {
      method: "PATCH",
      headers: { ...authHdr(), "Content-Type": "application/json" },
      body: JSON.stringify({ config: { block_threshold: blockThreshold, warn_only: warnOnly } }),
    });
    setNotifSaving(false);
  }

  async function saveLLM() {
    if (!repoId) return;
    setLlmSaving(true);
    await fetch(`${API_BASE_URL}/repos/${repoId}`, {
      method: "PATCH",
      headers: { ...authHdr(), "Content-Type": "application/json" },
      body: JSON.stringify({ config: { llm_provider: llmProvider, ...(llmApiKey ? { llm_api_key: llmApiKey } : {}) } }),
    });
    setLlmSaving(false);
  }

  async function saveAllowlist() {
    if (!repoId) return;
    setAllowlistError(null);
    try {
      const parsed = JSON.parse(allowlist);
      setAllowlistSaving(true);
      await fetch(`${API_BASE_URL}/repos/${repoId}`, {
        method: "PATCH",
        headers: { ...authHdr(), "Content-Type": "application/json" },
        body: JSON.stringify({ config: { secret_allowlist: parsed } }),
      });
    } catch { setAllowlistError("Invalid JSON — use fingerprints, path_globs, and detectors arrays."); }
    finally { setAllowlistSaving(false); }
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

  return (
    <Layout activeNav="settings" repoId={repoId}>
      <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ padding: "32px 36px", maxWidth: 780 }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontFamily: "var(--heading)", fontSize: 28, fontWeight: 700, color: "var(--text-h)", margin: "0 0 4px", letterSpacing: "-0.5px" }}>
            Settings
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            Configure risk scoring, architectural policy, bot behaviour, and AI provider.
          </p>
        </div>

        {/* ── Risk Score Weights ── */}
        <div style={card}>
          <SectionLabel>RISK SCORE WEIGHTS</SectionLabel>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 20px" }}>
            Adjust signal contribution to unified risk score. Values auto-normalise to 100%.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 20 }}>
            {Object.entries(weights).map(([k, v]) => {
              const pct = Math.round((v / totalWeight) * 100);
              return (
                <div key={k}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ color: "var(--text)", fontSize: 13, textTransform: "capitalize" }}>
                      {k.replace(/_/g, " ")}
                    </span>
                    <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12 }}>
                      {pct}%
                    </span>
                  </div>
                  <div style={{ position: "relative", height: 4, background: "var(--border)", borderRadius: 2 }}>
                    <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: "var(--accent)", borderRadius: 2, transition: "width 0.15s" }} />
                  </div>
                  <input
                    type="range" min={0} max={100} value={Math.round(v * 100)}
                    onChange={e => setWeights(prev => ({ ...prev, [k]: parseInt(e.target.value) / 100 }))}
                    style={{ width: "100%", marginTop: 6, accentColor: "var(--accent)", cursor: "pointer" }}
                  />
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <SaveBtn onClick={saveWeights} saving={weightsSaving} label="SAVE WEIGHTS" />
            <OutlineBtn onClick={() => setWeights(DEFAULT_WEIGHTS)}>RESET</OutlineBtn>
          </div>
        </div>

        {/* ── Architectural Policy ── */}
        <div style={card}>
          <SectionLabel>ARCHITECTURAL POLICY</SectionLabel>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 14px" }}>
            Define layer boundary rules for ArchSentinel. JSON format.
          </p>
          <div style={{ marginBottom: 12 }}>
            <OutlineBtn onClick={generatePolicy} disabled={policyGenerating}>
              {policyGenerating ? "GENERATING…" : "⚡ GENERATE FROM REPO"}
            </OutlineBtn>
          </div>
          <textarea
            value={archPolicy}
            onChange={e => { setArchPolicy(e.target.value); setArchError(null); }}
            placeholder={'{\n  "layers": { "domain": ["src/domain"], "infra": ["src/db"] },\n  "rules": [{ "from": "domain", "to": "infra", "allow": false }]\n}'}
            rows={10}
            style={{
              width: "100%",
              background: "var(--code-bg)",
              border: `1px solid ${archError ? "var(--danger)" : "var(--border)"}`,
              borderRadius: 5,
              color: "var(--accent)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              padding: "12px 14px",
              resize: "vertical",
              outline: "none",
              lineHeight: 1.7,
              boxSizing: "border-box",
            }}
          />
          {archError && (
            <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 12, marginTop: 6 }}>✕ {archError}</div>
          )}
          <div style={{ marginTop: 12 }}>
            <SaveBtn onClick={saveArchPolicy} saving={archSaving} label="SAVE POLICY" />
          </div>
        </div>

        {/* ── Bot Notification Prefs ── */}
        <div style={card}>
          <SectionLabel>BOT NOTIFICATION PREFERENCES</SectionLabel>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 20px" }}>
            Configure GitHub bot behaviour when PR exceeds risk threshold.
          </p>
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ color: "var(--text)", fontSize: 13 }}>Block merge above score</span>
              <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12 }}>{blockThreshold}/100</span>
            </div>
            <div style={{ position: "relative", height: 4, background: "var(--border)", borderRadius: 2, marginBottom: 6 }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${blockThreshold}%`, background: blockThreshold >= 80 ? "var(--danger)" : blockThreshold >= 60 ? "var(--warning)" : "var(--accent)", borderRadius: 2 }} />
            </div>
            <input
              type="range" min={30} max={100} value={blockThreshold}
              onChange={e => setBlockThreshold(parseInt(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)", cursor: "pointer" }}
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ color: "var(--text)", fontSize: 13, marginBottom: 10 }}>Behaviour above threshold</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { val: false, label: "Fail check run", desc: "blocks merge" },
                { val: true, label: "Warn only", desc: "post comment, merge still allowed" },
              ].map(opt => (
                <label key={String(opt.val)} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div
                    onClick={() => setWarnOnly(opt.val)}
                    style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: `2px solid ${warnOnly === opt.val ? "var(--accent)" : "var(--border-bright)"}`,
                      background: warnOnly === opt.val ? "var(--accent)" : "transparent",
                      flexShrink: 0,
                      cursor: "pointer",
                    }}
                  />
                  <span style={{ color: "var(--text)", fontSize: 13 }}>
                    {opt.label}
                    <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 12 }}>— {opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <SaveBtn onClick={saveNotifPrefs} saving={notifSaving} label="SAVE PREFERENCES" />
        </div>

        {/* ── LLM Provider ── */}
        <div style={card}>
          <SectionLabel>LLM PROVIDER</SectionLabel>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 16px" }}>
            Choose AI model powering explanations and policy generation.
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
            {([
              { val: "gemini", label: "Google Gemini" },
              { val: "openai", label: "OpenAI GPT-4o" },
              { val: "ollama", label: "Ollama (local)" },
            ] as const).map(opt => (
              <button
                key={opt.val}
                onClick={() => setLlmProvider(opt.val)}
                style={{
                  background: llmProvider === opt.val ? "var(--accent-bg)" : "var(--surface-raised)",
                  border: `1px solid ${llmProvider === opt.val ? "var(--accent-border)" : "var(--border)"}`,
                  color: llmProvider === opt.val ? "var(--accent)" : "var(--text-muted)",
                  borderRadius: 4,
                  padding: "8px 16px",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {llmProvider !== "ollama" && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11, marginBottom: 8, letterSpacing: "0.06em" }}>API KEY</div>
              <input
                type="password"
                value={llmApiKey}
                onChange={e => setLlmApiKey(e.target.value)}
                placeholder={llmProvider === "gemini" ? "AIzaSy…" : "sk-…"}
                style={{
                  width: "100%",
                  background: "var(--code-bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text)",
                  fontFamily: "var(--mono)",
                  fontSize: 13,
                  padding: "10px 14px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>
          )}
          <SaveBtn onClick={saveLLM} saving={llmSaving} label="SAVE LLM CONFIG" />
        </div>

        {/* ── Secret Detection Allowlist ── */}
        <div style={{ ...card, marginBottom: 0 }}>
          <SectionLabel>SECRET DETECTION ALLOWLIST</SectionLabel>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 14px" }}>
            Exclude known-safe fingerprints, path globs, or detector IDs from SecretSentinel scans.
          </p>
          <textarea
            value={allowlist}
            onChange={e => { setAllowlist(e.target.value); setAllowlistError(null); }}
            rows={8}
            style={{
              width: "100%",
              background: "var(--code-bg)",
              border: `1px solid ${allowlistError ? "var(--danger)" : "var(--border)"}`,
              borderRadius: 5,
              color: "var(--accent)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              padding: "12px 14px",
              resize: "vertical",
              outline: "none",
              lineHeight: 1.7,
              boxSizing: "border-box",
            }}
          />
          {allowlistError && (
            <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 12, marginTop: 6 }}>✕ {allowlistError}</div>
          )}
          <div style={{ marginTop: 12 }}>
            <SaveBtn onClick={saveAllowlist} saving={allowlistSaving} label="SAVE ALLOWLIST" />
          </div>
        </div>

      </div>
      </div>
    </Layout>
  );
}
