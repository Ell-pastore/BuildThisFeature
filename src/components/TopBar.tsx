import { useState } from "react";
import { Search, Bell, Sparkles, ChevronRight, User } from "./Icons";

interface TopBarProps {
  breadcrumb: string[];
  onSearch: (q: string) => void;
  onOpenAI: () => void;
}

export default function TopBar({ breadcrumb, onSearch, onOpenAI }: TopBarProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  }

  return (
    <header className="h-14 flex items-center gap-4 px-5 border-b border-border bg-card flex-shrink-0">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm flex-shrink-0">
        {breadcrumb.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={13} className="text-muted-foreground" />}
            <span className={i === breadcrumb.length - 1 ? "text-foreground font-medium" : "text-muted-foreground"}>
              {crumb}
            </span>
          </span>
        ))}
      </nav>

      {/* Search */}
      <form onSubmit={handleSubmit} className="flex-1 max-w-xl">
        <div className={`relative flex items-center rounded-lg border transition-all duration-150
          ${focused ? "border-accent ring-2 ring-accent/20 bg-card" : "border-border bg-secondary"}`}
        >
          <Search size={14} className="absolute left-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search files, folders, or ask anything…"
            className="w-full pl-9 pr-4 py-2 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          <kbd className="absolute right-3 text-[10px] font-mono text-muted-foreground bg-border/60 px-1.5 py-0.5 rounded">
            ⌘K
          </kbd>
        </div>
      </form>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <button className="relative w-8 h-8 flex items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors">
          <Bell size={16} />
          <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-accent rounded-full" />
        </button>
        <button
          onClick={onOpenAI}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-ai-bg text-ai-text text-xs font-medium hover:bg-indigo-100 transition-colors"
        >
          <Sparkles size={13} />
          <span>Ask AI</span>
        </button>
        <button className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
          <User size={14} />
        </button>
      </div>
    </header>
  );
}
