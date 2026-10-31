import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Sparkles, Send, RefreshCw, Trash2, Bot, User as UserIcon, ArrowRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";

const IMPACT_CLS = {
  high:   "bg-[#FBEDE9] text-[#B15A4F] border-[#C97567]/40",
  medium: "bg-[#FFF6E5] text-[#B87A2B] border-[#DBA362]/40",
  low:    "bg-[#EEF6EF] text-[#4A9C5F] border-[#7CBF8B]/40",
};

const SESSION_KEY = "his:ai:session";

function useSession(roomId) {
  const key = `${SESSION_KEY}:${roomId}`;
  const [sid] = useState(() => {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = `s-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, fresh);
    return fresh;
  });
  const reset = () => {
    const fresh = `s-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, fresh);
    window.location.reload();
  };
  return [sid, reset];
}

export default function AiPanel({ roomId, sceneVersion, onAddComponent }) {
  const [recs, setRecs] = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [sessionId, resetSession] = useSession(roomId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.get(`/rooms/${roomId}/ai/chat/${sessionId}`).then((r) => setMessages(r.data)).catch(() => {});
  }, [roomId, sessionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  const runRecs = async () => {
    setRecsLoading(true);
    try {
      const r = await api.post(`/rooms/${roomId}/ai/recommendations`);
      setRecs(r.data);
      toast.success("AI recommendations updated");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Recommendations failed");
    } finally {
      setRecsLoading(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text, timestamp: new Date().toISOString() }]);
    setSending(true);
    try {
      const r = await api.post(`/rooms/${roomId}/ai/chat`, { session_id: sessionId, message: text });
      setMessages((prev) => [...prev, { role: "assistant", content: r.data.reply, timestamp: new Date().toISOString() }]);
    } catch (e) {
      toast.error(e.response?.data?.detail || "AI chat failed");
    } finally {
      setSending(false);
    }
  };

  const clearChat = async () => {
    try {
      await api.delete(`/rooms/${roomId}/ai/chat/${sessionId}`);
      setMessages([]);
      toast.success("Chat cleared");
    } catch { toast.error("Failed to clear"); }
  };

  const prompts = [
    "How can I improve infection-control flow?",
    "Is the hand-wash basin placement compliant?",
    "What ACH should I design for?",
    "Suggest layout tweaks for a bariatric commode.",
  ];

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1 px-3">
        {/* Recommendations */}
        <div className="pt-1 pb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">AI recommendations</div>
            <button onClick={runRecs} disabled={recsLoading}
              className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-slate-600 hover:text-slate-900 disabled:opacity-50"
              data-testid="ai-recs-run">
              {recsLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {recsLoading ? "Analysing" : recs ? "Refresh" : "Analyse"}
            </button>
          </div>

          {!recs && !recsLoading && (
            <div className="p-3 rounded-xl bg-white border border-dashed border-slate-300 text-xs text-slate-500 leading-relaxed">
              Ask the AI co-designer to analyse the current room and suggest layout tweaks, rule-compliance fixes, and any missing components.
            </div>
          )}

          {recs && (
            <div className="space-y-4">
              <RecGroup title="Layout suggestions" testId="ai-layout" items={recs.layout_suggestions} render={(it, i) => (
                <RecCard key={`l-${i}`} title={it.title} detail={it.detail} impact={it.impact} testId={`ai-layout-${i}`} />
              )} />
              <RecGroup title="Compliance fixes" testId="ai-compliance" items={recs.compliance_fixes} render={(it, i) => (
                <RecCard key={`c-${i}`} title={it.title} detail={it.detail} impact={it.impact}
                         badge={it.rule_id} testId={`ai-compliance-${i}`} />
              )} />
              <RecGroup title="Missing components" testId="ai-missing" items={recs.missing_components} render={(it, i) => (
                <div key={`m-${i}`} className="p-3 rounded-lg bg-white border border-slate-200" data-testid={`ai-missing-${i}`}>
                  <div className="flex items-center justify-between">
                    <div className="font-display text-xs font-medium text-slate-900">{it.component_key}</div>
                    <div className="font-mono text-[9px] uppercase tracking-widest text-slate-500">→ {it.suggested_zone}</div>
                  </div>
                  <div className="text-xs text-slate-600 mt-1 leading-relaxed">{it.reason}</div>
                  {onAddComponent && (
                    <button onClick={() => onAddComponent(it.component_key, it.suggested_zone)}
                      className="mt-2 inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-700 hover:text-slate-900"
                      data-testid={`ai-add-${i}`}>
                      Add to room <ArrowRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )} />
              {recs.layout_suggestions.length + recs.compliance_fixes.length + recs.missing_components.length === 0 && (
                <div className="text-xs text-slate-500 font-mono p-2">All good — nothing to suggest.</div>
              )}
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="pt-4 border-t border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Co-designer chat</div>
            <div className="flex items-center gap-2">
              <button onClick={resetSession}
                className="text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-slate-900"
                data-testid="ai-chat-new">New</button>
              {messages.length > 0 && (
                <button onClick={clearChat}
                  className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 hover:text-red-600"
                  data-testid="ai-chat-clear">
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              )}
            </div>
          </div>

          {messages.length === 0 && (
            <div className="space-y-1.5 mb-3">
              {prompts.map((p, i) => (
                <button key={i} onClick={() => setInput(p)}
                  className="w-full text-left px-3 py-2 rounded-lg bg-white border border-slate-200 text-xs text-slate-700 hover:border-slate-400 transition-colors"
                  data-testid={`ai-prompt-${i}`}>
                  {p}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2" ref={scrollRef}>
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-2 ${m.role === "user" ? "justify-end" : ""}`}>
                  {m.role === "assistant" && (
                    <div className="w-6 h-6 rounded-full bg-slate-900 text-white flex-shrink-0 flex items-center justify-center">
                      <Bot className="w-3 h-3" />
                    </div>
                  )}
                  <div className={`px-3 py-2 rounded-2xl max-w-[85%] text-xs leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-slate-900 text-white rounded-br-sm" : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm"
                  }`} data-testid={`ai-msg-${m.role}-${i}`}>
                    {m.content}
                  </div>
                  {m.role === "user" && (
                    <div className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex-shrink-0 flex items-center justify-center">
                      <UserIcon className="w-3 h-3" />
                    </div>
                  )}
                </motion.div>
              ))}
              {sending && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-2">
                  <div className="w-6 h-6 rounded-full bg-slate-900 text-white flex-shrink-0 flex items-center justify-center">
                    <Bot className="w-3 h-3" />
                  </div>
                  <div className="px-3 py-2 rounded-2xl bg-white border border-slate-200 flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "0ms" }}/>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "150ms" }}/>
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "300ms" }}/>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-slate-200 bg-white/50">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Ask about layout, rules, standards…"
            rows={2}
            className="flex-1 resize-none px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-900 focus:outline-none text-xs bg-white"
            data-testid="ai-chat-input"
          />
          <Button size="sm" onClick={send} disabled={!input.trim() || sending}
            className="h-9 rounded-full bg-slate-900 hover:bg-slate-800 text-white px-3" data-testid="ai-chat-send">
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecGroup({ title, items, render, testId }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-1.5" data-testid={`${testId}-header`}>
        {title} · {items.length}
      </div>
      <div className="space-y-2">
        {items.map(render)}
      </div>
    </div>
  );
}

function RecCard({ title, detail, impact, badge, testId }) {
  const cls = IMPACT_CLS[impact] || IMPACT_CLS.low;
  return (
    <div className="p-3 rounded-lg bg-white border border-slate-200" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-display text-xs font-medium text-slate-900">{title}</div>
        <div className={`font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-full border ${cls}`}>{impact}</div>
      </div>
      {badge && <div className="font-mono text-[10px] text-slate-500 mt-0.5">↳ {badge}</div>}
      <div className="text-xs text-slate-700 mt-1 leading-relaxed">{detail}</div>
    </div>
  );
}
