import { useState } from "react";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import AIAssistant from "./components/AIAssistant";
import FilePreview from "./components/FilePreview";
import Home from "./components/views/Home";
import Files from "./components/views/Files";
import Recent from "./components/views/Recent";
import Starred from "./components/views/Starred";
import Trash from "./components/views/Trash";
import Search from "./components/views/Search";
import AIOrganization from "./components/views/AIOrganization";
import Duplicates from "./components/views/Duplicates";
import SmartFolders from "./components/views/SmartFolders";
import Storage from "./components/views/Storage";
import Settings from "./components/views/Settings";
import type { FileItem } from "./data/files";

type View =
  | "home" | "files" | "recent" | "starred" | "trash"
  | "search" | "ai-assistant" | "ai-organization" | "duplicates"
  | "smart-folders" | "storage" | "settings";

const breadcrumbs: Record<View, string[]> = {
  home: ["SmartFile"],
  files: ["Files", "Documents"],
  recent: ["Recent"],
  starred: ["Starred"],
  trash: ["Trash"],
  search: ["Search"],
  "ai-assistant": ["AI", "Assistant"],
  "ai-organization": ["AI", "Organization"],
  duplicates: ["AI", "Duplicates"],
  "smart-folders": ["Smart Folders"],
  storage: ["Storage"],
  settings: ["Settings"],
};

export default function App() {
  const [view, setView] = useState<View>("home");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  function navigate(v: string) {
    setView(v as View);
    if (v === "ai-assistant") setAiOpen(true);
  }

  function handleSearch(q: string) {
    setSearchQuery(q);
    setView("search");
  }

  function openFile(file: FileItem) {
    setPreviewFile(file);
  }

  return (
    <div className="h-full flex bg-background overflow-hidden" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Sidebar */}
      <Sidebar
        currentView={view}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar
          breadcrumb={breadcrumbs[view] ?? ["SmartFile"]}
          onSearch={handleSearch}
          onOpenAI={() => setAiOpen((v) => !v)}
        />

        <div className="flex flex-1 overflow-hidden">
          {/* Content */}
          <div className="flex-1 flex overflow-hidden">
            {view === "home" && <Home onOpenFile={openFile} onNavigate={navigate} />}
            {view === "files" && <Files onOpenFile={openFile} />}
            {view === "recent" && <Recent onOpenFile={openFile} />}
            {view === "starred" && <Starred onOpenFile={openFile} />}
            {view === "trash" && <Trash />}
            {view === "search" && <Search query={searchQuery} onOpenFile={openFile} />}
            {view === "ai-organization" && <AIOrganization />}
            {view === "duplicates" && <Duplicates />}
            {view === "smart-folders" && <SmartFolders />}
            {view === "storage" && <Storage />}
            {view === "settings" && <Settings />}
            {view === "ai-assistant" && (
              <div className="flex-1 flex items-center justify-center bg-background">
                <div className="text-center text-muted-foreground">
                  <p className="text-sm">AI Assistant is open in the side panel →</p>
                </div>
              </div>
            )}
          </div>

          {/* AI Panel */}
          {aiOpen && (
            <AIAssistant onClose={() => { setAiOpen(false); if (view === "ai-assistant") setView("home"); }} />
          )}
        </div>
      </div>

      {/* File preview overlay */}
      {previewFile && (
        <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
      )}
    </div>
  );
}
