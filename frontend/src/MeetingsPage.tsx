import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ChevronRight,
  Clock3,
  MessageSquareText,
  Monitor,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import { api, errorMessage, json } from "./api";
import type { Meeting } from "./types";
import {
  Badge,
  dateTime,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
} from "./components";
export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [create, setCreate] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setMeetings(await api<Meeting[]>("meetings/"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const filtered = meetings.filter(
    (m) =>
      (filter === "all" ||
        filter === m.status ||
        (filter === "follow_up" && m.follow_up_count > 0)) &&
      m.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MEETINGS</div>
          <h1>商談</h1>
          <p>会話に集中。答えと根拠は、すぐそばに。</p>
        </div>
        <button
          className="button button-primary"
          onClick={() => setCreate(true)}
        >
          <Plus size={19} />
          商談を開始
        </button>
      </div>
      <section className="welcome-card">
        <div className="welcome-copy">
          <Badge tone="info">
            <MessageSquareText size={15} />
            リアルタイム商談アシスト
          </Badge>
          <h2>その質問に、根拠のある回答を。</h2>
          <p>
            商品仕様・料金・導入条件を、登録資料からすばやく確認。
            <br className="desktop-only" />
            オンラインでも、対面でも。会話の流れを支えます。
          </p>
          <button className="text-button" onClick={() => setCreate(true)}>
            新しい商談をはじめる
            <ArrowRight size={17} />
          </button>
        </div>
        <div className="welcome-illustration" aria-hidden="true">
          <div className="mini-question">
            <span className="illustration-icon">
              <MessageSquareText size={18} />
            </span>
            <span>導入まで、どのくらい？</span>
            <span className="mini-dot" />
          </div>
          <div className="mini-answer">
            <div>
              <span className="answer-symbol">
                <BookOpen size={19} />
              </span>
              <strong>根拠を、ひと目で。</strong>
            </div>
            <div className="illustration-lines">
              <span />
              <span />
            </div>
            <div className="mini-source">
              <FileIcon />
              商品導入ガイド{" "}
              <span>
                引用を確認 <ArrowUpRight size={13} />
              </span>
            </div>
          </div>
          <span className="illustration-caption">
            質問 → 資料検索 → 回答候補と根拠
          </span>
        </div>
      </section>
      <section className="meetings-section">
        <div className="section-heading">
          <h2>
            あなたの商談 <span className="count">{meetings.length}</span>
          </h2>
          <span className="small muted">
            <CalendarDays size={16} />
            自分の商談のみ表示
          </span>
        </div>
        <div className="list-toolbar">
          <div className="tabs" aria-label="商談の絞り込み">
            {[
              ["all", "すべて"],
              ["active", "進行中"],
              ["ended", "終了"],
              ["follow_up", "要確認あり"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "selected" : ""}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search-input">
            <Search size={18} />
            <input
              aria-label="商談名で検索"
              placeholder="商談名で検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="検索をクリア"
                onClick={() => setQuery("")}
              >
                <X size={16} />
              </button>
            )}
          </label>
        </div>
        <ErrorNotice message={error} retry={() => void load()} />
        <div className="list-card">
          {loading ? (
            <Loading />
          ) : !filtered.length ? (
            <Empty
              title={
                meetings.length
                  ? "条件に一致する商談がありません"
                  : "まだ商談がありません"
              }
              action={
                meetings.length ? (
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setFilter("all");
                      setQuery("");
                    }}
                  >
                    絞り込みを解除
                  </button>
                ) : (
                  <button
                    className="button button-primary"
                    onClick={() => setCreate(true)}
                  >
                    <Plus size={17} />
                    最初の商談を開始
                  </button>
                )
              }
            >
              商談を開始すると、質問と回答候補がここに保存されます。
            </Empty>
          ) : (
            <>
              <div className="meeting-table-head">
                <span>商談名</span>
                <span>開始日時</span>
                <span>状態</span>
                <span>質問 / 要確認</span>
                <span />
              </div>
              {filtered.map((m) => (
                <Link
                  className="meeting-row"
                  key={m.id}
                  to={`/meetings/${m.id}`}
                >
                  <div className="meeting-title-cell">
                    <span
                      className={`meeting-mode-icon ${m.status === "active" ? "is-active" : ""}`}
                    >
                      {m.mode === "online" ? (
                        <Monitor size={21} />
                      ) : (
                        <Users size={21} />
                      )}
                    </span>
                    <div>
                      <strong>{m.title}</strong>
                      <span>
                        {m.mode === "online" ? "オンライン" : "対面"}
                        <span className="dot-separator">·</span>
                        {m.status === "active"
                          ? "アシストを再開"
                          : "質問と回答を振り返る"}
                      </span>
                    </div>
                  </div>
                  <span className="table-date">
                    <Clock3 size={14} />
                    {dateTime(m.created_at)}
                  </span>
                  <span>
                    <Badge tone={m.status === "active" ? "info" : "neutral"}>
                      <span
                        className={`status-dot ${m.status === "active" ? "blue" : ""}`}
                      />
                      {m.status === "active" ? "進行中" : "終了"}
                    </Badge>
                  </span>
                  <span className="question-counts">
                    <MessageSquareText size={16} />
                    {m.question_count}件
                    {m.follow_up_count > 0 && (
                      <span className="follow-up-count">
                        要確認 {m.follow_up_count}
                      </span>
                    )}
                  </span>
                  <ChevronRight size={19} className="muted row-arrow" />
                </Link>
              ))}
            </>
          )}
        </div>
        <p className="list-caption">
          <BookOpen size={15} />
          回答候補は登録資料に基づきます。根拠と条件を確認し、担当者が口頭で回答してください。
        </p>
      </section>
      {create && <CreateMeeting onClose={() => setCreate(false)} />}
    </>
  );
}
function FileIcon() {
  return <BookOpen size={14} />;
}
function CreateMeeting({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState(""),
    [mode, setMode] = useState<"online" | "in_person">("online"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const navigate = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const m = await api<Meeting>("meetings/", json("POST", { title, mode }));
      navigate(`/meetings/${m.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="新しい商談を開始" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          商談名と利用シーンを設定してください。音声取り込みは、開始後に選べます。
        </p>
        <label className="field">
          商談名
          <input
            placeholder="例：架空商材の導入ご相談"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            maxLength={200}
          />
        </label>
        <fieldset>
          <legend>利用シーン</legend>
          <div className="mode-options">
            <label className={mode === "online" ? "selected" : ""}>
              <input
                type="radio"
                name="mode"
                checked={mode === "online"}
                onChange={() => setMode("online")}
              />
              <Monitor size={22} />
              <strong>オンライン</strong>
              <span>会議画面の横でアシスト</span>
            </label>
            <label className={mode === "in_person" ? "selected" : ""}>
              <input
                type="radio"
                name="mode"
                checked={mode === "in_person"}
                onChange={() => setMode("in_person")}
              />
              <Users size={22} />
              <strong>対面</strong>
              <span>手元のPCでアシスト</span>
            </label>
          </div>
        </fieldset>
        <ErrorNotice message={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            onClick={onClose}
          >
            キャンセル
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? "作成中…" : "商談を開始"}
            <ArrowRight size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
