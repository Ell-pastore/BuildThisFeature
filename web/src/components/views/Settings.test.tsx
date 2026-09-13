import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Settings from "./Settings";
import { DEFAULT_SETTINGS, type AppSettings } from "../../services/settings";

function renderSettings(settings: AppSettings = DEFAULT_SETTINGS, onChange: (patch: Partial<AppSettings>) => void = vi.fn()) {
  return render(<Settings settings={settings} onChange={onChange} />);
}

function openSection(section: string) {
  fireEvent.click(screen.getByRole("button", { name: section }));
}

describe("Settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("shows the persisted values in the General controls", () => {
    renderSettings({ defaultView: "Grid", sortFilesBy: "Size", confirmDelete: false });

    const view = screen.getByLabelText("Default view") as HTMLSelectElement;
    const sort = screen.getByLabelText("Sort files by") as HTMLSelectElement;
    expect(view.value).toBe("Grid");
    expect(sort.value).toBe("Size");
    expect(screen.getByRole("switch", { name: /Confirm before deleting/ })).not.toBeChecked();
  });

  it("emits settings changes back to the parent", () => {
    const onChange = vi.fn();
    renderSettings(DEFAULT_SETTINGS, onChange);

    fireEvent.change(screen.getByLabelText("Default view"), { target: { value: "Grid" } });
    expect(onChange).toHaveBeenCalledWith({ defaultView: "Grid" });

    fireEvent.change(screen.getByLabelText("Sort files by"), { target: { value: "Name" } });
    expect(onChange).toHaveBeenCalledWith({ sortFilesBy: "Name" });

    fireEvent.click(screen.getByRole("switch", { name: /Confirm before deleting/ }));
    expect(onChange).toHaveBeenCalledWith({ confirmDelete: false });
  });

  it("keeps unsupported settings clearly non-functional instead of pretending", () => {
    renderSettings();
    openSection("AI");

    for (const label of [
      /Enable AI suggestions/,
      /Enable natural-language search/,
      /Enable automatic duplicate detection/,
      /Ask before moving files/,
      /Ask before deleting files/,
      /Show AI confidence scores/,
    ]) {
      const toggle = screen.getByRole("switch", { name: label });
      expect(toggle).toBeDisabled();
      expect(toggle.closest("div")?.textContent).toContain("Not available");
    }
  });

  it("does not pretend unsupported non-AI controls work either", () => {
    renderSettings();
    openSection("Appearance");

    expect(screen.getByRole("switch", { name: /Show file extensions/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Show file previews in grid/ })).toBeDisabled();
    expect(screen.getByLabelText("Theme")).toBeDisabled();
    expect(screen.getByLabelText("Density")).toBeDisabled();

    openSection("General");
    expect(screen.getByRole("switch", { name: /Show hidden files/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /Open files on single click/ })).toBeDisabled();
  });

  it("removes the dead Clear AI learning data action entirely", () => {
    renderSettings();
    openSection("Privacy");

    expect(screen.queryByRole("button", { name: /Clear AI learning data/ })).toBeNull();
    expect(screen.queryByText("Clear AI learning data")).toBeNull();
  });

  it("labels unimplemented shortcuts honestly in the shortcut list", () => {
    renderSettings();
    openSection("Keyboard Shortcuts");

    for (const label of ["Upload files", "Move to Trash", "Undo"]) {
      const row = screen.getByText(label).closest("div");
      expect(row?.textContent).toContain("Not implemented");
    }
    for (const label of [
      "Open search",
      "New folder",
      "Detect duplicates",
      "Open AI Organization",
      "Preview selected file",
    ]) {
      expect(screen.getByText(label).closest("div")?.textContent).not.toContain("Not implemented");
    }
  });
});