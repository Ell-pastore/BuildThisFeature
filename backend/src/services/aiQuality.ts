/**
 * AI Quality tiers (Phase 10.40).
 *
 * A user-facing preference, carried on `POST /api/ai/instructions` as the
 * `x-ai-quality` request header by the web/desktop host. It maps to a cap on
 * how many tool rounds NEW conversations get — Low 3 / Medium 5 / High 8 —
 * and is resolved SERVER-SIDE so the client can never choose an unbounded
 * loop: an unset, unknown, or malformed value maps to `undefined`, and the
 * caller keeps its fail-closed default bound.
 *
 * Security/approval semantics are untouched: the tier only bounds the loop of
 * NEW conversations. A resumed conversation ALWAYS keeps its persisted bound
 * (see `runPersistentTurn`), and tool policy/approvals are independent of it.
 */

/** The only accepted wire values (lowercase; the web sends `toLowerCase()`). */
export const AI_QUALITY_VALUES = ["low", "medium", "high"] as const;

export type AiQuality = (typeof AI_QUALITY_VALUES)[number];

/** Tool-round bound per tier. */
export const AI_QUALITY_TOOL_ROUNDS: Record<AiQuality, number> = {
  low: 3,
  medium: 5,
  high: 8,
};

export function isAiQuality(v: unknown): v is AiQuality {
  return (
    typeof v === "string" &&
    (AI_QUALITY_VALUES as readonly string[]).includes(v)
  );
}

/**
 * Map a request's AI quality wire value to its tool-round bound, or
 * `undefined` when the value is absent, unknown, or malformed — callers then
 * fall back to their existing default bound (fail-closed).
 */
export function aiQualityToToolRounds(quality: unknown): number | undefined {
  return isAiQuality(quality) ? AI_QUALITY_TOOL_ROUNDS[quality] : undefined;
}