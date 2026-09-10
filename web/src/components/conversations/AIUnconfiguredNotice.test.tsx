import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AIUnconfiguredNotice from "./AIUnconfiguredNotice";

describe("AIUnconfiguredNotice", () => {
  afterEach(cleanup);

  it("shows the clear not-configured copy with a retry control", () => {
    render(<AIUnconfiguredNotice onRetry={() => {}} />);

    expect(screen.getByTestId("ai-unconfigured-notice")).toBeInTheDocument();
    expect(screen.getByText("AI isn't configured yet")).toBeInTheDocument();
    expect(screen.getByText(/No AI provider is configured on the backend/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("fires onRetry when Try again is clicked", () => {
    const onRetry = vi.fn();
    render(<AIUnconfiguredNotice onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("contains no input field or state shown when unconfigured", () => {
    render(<AIUnconfiguredNotice onRetry={() => {}} />);
    const notice = screen.getByTestId("ai-unconfigured-notice");
    expect(notice.querySelector("input")).toBeNull();
    expect(notice.querySelector("form")).toBeNull();
  });
});