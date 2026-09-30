import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  Search,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  UploadCloud,
} from "lucide-react";
import type { Features, KnowledgeDocument, User } from "./types";
import { api, errorMessage, json } from "./api";
import {
  Badge,
  dateTime,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
} from "./components";
export default function DocumentsPage({
  user,
  features,
}: {
  user: User;
  features: Features;
}) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [upload, setUpload] = useState(false),
    [detail, setDetail] = useState<KnowledgeDocument | null>(null),
    [deleting, setDeleting] = useState<KnowledgeDocument | null>(null),
    [success, setSuccess] = useState("");
  const load = async () => {
    try {
      setDocuments(await api<KnowledgeDocument[]>("documents/"));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const open = async (doc: KnowledgeDocument) => {
    try {
      setDetail(await api<KnowledgeDocument>(`documents/${doc.id}/`));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const toggle = async (doc: KnowledgeDocument) => {
    try {
      await api(`documents/${doc.id}/`, json("PATCH", { active: !doc.active }));
      setSuccess(
        doc.active
          ? "検索対象から外しました。回答時点の引用は保持されます。"
          : "検索対象に追加しました。",
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const filtered = documents.filter((d) =>
    d.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">KNOWLEDGE LIBRARY</div>
          <h1>商品資料・FAQ</h1>
          <p>商談の答えを支える、チーム共通のナレッジ。</p>
        </div>
        {user.role === "admin" && (
          <button
            className="button button-primary"
            onClick={() => setUpload(true)}
          >
            <Plus size={18} />
            資料を登録
          </button>
        )}
      </div>
      <div className="library-intro">
        <span className="feature-icon">
          <BookOpen size={24} />
        </span>
        <div>
          <h2>回答の根拠になる資料を、ここに。</h2>
          <p>
            {features.real_data_allowed
              ? "顧客への説明に使える商品資料・FAQを登録してください。"
              : "いまは架空データで検証中です。架空の商品仕様・料金表・FAQを登録してください。"}
          </p>
        </div>
        <ShieldCheck size={26} className="muted" />
      </div>
      {user.role !== "admin" && (
        <Notice>
          資料はチームで共有しています。登録・変更は管理担当者に依頼してください。
        </Notice>
      )}
      <ErrorNotice message={error} retry={() => void load()} />
      {success && (
        <div className="notice notice-success" role="status">
          <Check size={18} />
          {success}
        </div>
      )}
      <div className="section-heading">
        <h2>
          登録資料 <span className="count">{documents.length}</span>
        </h2>
        <label className="search-input">
          <Search size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="資料名で検索"
            placeholder="資料名で検索"
          />
        </label>
      </div>
      {loading ? (
        <Loading />
      ) : !filtered.length ? (
        <div className="list-card">
          <Empty
            title={
              documents.length
                ? "一致する資料がありません"
                : "回答の根拠になる資料が未登録です"
            }
            icon={<FolderOpen size={28} />}
            action={
              documents.length ? (
                <button
                  className="button button-secondary"
                  onClick={() => setQuery("")}
                >
                  絞り込みを解除
                </button>
              ) : user.role === "admin" ? (
                <button
                  className="button button-primary"
                  onClick={() => setUpload(true)}
                >
                  <Plus size={17} />
                  資料を登録
                </button>
              ) : undefined
            }
          >
            {documents.length
              ? "別の資料名で検索してください。"
              : "商品仕様・料金・導入条件が分かる資料を登録すると、回答候補を検索できます。"}
          </Empty>
        </div>
      ) : (
        <div className="document-grid">
          {filtered.map((doc) => (
            <article
              className={`document-card ${!doc.active ? "document-inactive" : ""}`}
              key={doc.id}
            >
              <div className="document-card-top">
                <span className="document-icon">
                  <FileText size={25} />
                </span>
                <Badge
                  tone={
                    doc.status === "ready"
                      ? "success"
                      : doc.status === "partial"
                        ? "warning"
                        : "danger"
                  }
                >
                  {doc.status === "ready"
                    ? "利用可能"
                    : doc.status === "partial"
                      ? "一部読み取り不可"
                      : "読み取り失敗"}
                </Badge>
              </div>
              <button className="document-name" onClick={() => void open(doc)}>
                {doc.name}
              </button>
              <div className="document-tags">
                <span>{doc.source_type?.toUpperCase() || "TEXT"}</span>
                {doc.is_sample && <Badge>架空データ</Badge>}
              </div>
              <div className="document-metadata">
                <span>
                  版情報<strong>{doc.version || "版情報なし"}</strong>
                </span>
                <span>
                  登録日<strong>{dateTime(doc.created_at)}</strong>
                </span>
              </div>
              {doc.error && <p className="document-error">{doc.error}</p>}
              <div className="document-card-bottom">
                <span className={`search-target ${doc.active ? "active" : ""}`}>
                  <span className="status-dot" />
                  {doc.active ? "検索対象" : "検索対象外"}
                </span>
                <button className="text-button" onClick={() => void open(doc)}>
                  内容を見る
                  <ChevronRight size={16} />
                </button>
              </div>
              {user.role === "admin" && (
                <div className="document-management">
                  <button
                    className="text-button subtle"
                    disabled={doc.status === "failed"}
                    onClick={() => void toggle(doc)}
                  >
                    {doc.active ? (
                      <ToggleRight size={18} />
                    ) : (
                      <ToggleLeft size={18} />
                    )}{" "}
                    {doc.active ? "検索対象から外す" : "検索対象にする"}
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={`${doc.name}を完全削除`}
                    onClick={() => setDeleting(doc)}
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {upload && (
        <UploadDocument
          documents={documents}
          features={features}
          onClose={() => setUpload(false)}
          onComplete={() => {
            setUpload(false);
            setSuccess("資料を登録しました。読み取り状態を確認してください。");
            void load();
          }}
        />
      )}
      {detail && (
        <Modal title="登録資料の内容" onClose={() => setDetail(null)} wide>
          <div className="source-detail">
            <h3>{detail.name}</h3>
            <p className="muted">
              {detail.version || "版情報なし"} ·{" "}
              {detail.is_sample ? "架空データ" : "登録資料"}
            </p>
            <ErrorNotice message={detail.error} />
            {detail.chunks?.length ? (
              detail.chunks.map((chunk) => (
                <section className="document-chunk" key={chunk.id}>
                  <h4>{chunk.location}</h4>
                  <p className="source-original">{chunk.text}</p>
                </section>
              ))
            ) : (
              <Empty title="この資料から文章を取り出せませんでした">
                ファイルを差し替え、再度登録してください。
              </Empty>
            )}
          </div>
        </Modal>
      )}
      {deleting && (
        <DeleteDocument
          document={deleting}
          onClose={() => setDeleting(null)}
          onComplete={() => {
            setDeleting(null);
            setSuccess("資料と関連する回答履歴を完全削除しました。");
            void load();
          }}
        />
      )}
    </>
  );
}
function UploadDocument({
  documents,
  features,
  onClose,
  onComplete,
}: {
  documents: KnowledgeDocument[];
  features: Features;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [name, setName] = useState(""),
    [version, setVersion] = useState(""),
    [replacesId, setReplacesId] = useState(""),
    [sample, setSample] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const choose = (selected: File | undefined) => {
    if (!selected) return;
    if (selected.size > features.max_upload_mb * 1024 * 1024) {
      setError(`ファイルは${features.max_upload_mb}MB以下にしてください。`);
      return;
    }
    setFile(selected);
    if (!name) setName(selected.name.replace(/\.[^.]+$/, ""));
    setError("");
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    form.append("name", name);
    form.append("version", version);
    form.append("is_sample", String(sample));
    if (replacesId) form.append("replaces_id", replacesId);
    try {
      await api("documents/", { method: "POST", body: form });
      onComplete();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="商品資料・FAQを登録" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">
          顧客への説明に使える資料を登録してください。版を更新する場合は、差し替える資料を指定してください。新版をすべて読み取れた場合に、旧版を検索対象から外します。
        </p>
        <div
          className={`upload-dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files[0]);
          }}
        >
          <UploadCloud size={30} />
          <strong>{file ? file.name : "ファイルをドラッグ＆ドロップ"}</strong>
          <span className="small muted">または</span>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => input.current?.click()}
          >
            ファイルを選択
          </button>
          <input
            ref={input}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            accept=".txt,.md,.markdown,.pdf"
            aria-label="登録する資料"
            onChange={(e) => choose(e.target.files?.[0])}
          />
          <span className="small muted">
            TXT・Markdown・文字選択可能なPDF / {features.max_upload_mb}MBまで
          </span>
        </div>
        <label className="field">
          資料名
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label className="field">
          版・資料の更新日 <span className="muted small">任意</span>
          <input
            placeholder="例：v1.0 / 2026年9月版"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            maxLength={100}
          />
          <span className="field-hint">
            不明な場合は空欄にしてください。登録日とは区別します。
          </span>
        </label>
        <label className="field">
          差し替える資料
          <select
            value={replacesId}
            onChange={(e) => setReplacesId(e.target.value)}
          >
            <option value="">新しい資料として追加</option>
            {documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}（{doc.version || "版情報なし"}）
              </option>
            ))}
          </select>
          <span className="field-hint">
            旧版の引用は回答時点の資料として保持します。
          </span>
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={sample}
            onChange={(e) => setSample(e.target.checked)}
          />
          この資料は架空データです
        </label>
        {!features.real_data_allowed && (
          <p className="small muted">
            初期検証では架空データのみ登録できます。実資料の利用はまだ許可されていません。
          </p>
        )}
        <ErrorNotice message={error} />
        {busy && <Loading label="資料を送信・読み取り中" />}
        <div className="modal-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            キャンセル
          </button>
          <button
            className="button button-primary"
            disabled={busy || !file || (!features.real_data_allowed && !sample)}
          >
            <Plus size={16} />
            資料を登録
          </button>
        </div>
      </form>
    </Modal>
  );
}
function DeleteDocument({
  document,
  onClose,
  onComplete,
}: {
  document: KnowledgeDocument;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [preview, setPreview] = useState<{
      affected_questions: number;
      chunk_count: number;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ affected_questions: number; chunk_count: number }>(
      `documents/${document.id}/delete-preview/`,
    )
      .then(setPreview)
      .catch((e) => setError(errorMessage(e)));
  }, [document.id]);
  return (
    <Modal title="資料を完全削除" onClose={onClose}>
      <div className="form-stack">
        <p>
          <strong>{document.name}</strong>
          を完全に削除します。この操作は取り消せません。
        </p>
        {preview ? (
          <Notice tone="warning">
            原文と検索データ {preview.chunk_count}
            件、この資料を引用する質問・回答履歴 {preview.affected_questions}
            件を削除します。過去の引用を残す場合は「検索対象から外す」を使ってください。
          </Notice>
        ) : (
          <Loading label="削除の影響を確認しています" />
        )}
        <ErrorNotice message={error} />
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="button button-danger"
            disabled={!preview || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`documents/${document.id}/`, { method: "DELETE" });
                onComplete();
              } catch (e) {
                setError(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            <Trash2 size={16} />
            {busy ? "削除中…" : "完全削除する"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
