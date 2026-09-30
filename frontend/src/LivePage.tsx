import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  FlaskConical,
  History,
  Maximize2,
  MessageSquareText,
  Mic,
  Monitor,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { api, ApiError, errorMessage, json } from "./api";
import { AudioCapture, AudioTranscriptionError } from "./audio";
import type { AudioStatus } from "./audio";
import type { Citation, Features, Question, Transcript } from "./types";
import {
  Badge,
  Brand,
  Empty,
  ErrorNotice,
  EvidenceBadge,
  Loading,
  Modal,
  Notice,
  Outcome,
  timeOnly,
} from "./components";
import { unseenCount } from "./question-state";
import { useLiveMeeting } from "./useLiveMeeting";

const DEMO_LINES = [
  "本日は商品の導入について相談したいです。",
  "導入するまで、どのくらいの期間がかかりますか？",
  "料金はいくらですか？ 最低契約期間も教えてください。",
  "シングルサインオンに対応していますか？",
  "来月リリースされる新機能は使えますか？",
];
export default function LivePage({ features }: { features: Features }) {
  const { id = "" } = useParams(),
    [params] = useSearchParams(),
    compact = params.get("compact") === "1";
  const live = useLiveMeeting(id),
    { meeting, selected } = live;
  const [historyFilter, setHistoryFilter] = useState("all"),
    [manual, setManual] = useState(false),
    [editing, setEditing] = useState<Question | null>(null),
    [citation, setCitation] = useState<Citation | null>(null),
    [error, setError] = useState(""),
    [confirmCancel, setConfirmCancel] = useState<Question | null>(null),
    [confirmEnd, setConfirmEnd] = useState(false),
    [confirmAudio, setConfirmAudio] = useState(false),
    [syntheticAudio, setSyntheticAudio] = useState(false),
    [transcribingSince, setTranscribingSince] = useState<number | null>(null),
    [audio, setAudio] = useState<AudioStatus>({
      state: "idle",
      inputLabel: "未接続",
    }),
    [playing, setPlaying] = useState(false),
    [tick, setTick] = useState(Date.now());
  const capture = useRef<AudioCapture | null>(null),
    audioRequests = useRef(new Set<AbortController>()),
    audioEpoch = useRef(0),
    demoEpoch = useRef(0),
    demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    mounted = useRef(true);
  const ingestRef = useRef(live.ingest);
  ingestRef.current = live.ingest;
  const stopAudio = async () => {
    audioEpoch.current++;
    audioRequests.current.forEach((c) => c.abort());
    audioRequests.current.clear();
    if (mounted.current) {
      setTranscribingSince(null);
      setAudio({ state: "idle", inputLabel: "未接続" });
    }
    await capture.current?.stop();
  };
  const stopDemo = () => {
    demoEpoch.current++;
    if (demoTimer.current) clearTimeout(demoTimer.current);
    setPlaying(false);
  };
  useEffect(() => {
    mounted.current = true;
    setAudio({ state: "idle", inputLabel: "未接続" });
    setTranscribingSince(null);
    setPlaying(false);
    setConfirmAudio(false);
    setSyntheticAudio(false);
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      demoEpoch.current++;
      if (demoTimer.current) clearTimeout(demoTimer.current);
      void stopAudio();
    };
  }, [id]);
  useEffect(() => {
    if (meeting?.status === "ended") {
      void stopAudio();
      stopDemo();
    }
  }, [meeting?.status]);
  useEffect(() => {
    if (
      citation &&
      meeting &&
      !meeting.questions?.some((q) =>
        q.citations.some((c) => c.id === citation.id),
      )
    )
      setCitation(null);
  }, [meeting, citation]);
  const startAudio = () => {
    if (!meeting) return;
    const epoch = ++audioEpoch.current;
    setConfirmAudio(false);
    capture.current = new AudioCapture({
      onState: (status) => {
        if (!mounted.current || epoch !== audioEpoch.current) return;
        setAudio(status);
        if (status.state === "error") {
          audioEpoch.current++;
          audioRequests.current.forEach((c) => c.abort());
          audioRequests.current.clear();
          setTranscribingSince(null);
        }
      },
      onChunk: async (blob) => {
        if (epoch !== audioEpoch.current) return;
        const controller = new AbortController();
        audioRequests.current.add(controller);
        setTranscribingSince(Date.now());
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, features.transcription_timeout_ms);
        const form = new FormData();
        form.append("file", blob, "segment.wav");
        form.append("client_id", crypto.randomUUID());
        form.append(
          "is_sample",
          features.real_data_allowed && !syntheticAudio ? "false" : "true",
        );
        try {
          const result = await api<{
            transcript: Transcript | null;
            questions: Question[];
          }>(`meetings/${id}/audio/`, {
            method: "POST",
            body: form,
            signal: controller.signal,
          });
          if (mounted.current && epoch === audioEpoch.current)
            ingestRef.current(result);
        } catch (e) {
          if (epoch === audioEpoch.current)
            throw new AudioTranscriptionError(
              timedOut
                ? "音声認識が時間切れになりました。取り込みを再開するか、質問を手入力してください。"
                : e instanceof ApiError
                  ? e.message
                  : "音声認識サーバーに接続できませんでした。取り込みを再開するか、質問を手入力してください。",
            );
        } finally {
          clearTimeout(timeout);
          audioRequests.current.delete(controller);
          if (mounted.current && epoch === audioEpoch.current)
            setTranscribingSince(null);
        }
      },
    });
    void capture.current.start(meeting.mode);
  };
  const playDemo = async () => {
    const epoch = ++demoEpoch.current;
    setPlaying(true);
    setError("");
    let index = 0;
    const next = async () => {
      if (!mounted.current || demoEpoch.current !== epoch) return;
      try {
        const response = await api<{
          transcript: Transcript | null;
          questions: Question[];
        }>(
          `meetings/${id}/transcripts/`,
          json("POST", {
            text: DEMO_LINES[index],
            client_id: crypto.randomUUID(),
          }),
        );
        if (!mounted.current || demoEpoch.current !== epoch) return;
        live.ingest(response);
        index++;
        if (index < DEMO_LINES.length)
          demoTimer.current = setTimeout(() => void next(), 5000);
        else setPlaying(false);
      } catch (e) {
        setError(errorMessage(e));
        setPlaying(false);
      }
    };
    void next();
  };
  const updateOutcome = async (value: Question["outcome"]) => {
    if (!selected) return;
    try {
      await live.outcome(selected, value);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const end = async () => {
    try {
      stopDemo();
      await stopAudio();
      await live.end();
      setConfirmEnd(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!meeting)
    return (
      <>
        <ErrorNotice message={live.error} retry={() => void live.refresh()} />
        {!live.error && <Loading label="商談を読み込んでいます" />}
        <Link className="back-link" to="/meetings">
          <ArrowLeft size={17} />
          商談一覧へ
        </Link>
      </>
    );
  const questions =
      meeting.questions?.filter((q) => q.status !== "cancelled") || [],
    newCount = unseenCount(questions, live.seen),
    historyQuestions = questions.filter(
      (q) =>
        historyFilter === "all" ||
        (historyFilter === "unrecorded"
          ? q.outcome === ""
          : q.outcome === "follow_up"),
    ),
    isCapturing = ["requesting", "listening", "silent"].includes(audio.state),
    isProcessing =
      selected && ["pending", "searching"].includes(selected.status),
    delayed =
      isProcessing &&
      tick - new Date(selected.started_at || selected.created_at).getTime() >
        10000;
  return (
    <div className={`live-page ${compact ? "is-compact" : ""}`}>
      {compact && (
        <div className="compact-brand">
          <Brand small />
          {!features.real_data_allowed && <Badge tone="info">架空データ</Badge>}
        </div>
      )}
      <Link className="back-link" to="/meetings">
        <ArrowLeft size={16} />
        商談一覧
      </Link>
      <div className="live-heading">
        <div>
          <div className="eyebrow">MEETING ASSIST</div>
          <h1>{meeting.title}</h1>
          <div className="meeting-meta">
            <span>
              {meeting.mode === "online" ? (
                <Monitor size={16} />
              ) : (
                <Users size={16} />
              )}{" "}
              {meeting.mode === "online" ? "オンライン" : "対面"}
            </span>
            <span>
              <Clock3 size={15} />
              {timeOnly(meeting.created_at)} 開始
            </span>
            <Badge tone={meeting.status === "active" ? "info" : "neutral"}>
              {meeting.status === "active" ? "進行中" : "終了"}
            </Badge>
          </div>
        </div>
        <div className="button-row">
          {!compact && (
            <button
              className="button button-secondary"
              onClick={() => {
                const popup = window.open(
                  `/meetings/${id}?compact=1`,
                  "sokuto-assist",
                  "width=420,height=680,resizable=yes,scrollbars=yes",
                );
                if (!popup) window.location.assign(`/meetings/${id}?compact=1`);
              }}
            >
              <Maximize2 size={17} />
              小さく表示
            </button>
          )}
          {meeting.status === "active" && (
            <button
              className="button button-quiet"
              onClick={() => setConfirmEnd(true)}
            >
              <CircleStop size={17} />
              商談を終了
            </button>
          )}
        </div>
      </div>
      <ErrorNotice message={error || live.error} />
      <details
        className="audio-settings"
        open={!compact || isCapturing || audio.state === "error"}
      >
        <summary>
          <AudioLines size={18} />
          {audio.state === "error"
            ? "音声入力にエラーがあります"
            : isCapturing
              ? `${audio.inputLabel}・${audio.state === "listening" ? "音声検出中" : "入力を確認中"}`
              : "音声取り込み停止中"}
          <span>入力設定</span>
        </summary>
        <div className="audio-panel">
          <div className="audio-state">
            <span
              className={`audio-state-icon ${isCapturing ? "connected" : ""}`}
            >
              <AudioLines size={22} />
            </span>
            <div>
              <strong>
                {audio.state === "listening"
                  ? "音声を検出中"
                  : audio.state === "silent"
                    ? "接続済み・音声未検出"
                    : audio.state === "requesting"
                      ? "入力元の選択を待っています"
                      : audio.state === "error"
                        ? "音声入力を確認してください"
                        : "音声取り込みは停止中"}
              </strong>
              <span>
                {audio.state === "error"
                  ? audio.error
                  : audio.inputLabel === "未接続"
                    ? "質問の手入力・模擬発言でも試せます"
                    : audio.inputLabel}
              </span>
            </div>
          </div>
          <button
            className={`button ${isCapturing ? "button-secondary" : "button-primary"}`}
            disabled={
              meeting.status === "ended" ||
              (!isCapturing && !features.transcription_available)
            }
            onClick={() =>
              isCapturing ? void stopAudio() : setConfirmAudio(true)
            }
          >
            {isCapturing ? (
              <>
                <Square size={15} />
                取り込みを停止
              </>
            ) : (
              <>
                <Mic size={17} />
                音声を取り込む
              </>
            )}
          </button>
          <p className="audio-note">
            {features.transcription_label}
            {features.transcription_available && features.transcription_mode === "whisper"
              ? "。音声の外部送信なし。"
              : ""}
            <span role="status">
              {transcribingSince !== null && (
                <>
                  <br />
                  {tick - transcribingSince > 10000
                    ? "文字起こしに時間がかかっています。質問の手入力も使えます。"
                    : "音声を文字起こし中"}
                </>
              )}
            </span>
          </p>
        </div>
      </details>
      <div className="live-grid">
        <div className="live-primary">
          <div className="live-notification">
            <span role="status">
              {live.paused ? (
                <>
                  <Pause size={15} />
                  表示更新を一時停止中
                </>
              ) : newCount > 0 ? (
                <>
                  <span className="new-dot" />
                  新しい質問 {newCount}件
                </>
              ) : (
                <>
                  <Check size={15} />
                  選択した質問を表示中
                </>
              )}
            </span>
            {newCount > 0 && !live.paused && (
              <button className="text-button" onClick={live.showLatest}>
                最新の質問を見る
                <ArrowRight size={15} />
              </button>
            )}
            <button
              className="icon-button"
              onClick={live.togglePause}
              aria-label={live.paused ? "表示更新を再開" : "表示更新を一時停止"}
              title={live.paused ? "表示更新を再開" : "表示更新を一時停止"}
            >
              {live.paused ? <Play size={17} /> : <Pause size={17} />}
            </button>
          </div>
          {live.paused && (
            <p className="small muted pause-note">
              表示のみ停止しています。質問の検知・検索・音声取り込みは続きます。「更新を再開」で反映します。
              <button className="text-button" onClick={live.togglePause}>
                更新を再開
              </button>
            </p>
          )}
          {!selected ? (
            <section className="answer-card">
              <Empty
                title="質問を待っています"
                icon={<AudioLines size={28} />}
                action={
                  <button
                    className="button button-primary"
                    disabled={meeting.status === "ended"}
                    onClick={() => setManual(true)}
                  >
                    <Plus size={17} />
                    質問を入力
                  </button>
                }
              >
                質問を検知すると、ここに回答候補と根拠を表示します。
              </Empty>
            </section>
          ) : (
            <article className="answer-card">
              <span className="visually-hidden" role="status">
                {selected.status === "ready" ? "回答候補を表示しました" : ""}
              </span>
              <div className="question-block">
                <div className="section-label">
                  <span>
                    <MessageSquareText size={17} />
                    質問
                  </span>
                  <span className="small muted">
                    {timeOnly(selected.created_at)} ·{" "}
                    {selected.source === "manual"
                      ? "手入力"
                      : selected.source === "demo"
                        ? "模擬発言"
                        : "確定発言"}
                  </span>
                </div>
                <h2>{selected.text}</h2>
                <div className="question-actions">
                  <button
                    className="text-button"
                    disabled={meeting.status === "ended"}
                    onClick={() => setEditing(selected)}
                  >
                    <Pencil size={14} />
                    質問を修正
                  </button>
                  <button
                    className="text-button subtle"
                    disabled={meeting.status === "ended"}
                    onClick={() => setConfirmCancel(selected)}
                  >
                    <Trash2 size={14} />
                    取り消し
                  </button>
                </div>
              </div>
              {selected.status === "cancelled" ? (
                <Empty title="この質問は取り消されました" />
              ) : isProcessing ? (
                <div className="answer-content">
                  <Loading
                    label={
                      delayed
                        ? "回答の準備に時間がかかっています"
                        : "資料を検索中"
                    }
                  />
                  <div className="skeleton" />
                  <div className="skeleton short" />
                  <p className="small muted">
                    質問と登録資料を照合しています。回答はこの質問にひも付いて表示されます。
                  </p>
                </div>
              ) : selected.status === "error" ? (
                <div className="answer-content">
                  <ErrorNotice
                    message={selected.error || "資料を検索できませんでした。"}
                  />
                  <button
                    className="button button-secondary"
                    onClick={() => live.retry(selected)}
                  >
                    <RotateCcw size={17} />
                    再試行
                  </button>
                </div>
              ) : (
                <>
                  <div className="answer-content">
                    <div className="section-label">
                      <span>
                        <BookOpen size={17} />
                        回答候補
                      </span>
                      <EvidenceBadge state={selected.evidence_state} />
                    </div>
                    <p className="answer-text">
                      {selected.answer || "登録資料では確認できません。"}
                    </p>
                    {selected.conditions.length > 0 && (
                      <div className="conditions">
                        <h3>条件</h3>
                        <ul>
                          {selected.conditions.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selected.missing_points.length > 0 && (
                      <div className="missing-points">
                        <h3>未確認の点</h3>
                        <ul>
                          {selected.missing_points.map((point, i) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {selected.evidence_state === "conflict" && (
                      <Notice tone="warning">
                        資料の記載に相違があります。双方の条件・版を確認し、担当部署へ確認してください。
                      </Notice>
                    )}
                    {selected.citations.length > 0 && (
                      <div className="citations">
                        <h3>
                          <BookOpen size={16} />
                          回答の根拠{" "}
                          <span className="count">
                            {selected.citations.length}
                          </span>
                        </h3>
                        {selected.citations.map((c, i) => (
                          <div className="citation-card" key={c.id}>
                            <div className="citation-topline">
                              <span className="citation-number">{i + 1}</span>
                              <strong>{c.document_name}</strong>
                              {c.is_sample && <Badge>架空データ</Badge>}
                            </div>
                            <blockquote>{c.quote}</blockquote>
                            <div className="citation-meta">
                              <span>
                                {c.location} · {c.version || "版情報なし"}
                              </span>
                              <button
                                className="text-button"
                                onClick={() => setCitation(c)}
                                aria-label={`根拠${i + 1}：${c.document_name}、${c.location}の原文を見る`}
                              >
                                原文を見る
                                <ChevronRight size={15} />
                              </button>
                            </div>
                            {!c.active && (
                              <p className="small muted">
                                回答時点の資料・現在は検索対象外
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {selected.evidence_state === "missing" && (
                      <Link className="text-link" to="/documents">
                        登録資料を確認する
                        <ArrowRight size={15} />
                      </Link>
                    )}
                  </div>
                  <Outcome
                    value={selected.outcome}
                    onChange={(value) => void updateOutcome(value)}
                  />
                </>
              )}
            </article>
          )}
          <div className="live-actions">
            <button
              className="button button-secondary"
              onClick={() => setManual(true)}
              disabled={meeting.status === "ended"}
            >
              <Plus size={18} />
              質問を入力
            </button>
            <span className="small muted">
              {features.answer_mode === "local"
                ? "ローカル資料検索・原文抽出"
                : "外部AIで回答候補を生成"}
            </span>
          </div>
          <details className="transcript-panel">
            <summary>
              <span>
                <AudioLines size={18} />
                文字起こし・模擬発言
              </span>
              <span className="small muted">
                {meeting.transcripts?.length || 0}発言
                <ChevronDown size={17} />
              </span>
            </summary>
            <div className="transcript-content">
              {!meeting.transcripts?.length ? (
                <p className="muted small">
                  確定した発言はまだありません。話者は自動判定しません。
                </p>
              ) : (
                meeting.transcripts.map((t) => (
                  <div className="transcript-item" key={t.id}>
                    <span>{timeOnly(t.created_at)} · 確定</span>
                    <p>{t.text}</p>
                  </div>
                ))
              )}
            </div>
          </details>
        </div>
        <aside className="live-side">
          <section className="history-card">
            <div className="section-heading">
              <h2>
                <History size={18} />
                質問履歴
              </h2>
              <span className="count">{questions.length}</span>
            </div>
            <label className="history-filter field">
              対応結果で絞り込み
              <select
                value={historyFilter}
                onChange={(e) => setHistoryFilter(e.target.value)}
              >
                <option value="all">すべての質問</option>
                <option value="follow_up">要確認</option>
                <option value="unrecorded">未記録</option>
              </select>
            </label>
            {historyQuestions.length ? (
              historyQuestions
                .slice()
                .reverse()
                .map((q) => (
                  <button
                    className={`history-question ${selected?.id === q.id ? "selected" : ""}`}
                    key={q.id}
                    onClick={() => live.select(q.id)}
                  >
                    <span className="history-time">
                      {timeOnly(q.created_at)}
                      {q.outcome === "follow_up" && (
                        <span className="follow-up-count">要確認</span>
                      )}
                    </span>
                    <strong>{q.text}</strong>
                    <div>
                      {q.status === "error" ? (
                        <Badge tone="danger">検索エラー</Badge>
                      ) : q.status === "ready" ? (
                        <EvidenceBadge state={q.evidence_state} />
                      ) : (
                        <Badge>資料を検索中</Badge>
                      )}
                    </div>
                  </button>
                ))
            ) : (
              <p className="history-empty">
                {questions.length
                  ? "この条件に一致する質問はありません。"
                  : "検知した質問がここに並びます。"}
                {historyFilter !== "all" && (
                  <button
                    className="text-button"
                    onClick={() => setHistoryFilter("all")}
                  >
                    絞り込みを解除
                  </button>
                )}
              </p>
            )}
          </section>
          <section className="demo-card">
            <div className="section-label">
              <span>
                <FlaskConical size={18} />
                模擬商談を試す
              </span>
              <Badge>架空データ</Badge>
            </div>
            <p>用意した発言から質問を検知し、登録資料を実際に検索します。</p>
            <button
              className="button button-secondary full-width"
              disabled={meeting.status === "ended"}
              onClick={() => (playing ? stopDemo() : void playDemo())}
            >
              {playing ? (
                <>
                  <Pause size={16} />
                  模擬発言を停止
                </>
              ) : (
                <>
                  <Play size={16} />
                  模擬発言を流す
                </>
              )}
            </button>
            <span className="small muted">
              音声の再生・取り込みではありません。
            </span>
          </section>
          <div className="live-tip">
            <BookOpen size={18} />
            <p>
              回答候補は、原文と条件を確認してからお伝えください。「根拠あり」は正しさの保証ではありません。
            </p>
          </div>
        </aside>
      </div>
      {(manual || editing) && (
        <QuestionEditor
          question={editing}
          onClose={() => {
            setManual(false);
            setEditing(null);
          }}
          onSave={async (text) => {
            await live.add(text, editing || undefined);
            setManual(false);
            setEditing(null);
          }}
        />
      )}
      {citation && (
        <Modal title="回答の根拠" onClose={() => setCitation(null)} wide>
          <div className="source-detail">
            <Badge tone={citation.active ? "info" : "neutral"}>
              {citation.active
                ? "現在の検索対象"
                : "回答時点の資料・現在は検索対象外"}
            </Badge>
            <h3>{citation.document_name}</h3>
            <p className="muted">
              {citation.location} · {citation.version || "版情報なし"}
              {citation.is_sample ? " · 架空データ" : ""}
            </p>
            <div className="source-context">
              <div className="eyebrow">引用箇所</div>
              <blockquote>{citation.quote}</blockquote>
            </div>
            <h4>原文・前後の文脈</h4>
            <p className="source-original">
              {citation.context || citation.quote}
            </p>
            <button
              className="button button-secondary"
              onClick={() => setCitation(null)}
            >
              <ArrowLeft size={16} />
              回答に戻る
            </button>
          </div>
        </Modal>
      )}
      {confirmCancel && (
        <Modal title="質問を取り消す" onClose={() => setConfirmCancel(null)}>
          <p>この質問の処理を取り消します。</p>
          <blockquote className="confirm-quote">
            {confirmCancel.text}
          </blockquote>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setConfirmCancel(null)}
            >
              戻る
            </button>
            <button
              className="button button-danger"
              onClick={async () => {
                try {
                  await live.cancel(confirmCancel);
                  setConfirmCancel(null);
                } catch (e) {
                  setError(errorMessage(e));
                  setConfirmCancel(null);
                }
              }}
            >
              質問を取り消す
            </button>
          </div>
        </Modal>
      )}
      {confirmEnd && (
        <Modal title="商談を終了" onClose={() => setConfirmEnd(false)}>
          <p>
            音声取り込みと模擬発言を停止します。これまでの質問・回答と対応結果は、あとから確認できます。
          </p>
          <div className="modal-actions">
            <button
              className="button button-secondary"
              onClick={() => setConfirmEnd(false)}
            >
              商談を続ける
            </button>
            <button
              className="button button-primary"
              onClick={() => void end()}
            >
              商談を終了
            </button>
          </div>
        </Modal>
      )}
      {confirmAudio && (
        <Modal
          title="音声の入力元を確認"
          onClose={() => setConfirmAudio(false)}
        >
          <div className="form-stack">
            <p>
              {meeting.mode === "online"
                ? "次の画面で会議の音声を共有できる画面・タブを選び、音声の共有を有効にしてください。OS・ブラウザによって会議アプリの音声を取得できない場合があります。"
                : "マイクで同席者の音声を取り込みます。次の画面でマイクへのアクセスを許可してください。"}
            </p>
            <Notice>
              {features.transcription_mode === "whisper"
                ? "音声はアプリのローカルサーバーでWhisperが認識します。音声を外部AIへ送信せず、音声ファイルも保存しません。"
                : "音声は外部AIの文字起こしサービスへ送信します。音声ファイルはアプリに保存しません。"}
              画面映像は送信・保存しません。
              {features.answer_mode === "openai" && "回答生成には、認識後の質問・会話文脈・参照資料を外部AIへ送信します。"}
            </Notice>
            {!features.real_data_allowed && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={syntheticAudio}
                  onChange={(e) => setSyntheticAudio(e.target.checked)}
                />
                架空の商材による模擬商談音声を使用します
              </label>
            )}
            <button
              className="button button-primary"
              disabled={!features.real_data_allowed && !syntheticAudio}
              onClick={startAudio}
            >
              <Mic size={17} />
              入力元を選んで開始
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function QuestionEditor({
  question,
  onSave,
  onClose,
}: {
  question: Question | null;
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(question?.text || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={question ? "質問を修正" : "質問を入力"} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave(text);
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <label className="field">
          確認したい質問
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例：標準プランの料金と契約条件を教えてください"
            required
            autoFocus
            maxLength={2000}
          />
          <span className="field-hint">
            Enterで改行できます。登録資料から回答と根拠を検索します。
          </span>
        </label>
        <ErrorNotice message={error} />
        <div className="modal-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onClose}
          >
            キャンセル
          </button>
          <button
            className="button button-primary"
            disabled={busy || !text.trim()}
          >
            <Send size={16} />
            {busy ? "送信中…" : "回答を検索"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
