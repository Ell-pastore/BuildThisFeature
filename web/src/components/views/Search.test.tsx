import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import Search from "./Search";
import type { FileItem } from "../../types";

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: "/Users/usr/Desktop/notes.txt",
    name: "notes.txt",
    type: "txt",
    size: "1.2 KB",
    sizeBytes: 1200,
    modified: "Sep 1, 2026",
    created: "Aug 1, 2026",
    modifiedTs: 1,
    createdTs: 1,
    location: "/Users/usr/Desktop",
    path: "/Users/usr/Desktop/notes.txt",
    starred: false,
    ...overrides,
  };
}

describe("Search", () => {
  afterEach(cleanup);

  it("renders real search results without fabricated scores or AI framing", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "pdf",
        location: "/Users/usr/Documents",
      }),
    ];

    render(<Search query="re" results={results} onOpenFile={() => {}} />);

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 results")).toBeInTheDocument();
    // No fake relevance artifacts.
    expect(screen.queryByText(/% match/i)).toBeNull();
    expect(screen.queryByText(/AI Understanding/i)).toBeNull();
    // Real metadata shown.
    expect(screen.getByText(/\/Users\/usr\/Desktop · Sep 1, 2026/)).toBeInTheDocument();
  });

  it("honestly notes when the bounded search stopped at its safety limit", () => {
    render(<Search query="re" results={[file()]} onOpenFile={() => {}} truncated />);

    expect(
      screen.getByText("The search stopped at its safety limit — results may be incomplete."),
    ).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("omits the truncation note when the search completed within its budgets", () => {
    render(<Search query="re" results={[file()]} onOpenFile={() => {}} />);

    expect(screen.queryByText(/stopped at its safety limit/i)).toBeNull();
  });

  it("navigates into a folder result via onOpenFolder instead of opening the preview", () => {
    const folderResult: FileItem = file({
      id: "/Users/usr/Documents/Current Projects",
      name: "Current Projects",
      type: "folder",
      isFolder: true,
      itemCount: 3,
      size: "—",
      sizeBytes: 0,
      location: "/Users/usr/Documents",
    });
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();

    render(
      <Search
        query="projects"
        results={[folderResult]}
        onOpenFile={onOpenFile}
        onOpenFolder={onOpenFolder}
      />,
    );

    fireEvent.click(screen.getByText("Current Projects"));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({ name: "Current Projects" }));
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("still opens the preview for a file result", () => {
    const onOpenFile = vi.fn();
    const onOpenFolder = vi.fn();

    render(
      <Search query="notes" results={[file()]} onOpenFile={onOpenFile} onOpenFolder={onOpenFolder} />,
    );

    fireEvent.click(screen.getByText("notes.txt"));

    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ name: "notes.txt" }));
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("shows the honest prompt on an empty query and never a fake result set", () => {
    render(<Search query="" results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Search across all your folders")).toBeInTheDocument();
    expect(screen.queryByText(/results/)).toBeNull();
  });

  it("shows the loading state while a search is in flight", () => {
    render(<Search query="re" searching results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Searching your folders…")).toBeInTheDocument();
  });

  it("surfaces a real search error honestly", () => {
    render(<Search query="re" error="Cannot reach the filesystem bridge." results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("Couldn't search your folders")).toBeInTheDocument();
    expect(screen.getByText("Cannot reach the filesystem bridge.")).toBeInTheDocument();
  });

  it("shows the honest empty state when the recursive search finds nothing", () => {
    render(<Search query="zzzz" results={[]} onOpenFile={() => {}} />);

    expect(screen.getByText("No files found")).toBeInTheDocument();
    expect(screen.getByText(/Nothing in your folders matches/)).toBeInTheDocument();
  });

  it("applies the PDF quick filter to non-folder results", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "pdf",
        location: "/Users/usr/Documents",
      }),
      file({
        id: "/Users/usr/Documents/notes.docx",
        name: "notes.docx",
        type: "docx",
        location: "/Users/usr/Documents",
      }),
      file({
        id: "/Users/usr/Pics/photo.png",
        name: "photo.png",
        type: "png",
        location: "/Users/usr/Pics",
      }),
    ];

    render(<Search query="re" results={results} onOpenFile={() => {}} />);

    expect(screen.getByText("4 results")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText("notes.docx")).toBeNull();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.queryByText("photo.png")).toBeNull();
    expect(screen.getByText("1 results")).toBeInTheDocument();
  });

  it("keeps folders visible under an active quick filter", () => {
    const results = [
      file({
        id: "/Users/usr/Desktop/Current Projects",
        name: "Current Projects",
        type: "folder",
        isFolder: true,
        itemCount: 3,
        size: "—",
        sizeBytes: 0,
      }),
      file(),
    ];

    render(<Search query="re" results={results} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Images" }));

    expect(screen.getByText("Current Projects")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("shows the dedicated empty state when nothing matches the active filter", () => {
    render(<Search query="re" results={[file()]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Images" }));

    expect(screen.getByText("No matching results")).toBeInTheDocument();
    expect(screen.getByText(/Nothing matches the "Images" filter/)).toBeInTheDocument();
  });

  it("restores all results when switching back to the All chip", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Pics/photo.png",
        name: "photo.png",
        type: "png",
        location: "/Users/usr/Pics",
      }),
    ];

    render(<Search query="re" results={results} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(screen.getByText("No matching results")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("applies the Documents quick filter to non-folder results", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Finance/budget.xlsx",
        name: "budget.xlsx",
        type: "xlsx",
        location: "/Users/usr/Finance",
      }),
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "pdf",
        location: "/Users/usr/Documents",
      }),
      file({
        id: "/Users/usr/Pics/photo.png",
        name: "photo.png",
        type: "png",
        location: "/Users/usr/Pics",
      }),
    ];

    render(<Search query="budget" results={results} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Documents" }));

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("budget.xlsx")).toBeInTheDocument();
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.queryByText("photo.png")).toBeNull();
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("applies the Videos quick filter to non-folder results", () => {
    const results = [
      file(),
      file({
        id: "/Users/usr/Movies/clip.mp4",
        name: "clip.mp4",
        type: "mp4",
        location: "/Users/usr/Movies",
      }),
      file({
        id: "/Users/usr/Movies/clip.webm",
        name: "clip.webm",
        type: "webm",
        location: "/Users/usr/Movies",
      }),
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "pdf",
        location: "/Users/usr/Documents",
      }),
    ];

    render(<Search query="clip" results={results} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Videos" }));

    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(screen.getByText("clip.webm")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });

  it("matches file types case-insensitively under a quick filter", () => {
    const results = [
      file({
        id: "/Users/usr/Documents/report.pdf",
        name: "report.pdf",
        type: "PDF",
        location: "/Users/usr/Documents",
      }),
      file(),
    ];

    render(<Search query="report" results={results} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("marks the active quick filter chip and clears it when another chip is selected", () => {
    render(<Search query="re" results={[file()]} onOpenFile={() => {}} />);

    const allChip = screen.getByRole("button", { name: "All" });
    expect(allChip).toHaveClass("bg-foreground");

    fireEvent.click(screen.getByRole("button", { name: "Images" }));

    expect(screen.getByRole("button", { name: "Images" })).toHaveClass("bg-foreground");
    expect(allChip).not.toHaveClass("bg-foreground");
  });

  it("opens and closes the more-filters panel", () => {
    render(<Search query="re" results={[file()]} onOpenFile={() => {}} />);

    expect(screen.queryByText("Folders only")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));

    expect(screen.getByText("Folders only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));

    expect(screen.queryByText("Folders only")).toBeNull();
  });

  it("filters to large files (≥ 100 MB)", () => {
    const big = file({
      id: "/Users/usr/Videos/movie.mp4",
      name: "movie.mp4",
      type: "mp4",
      sizeBytes: 150 * 1024 * 1024,
      size: "150 MB",
    });

    render(<Search query="re" results={[file(), big]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );

    expect(screen.getByText("movie.mp4")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getByText("1 results")).toBeInTheDocument();
  });

  it("filters to files modified in the past 7 days", () => {
    const now = Date.now() / 1000;
    const recent = file({
      id: "/Users/usr/Documents/notes.md",
      name: "notes.md",
      type: "md",
      modifiedTs: now - 2 * 86400,
    });
    const old = file({
      id: "/Users/usr/Documents/old.pdf",
      name: "old.pdf",
      type: "pdf",
      modifiedTs: now - 60 * 86400,
    });

    render(<Search query="re" results={[recent, old]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Modified" })).getByRole("button", {
        name: "Past 7 days",
      }),
    );

    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.queryByText("old.pdf")).toBeNull();
  });

  it("filters to folders only", () => {
    const folder = file({
      id: "/Users/usr/Documents/Projects",
      name: "Projects",
      type: "folder",
      isFolder: true,
      itemCount: 2,
      size: "—",
      sizeBytes: 0,
    });

    render(<Search query="re" results={[file(), folder]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Folders only" }));

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  it("composes type chips with size and folders-only filters", () => {
    const now = Date.now() / 1000;
    const bigPdf = file({
      id: "/Users/usr/Documents/big.pdf",
      name: "big.pdf",
      type: "pdf",
      sizeBytes: 120 * 1024 * 1024,
      modifiedTs: now - 86400,
    });
    const smallPdf = file({
      id: "/Users/usr/Documents/small.pdf",
      name: "small.pdf",
      type: "pdf",
      sizeBytes: 1024,
    });
    const folder = file({
      id: "/Users/usr/Documents/Projects",
      name: "Projects",
      type: "folder",
      isFolder: true,
      itemCount: 2,
      size: "—",
      sizeBytes: 0,
    });

    render(<Search query="do" results={[bigPdf, smallPdf, folder]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );

    expect(screen.getByText("big.pdf")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByText("small.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Folders only" }));

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.queryByText("big.pdf")).toBeNull();
  });

  it("resets active more filters back to any size/time and clears folders-only", () => {
    const now = Date.now() / 1000;
    const bigOld = file({
      id: "/Users/usr/Movies/movie.mp4",
      name: "movie.mp4",
      type: "mp4",
      sizeBytes: 200 * 1024 * 1024,
      modifiedTs: now - 60 * 86400,
    });
    const smallRecent = file({ sizeBytes: 10, modifiedTs: now - 86400 });

    render(<Search query="re" results={[bigOld, smallRecent]} onOpenFile={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "More filters" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "Size" })).getByRole("button", { name: "Large" }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Modified" })).getByRole("button", {
        name: "Past 7 days",
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Folders only" }));

    expect(screen.getByText("No matching results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    expect(screen.getByText("movie.mp4")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("2 results")).toBeInTheDocument();
  });
});