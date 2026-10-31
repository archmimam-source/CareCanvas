import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/apiClient";
import { motion, AnimatePresence } from "framer-motion";
import { MessageCircle, X, Send, Bot, User as UserIcon, ShieldCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const SESSION_KEY = "his:ai:compliance-session";

function useSession(roomId) {
  const key = `${SESSION_KEY}:${roomId}`;
  const [sid] = useState(() => {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = `s-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, fresh);
    return fresh;
  });
  return sid;
}

const SUGGESTED = [
  "What compliance flags are open?",
  "Explain the basin-to-macerator rule.",
  "Which HBN section covers ventilation?",
  "Summarise this room's risk rating.",
];

/**
 * Floating bottom-right compliance chat widget.
 * Replaces the top-toolbar AI sheet. Purpose is narrowed to "compliance Q&A"
 * since "Make compliant" is now a first-class toolbar action.
 */
export default function AiFab({ open, setOpen, roomId, sceneVersion, flagsCount, onAddComponent }) {
  const sessionId = useSession(roomId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    api.get(`/rooms/${roomId}/ai/chat/${sessionId}`).then((r) => setMessages(r.data)).catch(() => {});
  }, [roomId, sessionId, open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending, open]);

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content, timestamp: new Date().toISOString() }]);
    setSending(true);
    try {
      const r = await api.post(`/rooms/${roomId}/ai/chat`, { session_id: sessionId, message: content });
      setMessages((prev) => [...prev, { role: "assistant", content: r.data.reply, timestamp: new Date().toISOString() }]);
    } catch (e) {
      toast.error(e.response?.data?.detail || "AI chat failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3 pointer-events-none">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            className="pointer-events-auto w-[380px] max-w-[92vw] h-[540px] max-h-[80vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden"
            data-testid="ai-fab-panel"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-slate-200 flex items-start justify-between gap-3 bg-gradient-to-b from-slate-50 to-white">
              <div>
                <div className="flex items-center gap-2 font-display text-sm font-semibold text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" strokeWidth={1.75} /> Compliance chat
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-slate-500 mt-0.5">
                  v{sceneVersion} · {flagsCount} open flag{flagsCount === 1 ? "" : "s"}
                </div>
              </div>
              <button onClick={() => setOpen(false)}
                className="w-7 h-7 rounded-full hover:bg-slate-100 flex items-center justify-center"
                data-testid="ai-fab-close">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50/60">
              {messages.length === 0 && !sending && (
                <div className="space-y-2 pt-2">
                  <div className="px-3 py-2 rounded-2xl bg-white border border-slate-200 text-xs text-slate-700 leading-relaxed">
                    Hi — ask me anything about NHS HBN 00-09, HTM 04-01, ASHRAE 170 compliance for this room, or how to close a specific flag.
                  </div>
                  <div className="space-y-1.5 pt-1">
                    {SUGGESTED.map((p, i) => (
                      <button key={i} onClick={() => send(p)}
                        className="w-full text-left px-3 py-2 rounded-xl bg-white border border-slate-200 hover:border-slate-400 text-xs text-slate-700 transition-colors"
                        data-testid={`ai-fab-suggest-${i}`}>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
                    }`} data-testid={`ai-fab-msg-${m.role}-${i}`}>
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
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" />
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" style={{ animationDelay: "300ms" }} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Input */}
            <div className="p-3 border-t border-slate-200 bg-white">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder="Ask about a flag or standard…"
                  rows={2}
                  className="flex-1 resize-none px-3 py-2 rounded-lg border border-slate-300 focus:border-slate-900 focus:outline-none text-xs bg-white"
                  data-testid="ai-fab-input"
                />
                <button onClick={() => send()} disabled={!input.trim() || sending}
                  className="h-9 w-9 rounded-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white flex items-center justify-center transition-colors"
                  data-testid="ai-fab-send">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* FAB */}
      <motion.button
        onClick={() => setOpen(!open)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.95 }}
        className={`pointer-events-auto relative w-14 h-14 rounded-full flex items-center justify-center text-white hb-btn-primary`}
        data-testid="ai-fab-toggle"
        title={open ? "Close compliance chat" : "Open compliance chat"}
      >
        <AnimatePresence mode="wait" initial={false}>
          {open ? (
            <motion.span key="close" initial={{ opacity: 0, rotate: -90 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: 90 }}>
              <X className="w-5 h-5" strokeWidth={2} />
            </motion.span>
          ) : (
            <motion.span key="open" initial={{ opacity: 0, rotate: 90 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: -90 }}>
              <MessageCircle className="w-5 h-5" strokeWidth={1.75} />
            </motion.span>
          )}
        </AnimatePresence>
        {!open && flagsCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white text-[10px] font-mono font-semibold flex items-center justify-center border-2 border-white"
                data-testid="ai-fab-badge">
            {flagsCount}
          </span>
        )}
      </motion.button>
    </div>
  );
}
