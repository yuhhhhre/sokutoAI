import type { Question } from "./types";

/** Keep question identity and revision independent of request completion order. */
export function mergeQuestions(
  current: Question[],
  incoming: Question[],
  explicitRetry = false,
): Question[] {
  const records = new Map(current.map((q) => [q.id, q]));
  for (const question of incoming) {
    const previous = records.get(question.id);
    if (previous && previous.revision > question.revision) continue;
    if (previous && previous.revision === question.revision) {
      if (previous.status === "cancelled" && question.status !== "cancelled")
        continue;
      if (
        !explicitRetry &&
        ["ready", "error"].includes(previous.status) &&
        ["pending", "searching"].includes(question.status)
      )
        continue;
      if (previous.status === "searching" && question.status === "pending")
        continue;
    }
    records.set(question.id, question);
  }
  return [...records.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}
export function initialSelection(
  selectedId: string | null,
  questions: Question[],
): string | null {
  return (
    selectedId ?? questions.find((q) => q.status !== "cancelled")?.id ?? null
  );
}
export function unseenCount(questions: Question[], seen: Set<string>) {
  return questions.filter((q) => q.status !== "cancelled" && !seen.has(q.id))
    .length;
}
