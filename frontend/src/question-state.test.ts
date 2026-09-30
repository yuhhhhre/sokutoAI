import { describe, it, expect } from "vitest";
import {
  mergeQuestions,
  initialSelection,
  unseenCount,
} from "./question-state";
import type { Question } from "./types";
const q = (
  id: string,
  revision = 1,
  status: Question["status"] = "ready",
): Question => ({
  id,
  revision,
  status,
  meeting_id: "m1",
  text: id,
  source: "manual",
  answer: "根拠",
  conditions: [],
  missing_points: [],
  evidence_state: "supported",
  citations: [],
  outcome: "",
  error: "",
  created_at: `2026-01-01T00:00:0${id}Z`,
  elapsed_ms: null,
});
describe("live question identity", () => {
  it("allows an explicit retry but rejects a stale polling regression", () => {
    expect(
      mergeQuestions([q("1", 1, "error")], [q("1", 1, "searching")], true)[0]
        .status,
    ).toBe("searching");
    expect(
      mergeQuestions([q("1", 1, "searching")], [q("1", 1, "pending")])[0]
        .status,
    ).toBe("searching");
  });
  it("keeps the selected question when later answers arrive out of order", () => {
    const questions = mergeQuestions(
      [q("1", 1, "pending"), q("2", 1, "pending")],
      [q("2")],
    );
    expect(initialSelection("1", questions)).toBe("1");
    expect(questions.find((x) => x.id === "1")?.status).toBe("pending");
    expect(unseenCount(questions, new Set(["1"]))).toBe(1);
  });
  it("rejects a pre-edit answer and a cancelled request response", () => {
    expect(
      mergeQuestions([q("1", 2, "pending")], [q("1", 1)])[0].revision,
    ).toBe(2);
    expect(
      mergeQuestions([q("1", 2, "cancelled")], [q("1", 2)])[0].status,
    ).toBe("cancelled");
  });
  it("does not regress a completed answer when a stale polling snapshot arrives", () => {
    expect(mergeQuestions([q("1")], [q("1", 1, "pending")])[0].status).toBe(
      "ready",
    );
    expect(mergeQuestions([q("1")], [q("1", 2, "pending")])[0].status).toBe(
      "pending",
    );
  });
  it("deduplicates retries and skips cancelled initial questions", () => {
    expect(mergeQuestions([q("1")], [q("1"), q("1")])).toHaveLength(1);
    expect(initialSelection(null, [q("1", 1, "cancelled"), q("2")])).toBe("2");
  });
});
