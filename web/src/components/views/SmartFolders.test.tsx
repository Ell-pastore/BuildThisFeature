import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SmartFolders from "./SmartFolders";

afterEach(cleanup);

describe("SmartFolders — honest placeholder (not implemented)", () => {
  it("shows an honest empty state instead of fabricated folders", () => {
    render(<SmartFolders />);
    expect(screen.getByText("No smart folders yet")).toBeInTheDocument();
  });

  it("does not present an actionable New smart folder control", () => {
    render(<SmartFolders />);
    expect(
      screen.queryByRole("button", { name: /new smart folder/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /new folder/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the explicit not-implemented explanation", () => {
    render(<SmartFolders />);
    expect(
      screen.getByText(/isn.t implemented yet/i),
    ).toBeInTheDocument();
  });
});
