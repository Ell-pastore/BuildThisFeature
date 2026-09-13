import { useEffect, useState } from "react";
import { Settings as SettingsIcon } from "../../components/Icons";
import { API_BASE_URL, fetchHealth } from "../../services/api";
import type { AppSettings, DefaultView, SortFilesBy } from "../../services/settings";

type Section = "General" | "Appearance" | "Storage" | "AI" | "Privacy" | "Notifications" | "Keyboard Shortcuts";

const sections: Section[] = ["General", "Appearance", "Storage", "AI", "Privacy", "Notifications", "Keyboard Shortcuts"];

function Toggle({
  label,
  description,
  checked = false,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between py-4 border-b border-border last:border-none">
      <div className="flex-1 pr-8">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>}
        {disabled && (
          <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Not available
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange && !disabled && onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5 ${
          disabled
            ? "bg-border opacity-40 cursor-not-allowed"
            : checked
              ? "bg-accent"
              : "bg-border"
        }`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${checked ? "left-5" : "left-1"}`} />
      </button>
    </div>
  );
}

function Select({
  label,
  options,
  value,
  disabled = false,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  disabled?: boolean;
  onChange?: (next: string) => void;
}) {
  return (
    <div className="flex items-center justify-between py-4 border-b border-border last:border-none">
      <div className="text-sm font-medium text-foreground">{label}</div>
      <div className="flex items-center gap-3">
        {disabled && (
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Not available
          </span>
        )}
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange && !disabled && onChange(e.target.value)}
          className="text-sm border border-border rounded-lg px-3 py-1.5 bg-card text-foreground outline-none focus:border-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

interface SettingsProps {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

export default function Settings({ settings, onChange }: SettingsProps) {
  const [activeSection, setActiveSection] = useState<Section>("General");
  const [backend, setBackend] = useState<{ status: "checking" | "ok" | "error"; time: string | null }>({ status: "checking", time: null });

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then(() => {
        if (!cancelled) setBackend({ status: "ok", time: new Date().toLocaleTimeString() });
      })
      .catch(() => {
        if (!cancelled) setBackend({ status: "error", time: new Date().toLocaleTimeString() });
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
                <Select
                  label="Default view"
                  options={["List", "Grid"]}
                  value={settings.defaultView}
                  onChange={(v) => onChange({ defaultView: v as DefaultView })}
                />
                <Select
                  label="Sort files by"
                  options={["Name", "Modified", "Size"]}
                  value={settings.sortFilesBy}
                  onChange={(v) => onChange({ sortFilesBy: v as SortFilesBy })}
                />
                <Toggle label="Show hidden files" disabled />
                <Toggle
                  label="Confirm before deleting"
                  checked={settings.confirmDelete}
                  onChange={(on) => onChange({ confirmDelete: on })}
                  description="Show a confirmation dialog before moving files to Trash."
                />
                <Toggle label="Open files on single click" disabled />
                <div className="py-4 border-b border-border last:border-none">
                  <div className="text-sm font-medium text-foreground">Backend API</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        backend.status === "ok"
                          ? "bg-emerald-500"
                          : backend.status === "error"
                            ? "bg-red-500"
                            : "bg-muted-foreground animate-pulse"
                      }`}
                    />
                    <span className="text-xs text-muted-foreground">
                      {backend.status === "ok" ? "Connected" : backend.status === "error" ? "Unreachable" : "Checking…"}
                    </span>
                    <span className="text-xs text-muted-foreground">{API_BASE_URL}</span>
                  </div>
                  {backend.time && <p className="mt-1 text-xs text-muted-foreground">Checked at {backend.time}</p>}
                </div>
              </div>
            )}
            {activeSection === "Appearance" && (
              <div>
                <Select label="Theme" options={["Light", "System"]} value="Light" disabled />
                <Select label="Density" options={["Comfortable", "Compact"]} value="Comfortable" disabled />
                <Toggle label="Show file extensions" disabled />
                <Toggle label="Show file previews in grid" disabled />
              </div>
            )}
            {activeSection === "AI" && (
              <div>
                <Toggle label="Enable AI suggestions" disabled description="SmartFile analysis is not implemented yet." />
                <Toggle label="Enable natural-language search" disabled description="Natural-language search is not implemented yet." />
                <Toggle label="Enable automatic duplicate detection" disabled description="Duplicate detection is manual in the Duplicates view." />
                <Toggle label="Ask before moving files" disabled description="AI file actions are not implemented yet." />
                <Toggle label="Ask before deleting files" disabled description="AI file actions are not implemented yet." />
                <Toggle label="Show AI confidence scores" disabled />
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
                <Toggle label="Allow local AI analysis" disabled description="Local AI analysis is not implemented yet." />
                <Toggle label="Usage analytics" disabled />
              </div>
            )}
            {activeSection === "Notifications" && (
              <div>
                <Toggle label="Organization suggestions" disabled />
                <Toggle label="Duplicate detection alerts" disabled />
                <Toggle label="Storage warnings" disabled />
                <Toggle label="AI analysis complete" disabled />
              </div>
            )}
            {activeSection === "Storage" && (
              <div>
                <Select label="Warning threshold" options={["75%", "80%", "90%"]} value="80%" disabled />
                <Toggle label="Auto-detect large files" disabled />
                <Toggle label="Weekly storage report" disabled />
              </div>
            )}
            {activeSection === "Keyboard Shortcuts" && (
              <div className="py-2">
                {[
                  { key: "⌘K", label: "Open search", implemented: true },
                  { key: "⌘N", label: "New folder", implemented: true },
                  { key: "⌘U", label: "Upload files", implemented: false },
                  { key: "⌘D", label: "Detect duplicates", implemented: true },
                  { key: "⌘⇧O", label: "Open AI Organization", implemented: true },
                  { key: "Space", label: "Preview selected file", implemented: true },
                  { key: "⌘⌫", label: "Move to Trash", implemented: false },
                  { key: "⌘Z", label: "Undo", implemented: false },
                ].map(({ key, label, implemented }) => (
                  <div
                    key={label}
                    className={`flex items-center justify-between py-3 border-b border-border last:border-none ${implemented ? "" : "opacity-50"}`}
                  >
                    <span className="text-sm text-foreground">{label}</span>
                    <div className="flex items-center gap-2">
                      {!implemented && (
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          Not implemented
                        </span>
                      )}
                      <kbd className="font-mono text-xs bg-secondary border border-border px-2.5 py-1 rounded-md text-muted-foreground">{key}</kbd>
                    </div>
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