import {
  Home, FolderOpen, Clock, Star, Trash2, Folder, Sparkles, Bot, Copy,
  Settings, HelpCircle, ChevronLeft, ChevronRight, BarChart3
} from "./Icons";

type View =
  | "home" | "files" | "recent" | "starred" | "trash"
  | "search" | "ai-assistant" | "ai-organization" | "duplicates"
  | "smart-folders" | "storage" | "settings";

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const navItems = [
  { id: "home" as View, label: "Home", icon: Home },
  { id: "files" as View, label: "Files", icon: FolderOpen },
  { id: "recent" as View, label: "Recent", icon: Clock },
  { id: "starred" as View, label: "Starred", icon: Star },
  { id: "trash" as View, label: "Trash", icon: Trash2 },
];

const smartFolderItems = [
  { id: "university", label: "University" },
  { id: "projects", label: "Projects" },
  { id: "documents", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
];

const aiItems = [
  { id: "ai-organization" as View, label: "AI Organization", icon: Sparkles },
  { id: "duplicates" as View, label: "Duplicates", icon: Copy },
  { id: "storage" as View, label: "Storage", icon: BarChart3 },
];

function NavItem({
  icon: Icon, label, active, collapsed, onClick, badge,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm font-medium transition-all duration-150 group relative
        ${active
          ? "bg-foreground text-primary-foreground"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
        }
        ${collapsed ? "justify-center" : ""}
      `}
    >
      <Icon size={16} className="flex-shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="ml-auto text-[10px] font-mono bg-accent text-accent-foreground px-1.5 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </button>
  );
}

export default function Sidebar({ currentView, onNavigate, collapsed, onToggleCollapse }: SidebarProps) {
  return (
    <aside
      className={`h-full flex flex-col bg-card border-r border-border transition-all duration-200 flex-shrink-0
        ${collapsed ? "w-16" : "w-60"}
      `}
    >
      {/* Logo */}
      <div className={`flex items-center gap-2.5 px-4 py-5 border-b border-border ${collapsed ? "justify-center px-2" : ""}`}>
        <div className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center flex-shrink-0">
          <Sparkles size={14} className="text-white" />
        </div>
        {!collapsed && (
          <div>
            <div className="text-sm font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>SmartFile</div>
            <div className="text-[10px] text-muted-foreground leading-tight">File Manager</div>
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
        {navItems.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={currentView === item.id}
            collapsed={collapsed}
            onClick={() => onNavigate(item.id)}
          />
        ))}

        {/* Smart Folders */}
        {!collapsed && (
          <>
            <div className="pt-4 pb-1 px-2.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Smart Folders</span>
            </div>
            {smartFolderItems.map((item) => (
              <button
                key={item.id}
                onClick={() => onNavigate("smart-folders")}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors
                  ${currentView === "smart-folders" ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}
                `}
              >
                <span className="w-4 h-4 rounded bg-indigo-100 flex-shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </>
        )}

        {/* AI */}
        {!collapsed && (
          <div className="pt-4 pb-1 px-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">AI</span>
          </div>
        )}
        {collapsed && <div className="my-2 border-t border-border" />}
        {aiItems.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={currentView === item.id}
            collapsed={collapsed}
            onClick={() => onNavigate(item.id)}
          />
        ))}
        <NavItem
          icon={Bot}
          label="AI Assistant"
          active={currentView === "ai-assistant"}
          collapsed={collapsed}
          onClick={() => onNavigate("ai-assistant")}
        />
      </div>

      {/* Bottom */}
      <div className="border-t border-border px-2 py-3 space-y-0.5">
        <NavItem icon={Settings} label="Settings" active={currentView === "settings"} collapsed={collapsed} onClick={() => onNavigate("settings")} />
        <NavItem icon={HelpCircle} label="Help" active={false} collapsed={collapsed} onClick={() => {}} />
        <button
          onClick={onToggleCollapse}
          className="w-full flex items-center justify-center gap-2 px-2.5 py-2 rounded-md text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          {collapsed ? <ChevronRight size={14} /> : <><ChevronLeft size={14} /><span>Collapse</span></>}
        </button>
      </div>
    </aside>
  );
}
