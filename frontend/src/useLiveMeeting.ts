import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage, json } from "./api";
import { initialSelection, mergeQuestions } from "./question-state";
import type { Meeting, Question, Transcript } from "./types";

export function useLiveMeeting(id: string) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [seen, setSeen] = useState(new Set<string>());
  const latest = useRef<Meeting | null>(null);
  const pauseRef = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutation = useRef(0);
  const pollSequence = useRef(0);
  const requests = useRef(new Map<string, AbortController>());
  const started = useRef(new Set<string>());

  const publish = useCallback(() => {
    if (!mounted.current || pauseRef.current || !latest.current) return;
    setMeeting({ ...latest.current });
    setSelectedId((previous) =>
      initialSelection(
        previous && latest.current?.questions?.some((q) => q.id === previous)
          ? previous
          : null,
        latest.current?.questions || [],
      ),
    );
  }, []);
  useEffect(() => {
    if (selectedId) setSeen((current) => new Set(current).add(selectedId));
  }, [selectedId]);

  const merge = useCallback(
    (questions: Question[], explicitRetry = false) => {
      if (!latest.current || !mounted.current) return;
      mutation.current++;
      latest.current = {
        ...latest.current,
        questions: mergeQuestions(
          latest.current.questions || [],
          questions,
          explicitRetry,
        ),
      };
      publish();
    },
    [publish],
  );

  const process = useCallback(
    async (q: Question) => {
      const key = `${q.id}:${q.revision}`;
      if (started.current.has(key) || !mounted.current) return;
      started.current.add(key);
      const epoch = generation.current;
      const controller = new AbortController();
      requests.current.set(key, controller);
      const currentAttempt = () =>
        mounted.current &&
        generation.current === epoch &&
        requests.current.get(key) === controller;
      merge(
        [
          {
            ...q,
            status: "searching",
            error: "",
            started_at: new Date().toISOString(),
          },
        ],
        true,
      );
      const timeout = window.setTimeout(() => controller.abort(), 30000);
      try {
        const result = await api<Question>(`questions/${q.id}/answer/`, {
          ...json("POST", { revision: q.revision }),
          signal: controller.signal,
        });
        if (currentAttempt() && !controller.signal.aborted) {
          merge([result]);
          // Another window may already own this request; polling observes completion.
          if (result.status === "searching") started.current.delete(key);
        }
      } catch (e) {
        if (currentAttempt() && !(e instanceof ApiError && e.status === 409)) {
          merge([
            {
              ...q,
              status: "error",
              error: controller.signal.aborted
                ? "時間内に回答を準備できませんでした。再試行してください。"
                : errorMessage(e),
            },
          ]);
        }
      } finally {
        clearTimeout(timeout);
        if (requests.current.get(key) === controller)
          requests.current.delete(key);
      }
    },
    [merge],
  );

  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const sequence = ++pollSequence.current;
    const beforeMutation = mutation.current;
    try {
      const result = await api<Meeting>(`meetings/${id}/`);
      // A snapshot requested before an edit/outcome/new question must not undo it.
      if (
        !mounted.current ||
        generation.current !== epoch ||
        sequence !== pollSequence.current ||
        beforeMutation !== mutation.current
      )
        return;
      const ids = new Set(result.questions?.map((q) => q.id) || []);
      latest.current = {
        ...result,
        questions: mergeQuestions(
          (latest.current?.questions || []).filter((q) => ids.has(q.id)),
          result.questions || [],
        ),
      };
      setError("");
      publish();
      for (const question of latest.current.questions || []) {
        if (question.status === "pending" && result.status === "active")
          void process(question);
        if (
          question.status === "searching" &&
          question.started_at &&
          Date.now() - Date.parse(question.started_at) >= 30000
        ) {
          merge([
            {
              ...question,
              status: "error",
              error: "時間内に回答を準備できませんでした。再試行してください。",
            },
          ]);
        }
      }
    } catch (e) {
      if (
        mounted.current &&
        generation.current === epoch &&
        e instanceof ApiError &&
        [401, 403, 404].includes(e.status)
      ) {
        // Permission loss is not a paused display update: remove cached content.
        latest.current = null;
        setMeeting(null);
        requests.current.forEach((controller) => controller.abort());
        requests.current.clear();
      }
      if (
        mounted.current &&
        generation.current === epoch &&
        sequence === pollSequence.current
      )
        setError(errorMessage(e));
    }
  }, [id, merge, process, publish]);

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      mounted.current = false;
      generation.current++;
      clearInterval(timer);
      requests.current.forEach((c) => c.abort());
      requests.current.clear();
      started.current.clear();
    };
  }, [refresh]);

  const select = useCallback((questionId: string) => {
    setSelectedId(questionId);
    setSeen((current) => new Set(current).add(questionId));
  }, []);
  const showLatest = () => {
    const questions =
      meeting?.questions?.filter((q) => q.status !== "cancelled") || [];
    const last = questions.at(-1);
    if (last) {
      select(last.id);
      setSeen(new Set(questions.map((q) => q.id)));
    }
  };
  const togglePause = () => {
    pauseRef.current = !pauseRef.current;
    setPaused(pauseRef.current);
    if (!pauseRef.current) publish();
  };
  const add = async (text: string, question?: Question) => {
    const result = await api<Question>(
      question ? `questions/${question.id}/` : `meetings/${id}/questions/`,
      json(
        question ? "PATCH" : "POST",
        question
          ? { text }
          : { text, source: "manual", client_id: crypto.randomUUID() },
      ),
    );
    merge([result]);
    if (!pauseRef.current) select(result.id);
    void process(result);
    return result;
  };
  const retry = (q: Question) => {
    started.current.delete(`${q.id}:${q.revision}`);
    void process(q);
  };
  const cancel = async (q: Question) => {
    await api(`questions/${q.id}/`, { method: "DELETE" });
    merge([
      {
        ...q,
        revision: q.revision + 1,
        status: "cancelled",
        answer: "",
        citations: [],
        evidence_state: null,
      },
    ]);
  };
  const outcome = async (q: Question, value: Question["outcome"]) => {
    const result = await api<Question>(
      `questions/${q.id}/`,
      json("PATCH", { outcome: value }),
    );
    merge([result]);
  };
  const ingest = useCallback(
    (response: { transcript: Transcript | null; questions: Question[] }) => {
      if (!latest.current || !mounted.current) return;
      const transcripts = latest.current.transcripts || [];
      const transcript = response.transcript;
      if (transcript && !transcripts.some((t) => t.id === transcript.id))
        latest.current = {
          ...latest.current,
          transcripts: [...transcripts, transcript],
        };
      merge(response.questions);
      for (const q of response.questions) void process(q);
    },
    [merge, process],
  );
  const end = async () => {
    await api<Meeting>(`meetings/${id}/`, json("PATCH", { status: "ended" }));
    await refresh();
  };
  return {
    meeting,
    error,
    refresh,
    selected: meeting?.questions?.find((q) => q.id === selectedId) || null,
    selectedId,
    select,
    seen,
    showLatest,
    paused,
    togglePause,
    add,
    retry,
    cancel,
    outcome,
    ingest,
    end,
  };
}
