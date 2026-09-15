import { describe, expect, it } from "vitest";
import {
  AI_QUALITY_TOOL_ROUNDS,
  aiQualityToToolRounds,
  isAiQuality,
} from "./aiQuality.js";

describe("aiQuality", () => {
  it("maps the three tiers to the documented tool-round bounds", () => {
    expect(AI_QUALITY_TOOL_ROUNDS).toEqual({ low: 3, medium: 5, high: 8 });
    expect(aiQualityToToolRounds("low")).toBe(3);
    expect(aiQualityToToolRounds("medium")).toBe(5);
    expect(aiQualityToToolRounds("high")).toBe(8);
  });

  it("isAiQuality accepts only the lowercase wire values", () => {
    expect(isAiQuality("low")).toBe(true);
    expect(isAiQuality("medium")).toBe(true);
    expect(isAiQuality("high")).toBe(true);
    expect(isAiQuality("Low")).toBe(false);
    expect(isAiQuality("super")).toBe(false);
    expect(isAiQuality("")).toBe(false);
    expect(isAiQuality(5)).toBe(false);
    expect(isAiQuality(undefined)).toBe(false);
  });

  it("fails closed on absent, unknown, or malformed values", () => {
    expect(aiQualityToToolRounds(undefined)).toBeUndefined();
    expect(aiQualityToToolRounds(null)).toBeUndefined();
    expect(aiQualityToToolRounds("super")).toBeUndefined();
    expect(aiQualityToToolRounds("Low")).toBeUndefined();
    expect(aiQualityToToolRounds(4)).toBeUndefined();
    expect(aiQualityToToolRounds({})).toBeUndefined();
  });
});