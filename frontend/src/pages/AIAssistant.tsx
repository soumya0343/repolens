import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Layout from "../components/Layout";
import { API_BASE_URL } from "../lib/apiConfig";

const authHdr = () => ({ Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` });

interface Finding {
  severity: "critical" | "warning" | "info";
  sha: string;
  title: string;
  description: string;
}

interface CodeRef {
  file: string;
  lines: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  findings?: Finding[];
  code_ref?: CodeRef;
}

interface AIResponse {
  response: string;
  history?: Record<string, unknown>[];
  findings?: Finding[];
  code_ref?: CodeRef;
}

const QUICK_ACTIONS = [
  "_SCAN DEPENDENCIES",
  "_EXPLAIN ARCHITECTURE",
  "_GENERATE UNIT TESTS",
];

function sessionId() {
  const hex = () => Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `0X${hex()}${hex()}`;
}

const SID = sessionId();
const SESSION_TIME = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

function FindingCard({ f }: { f: Finding }) {
  const isCrit = f.severity === "critical";
  const isWarn = f.severity === "warning";
  const color = isCrit ? "var(--danger)" : isWarn ? "var(--warning)" : "var(--accent)";
  const label = isCrit ? "⚠ CRITICAL RISK" : isWarn ? "⚠ WARNING" : "ℹ INFO";
  return (
    <div style={{
      background: "var(--bg)",
      border: `1px solid ${color}22`,
      borderRadius: 5,
      padding: "14px 16px",
      flex: 1,
      minWidth: 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ color, fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em" }}>{label}</span>
        {f.sha && (
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 11 }}>SHA: {f.sha}</span>
        )}
      </div>
      <div style={{ color: "var(--text-h)", fontWeight: 600, fontSize: 15, marginBottom: 6 }}>{f.title}</div>
      <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{f.description}</div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: Message }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: "var(--accent)",
          display: "inline-block",
        }} />
        <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>
          Repolens Engine
        </span>
      </div>
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "18px 20px",
      }}>
        <p style={{ margin: "0 0 16px", color: "var(--text)", lineHeight: 1.65, fontSize: 14 }}>
          {msg.content.split(/(`[^`]+`)/g).map((part, i) =>
            part.startsWith("`") && part.endsWith("`")
              ? <code key={i} style={{ background: "var(--code-bg)", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12, padding: "1px 5px", borderRadius: 3 }}>{part.slice(1, -1)}</code>
              : <span key={i}>{part}</span>
          )}
        </p>

        {msg.findings && msg.findings.length > 0 && (
          <div style={{ display: "flex", gap: 12, marginBottom: msg.code_ref ? 14 : 0 }}>
            {msg.findings.map((f, i) => <FindingCard key={i} f={f} />)}
          </div>
        )}

        {msg.code_ref && (
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            background: "var(--code-bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "8px 14px",
            fontFamily: "var(--mono)",
            fontSize: 12,
            marginTop: msg.findings ? 12 : 0,
          }}>
            <span style={{ color: "var(--text-muted)" }}>{msg.code_ref.file}</span>
            <span style={{ color: "var(--text-muted)" }}>Lines {msg.code_ref.lines}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function UserBubble({ msg }: { msg: Message }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 24 }}>
      <div style={{ maxWidth: "65%" }}>
        <div style={{ textAlign: "right", marginBottom: 8 }}>
          <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.06em" }}>USER REQUEST</span>
        </div>
        <div style={{
          background: "var(--surface-raised)",
          borderLeft: "3px solid var(--accent)",
          borderRadius: "0 6px 6px 0",
          padding: "14px 18px",
          color: "var(--text)",
          fontSize: 14,
          lineHeight: 1.65,
        }}>
          {msg.content.split(/(`[^`]+`)/g).map((part, i) =>
            part.startsWith("`") && part.endsWith("`")
              ? <code key={i} style={{ background: "var(--code-bg)", color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12, padding: "1px 5px", borderRadius: 3 }}>{part.slice(1, -1)}</code>
              : <span key={i}>{part}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AIAssistant() {
  const { repoId } = useParams<{ repoId: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  // history in Groq wire format (includes tool messages — not rendered)
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    const query = text.trim();
    if (!query || loading) return;
    setInput("");
    const userMsg: Message = { role: "user", content: query };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/repos/${repoId}/chat`, {
        method: "POST",
        headers: { ...authHdr(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: query, history }),
      });
      if (res.ok) {
        const data: AIResponse = await res.json();
        setHistory(data.history ?? []);
        setMessages(prev => [...prev, {
          role: "assistant",
          content: data.response,
          findings: data.findings,
          code_ref: data.code_ref,
        }]);
      } else {
        const err = await res.json().catch(() => ({}));
        setMessages(prev => [...prev, { role: "assistant", content: `Error ${res.status}: ${err.detail ?? "request failed"}` }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Network error. Please try again." }]);
    }
    setLoading(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <Layout activeNav="ai" repoId={repoId}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "28px 36px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h1 style={{ fontFamily: "var(--heading)", fontSize: 26, fontWeight: 700, color: "var(--text-h)", margin: "0 0 6px", letterSpacing: "-0.5px" }}>
                AUDIT :: AI_ASSISTANT
              </h1>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "var(--text-muted)", fontFamily: "var(--mono)", fontSize: 12 }}>SESSION ID:</span>
                <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12 }}>{SID}</span>
              </div>
            </div>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--accent)",
              color: "#000",
              borderRadius: 4,
              padding: "7px 14px",
              fontFamily: "var(--mono)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}>
              <span style={{ width: 8, height: 8, background: "#000", borderRadius: 1, display: "inline-block" }} />
              SYSTEM CONTEXT ACTIVE
            </div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "28px 36px" }}>
          {messages.length === 0 && (
            <div style={{
              textAlign: "center",
              color: "var(--text-muted)",
              fontFamily: "var(--mono)",
              fontSize: 12,
              letterSpacing: "0.08em",
              padding: "40px 0",
            }}>
              --- AUDIT SESSION INITIATED AT {SESSION_TIME} ---
            </div>
          )}

          {messages.map((msg, i) =>
            msg.role === "user"
              ? <UserBubble key={i} msg={msg} />
              : <AssistantBubble key={i} msg={msg} />
          )}

          {loading && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />
                <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>Repolens Engine</span>
              </div>
              <div style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "18px 20px",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: "var(--accent)",
                    display: "inline-block",
                    animation: `pulse 1.2s ${i * 0.2}s ease-in-out infinite`,
                  }} />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Quick actions */}
        <div style={{ padding: "0 36px 12px", display: "flex", gap: 10, flexShrink: 0 }}>
          {QUICK_ACTIONS.map(action => (
            <button
              key={action}
              onClick={() => send(action.replace(/^_/, ""))}
              style={{
                background: "transparent",
                border: "1px solid var(--border-bright)",
                color: "var(--text-muted)",
                borderRadius: 4,
                padding: "6px 14px",
                fontFamily: "var(--mono)",
                fontSize: 12,
                cursor: "pointer",
                letterSpacing: "0.04em",
                transition: "border-color 0.15s, color 0.15s",
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = "var(--accent)"; (e.target as HTMLElement).style.color = "var(--accent)"; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = "var(--border-bright)"; (e.target as HTMLElement).style.color = "var(--text-muted)"; }}
            >
              {action}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{
          padding: "12px 36px 0",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              flex: 1,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "12px 14px",
            }}>
              <span style={{ color: "var(--accent)", fontFamily: "var(--mono)", fontSize: 14, paddingTop: 1, flexShrink: 0 }}>▸</span>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Type a query or command to audit the repository..."
                rows={1}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--text)",
                  fontFamily: "var(--sans)",
                  fontSize: 14,
                  resize: "none",
                  lineHeight: 1.5,
                  maxHeight: 120,
                  overflow: "auto",
                }}
              />
            </div>
            <button
              onClick={() => send(input)}
              disabled={loading || !input.trim()}
              style={{
                width: 44,
                height: 44,
                background: input.trim() && !loading ? "var(--accent)" : "var(--surface)",
                border: `1px solid ${input.trim() && !loading ? "var(--accent)" : "var(--border)"}`,
                color: input.trim() && !loading ? "#000" : "var(--text-muted)",
                borderRadius: 6,
                cursor: input.trim() && !loading ? "pointer" : "default",
                fontSize: 18,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s",
                flexShrink: 0,
              }}
            >
              ▶
            </button>
          </div>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "8px 0 14px",
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}>
            <span>MODEL: GPT-4-REPOAUDIT-V2</span>
            <span>PRESS ENTER TO EXECUTE, SHIFT+ENTER FOR NEWLINE</span>
          </div>
        </div>

      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.1); }
        }
      `}</style>
    </Layout>
  );
}
