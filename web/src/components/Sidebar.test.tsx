import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Sidebar from "./Sidebar";

afterEach(cleanup);

type TestView =
  | "home" | "files" | "recent" | "starred" | "trash"
  | "search" | "ai-assistant" | "ai-organization" | "duplicates"
  | "smart-folders" | "storage" | "settings";

function renderSidebar(currentView: TestView = "files") {
  const onNavigate = vi.fn();
  render(
    <Sidebar
      currentView={currentView}
      onNavigate={onNavigate}
      collapsed={false}
      onToggleCollapse={vi.fn()}
    />,
  );
  return { onNavigate };
}

describe("Sidebar — Smart Folders navigation (honest)", () => {
  it("does not render static/fake smart folder entries (University, Projects, etc.)", () => {
    renderSidebar();
    expect(screen.queryByText("University")).not.toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Images")).not.toBeInTheDocument();
    expect(screen.queryByText("Videos")).not.toBeInTheDocument();
  });

  it("keeps one honest Smart Folders nav entry that navigates to the placeholder view", () => {
    const { onNavigate } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Smart Folders" }));
    expect(onNavigate).toHaveBeenCalledWith("smart-folders");
  });
});
