import { useState } from "react";
import { X, Sparkles, Send, FolderOpen, FileText, Search, Copy, HardDrive } from "./Icons";

interface Message {
  id: string;
  role: "user" | "ai";
  content: string;
  suggestions?: { label: string; count?: number }[];
  actions?: string[];
}

const initialMessages: Message[] = [
  {
    id: "0",
    role: "ai",
    content: "Hi! I'm your Smart File Assistant. I can help you organize files, find duplicates, search with natural language, and analyze your storage.",
    actions: [],
  },
];

const quickPrompts = [
  { label: "Organize my files", icon: FolderOpen },
  { label: "Find duplicates", icon: Copy },
  { label: "Clean Downloads", icon: HardDrive },
  { label: "Find important docs", icon: FileText },
];

const canned: Record<string, Message> = {
  "Can you organize my Downloads folder?": {
    id: "ai-org",
    role: "ai",
    content: "I analyzed your Downloads folder and found 47 files that could be organized. Here's what I found:",
    suggestions: [
      { label: "Documents", count: 18 },
      { label: "Images", count: 12 },
      { label: "Videos", count: 9 },
      { label: "Archives", count: 5 },
      { label: "Other", count: 3 },
    ],
    actions: ["Review changes", "Cancel"],
  },
  "Find duplicates": {
    id: "ai-dup",
    role: "ai",
    content: "I scanned your files and found 8 duplicate groups totaling 127 MB of duplicate storage. The most common duplicates are PDF documents and images.",
    actions: ["Review duplicates"],
  },
  "Find important docs": {
    id: "ai-imp",
    role: "ai",
    content: 'I found 9 files that appear to be important based on your star ratings and access frequency: SIWES_Report_Final.pdf, Project_Proposal.pdf, Internship_Offer_Letter.pdf, and 6 others.',
    actions: ["Open folder"],
  },
  "Clean Downloads": {
    id: "ai-clean",
    role: "ai",
    content: "Your Downloads folder has 47 files. I suggest:\n• 23 files that belong in other folders\n• 8 duplicate files (127 MB)\n• 5 files older than 6 months you haven't opened\n\nTotal potential cleanup: ~400 MB",
    actions: ["Review plan", "Cancel"],
  },
  "Organize my files": {
    id: "ai-org2",
    role: "ai",
    content: "I'll analyze your entire file system. Found 23 files that appear misplaced, 8 duplicate groups, and 3 suggested new folders to create. Would you like to review the detailed plan?",
    actions: ["Review changes", "Cancel"],
  },
};

interface AIAssistantProps {
  onClose: () => void;
}

export default function AIAssistant({ onClose }: AIAssistantProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");

  function send(text: string) {
    if (!text.trim()) return;
    const userMsg: Message = { id: Date.now().toString(), role: "user", content: text };
    const aiReply: Message = canned[text] ?? {
      id: (Date.now() + 1).toString(),
      role: "ai",
      content: `Searching for "${text}"… I found relevant files in your Documents and Downloads folders. Would you like me to show the results?`,
      actions: ["Show results"],
    };
    setMessages((prev) => [...prev, userMsg, { ...aiReply, id: (Date.now() + 1).toString() }]);
    setInput("");
  }

  return (
    <div className="h-full flex flex-col bg-card border-l border-border w-96 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-ai-bg flex items-center justify-center">
            <Sparkles size={12} className="text-ai-text" />
          </div>
          <span className="text-sm font-semibold" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Smart Assistant</span>
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary transition-colors">
          <X size={15} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "ai" && (
              <div className="w-6 h-6 rounded-full bg-ai-bg flex items-center justify-center flex-shrink-0 mr-2 mt-0.5">
                <Sparkles size={11} className="text-ai-text" />
              </div>
            )}
            <div className={`max-w-[85%] ${msg.role === "user" ? "bg-foreground text-primary-foreground" : "bg-secondary text-foreground"} rounded-xl px-3.5 py-2.5 text-sm leading-relaxed`}>
              <p className="whitespace-pre-line">{msg.content}</p>
              {msg.suggestions && (
                <div className="mt-3 space-y-1.5">
                  {msg.suggestions.map((s) => (
                    <div key={s.label} className="flex items-center justify-between bg-card rounded-lg px-3 py-2">
                      <span className="text-sm font-medium">{s.label}</span>
                      {s.count !== undefined && (
                        <span className="text-xs font-mono text-muted-foreground">{s.count} files</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.actions && msg.actions.length > 0 && (
                <div className="mt-3 flex gap-2 flex-wrap">
                  {msg.actions.map((a) => (
                    <button
                      key={a}
                      className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors
                        ${a === "Cancel" || a === "Dismiss"
                          ? "bg-card text-muted-foreground border border-border hover:bg-secondary"
                          : "bg-accent text-white hover:bg-indigo-600"
                        }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Quick prompts */}
      <div className="px-4 pb-2 grid grid-cols-2 gap-1.5">
        {quickPrompts.map(({ label, icon: Icon }) => (
          <button
            key={label}
            onClick={() => send(label)}
            className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-secondary hover:bg-border text-xs text-muted-foreground hover:text-foreground transition-colors text-left"
          >
            <Icon size={12} />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="px-4 pb-4">
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="flex gap-2 items-center border border-border rounded-xl px-3 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 transition-all"
        >
          <Search size={14} className="text-muted-foreground flex-shrink-0" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about your files…"
            className="flex-1 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="w-6 h-6 flex items-center justify-center rounded-md bg-accent text-white disabled:opacity-40 transition-opacity"
          >
            <Send size={11} />
          </button>
        </form>
      </div>
    </div>
  );
}
