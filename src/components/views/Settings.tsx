import { useState } from "react";
import { Settings as SettingsIcon } from "../../components/Icons";

type Section = "General" | "Appearance" | "Storage" | "AI" | "Privacy" | "Notifications" | "Keyboard Shortcuts";

const sections: Section[] = ["General", "Appearance", "Storage", "AI", "Privacy", "Notifications", "Keyboard Shortcuts"];

function Toggle({ label, description, defaultOn = false }: { label: string; description?: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex items-start justify-between py-4 border-b border-border last:border-none">
      <div className="flex-1 pr-8">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <button
        onClick={() => setOn((v) => !v)}
        className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5 ${on ? "bg-accent" : "bg-border"}`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${on ? "left-5" : "left-1"}`} />
      </button>
    </div>
  );
}

function Select({ label, options, defaultValue }: { label: string; options: string[]; defaultValue: string }) {
  const [val, setVal] = useState(defaultValue);
  return (
    <div className="flex items-center justify-between py-4 border-b border-border last:border-none">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <select
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card text-foreground outline-none focus:border-accent transition-colors"
      >
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );
}

export default function Settings() {
  const [activeSection, setActiveSection] = useState<Section>("General");

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        <div className="flex items-center gap-2 mb-6">
          <SettingsIcon size={16} className="text-muted-foreground" />
          <h1 className="text-xl font-semibold text-foreground" style={{ fontFamily: "Instrument Sans, sans-serif" }}>Settings</h1>
        </div>

        <div className="flex gap-8">
          {/* Sidebar nav */}
          <nav className="w-44 flex-shrink-0 space-y-0.5">
            {sections.map((s) => (
              <button
                key={s}
                onClick={() => setActiveSection(s)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors
                  ${activeSection === s ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
              >
                {s}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 bg-card border border-border rounded-xl px-6 py-2">
            {activeSection === "General" && (
              <div>
                <Select label="Default view" options={["List", "Grid"]} defaultValue="List" />
                <Select label="Sort files by" options={["Name", "Modified", "Size", "Type"]} defaultValue="Modified" />
                <Toggle label="Show hidden files" defaultOn={false} />
                <Toggle label="Confirm before deleting" defaultOn={true} description="Show a confirmation dialog before moving files to Trash." />
                <Toggle label="Open files on single click" defaultOn={false} />
              </div>
            )}
            {activeSection === "Appearance" && (
              <div>
                <Select label="Theme" options={["Light", "System"]} defaultValue="Light" />
                <Select label="Density" options={["Comfortable", "Compact"]} defaultValue="Comfortable" />
                <Toggle label="Show file extensions" defaultOn={true} />
                <Toggle label="Show file previews in grid" defaultOn={true} />
              </div>
            )}
            {activeSection === "AI" && (
              <div>
                <Toggle label="Enable AI suggestions" defaultOn={true} description="Let SmartFile analyze your files and surface intelligent recommendations." />
                <Toggle label="Enable natural-language search" defaultOn={true} description="Search using natural language queries like 'Find my internship documents'." />
                <Toggle label="Enable automatic duplicate detection" defaultOn={true} description="Automatically scan for duplicate files in the background." />
                <Toggle label="Ask before moving files" defaultOn={true} description="Always require confirmation before AI moves any files." />
                <Toggle label="Ask before deleting files" defaultOn={true} description="Never allow AI to permanently delete files without explicit confirmation." />
                <Toggle label="Show AI confidence scores" defaultOn={false} />
              </div>
            )}
            {activeSection === "Privacy" && (
              <div>
                <div className="py-4 border-b border-border">
                  <div className="text-sm font-medium text-foreground mb-2">File Analysis</div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    SmartFile analyzes your file names, sizes, types, and metadata to provide AI-powered organization suggestions. File contents are processed locally and are never sent to external servers without your explicit permission.
                  </p>
                </div>
                <Toggle label="Allow local AI analysis" defaultOn={true} description="Enables all AI features. File content is processed on-device." />
                <Toggle label="Usage analytics" defaultOn={false} description="Help improve SmartFile by sharing anonymous usage data." />
                <div className="py-4">
                  <button className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                    Clear AI learning data
                  </button>
                </div>
              </div>
            )}
            {activeSection === "Notifications" && (
              <div>
                <Toggle label="Organization suggestions" defaultOn={true} />
                <Toggle label="Duplicate detection alerts" defaultOn={true} />
                <Toggle label="Storage warnings" defaultOn={true} />
                <Toggle label="AI analysis complete" defaultOn={false} />
              </div>
            )}
            {activeSection === "Storage" && (
              <div>
                <Select label="Warning threshold" options={["75%", "80%", "90%"]} defaultValue="80%" />
                <Toggle label="Auto-detect large files" defaultOn={true} description="Notify when files over 500 MB are added." />
                <Toggle label="Weekly storage report" defaultOn={false} />
              </div>
            )}
            {activeSection === "Keyboard Shortcuts" && (
              <div className="py-2">
                {[
                  ["⌘K", "Open search"],
                  ["⌘N", "New folder"],
                  ["⌘U", "Upload files"],
                  ["⌘D", "Detect duplicates"],
                  ["⌘⇧O", "Open AI Organization"],
                  ["Space", "Preview selected file"],
                  ["⌘⌫", "Move to Trash"],
                  ["⌘Z", "Undo"],
                ].map(([key, label]) => (
                  <div key={label} className="flex items-center justify-between py-3 border-b border-border last:border-none">
                    <span className="text-sm text-foreground">{label}</span>
                    <kbd className="font-mono text-xs bg-secondary border border-border px-2.5 py-1 rounded-md text-muted-foreground">{key}</kbd>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
