import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  FileSearch,
  Files,
  MessageSquareText,
  X,
  Zap,
} from "lucide-react";
import type { Question } from "./types";

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? "brand-small" : ""}`}>
      <span className="brand-mark">
        <Zap size={22} strokeWidth={2.6} fill="currentColor" />
      </span>
      <span>
        ソクトウ<span className="brand-ai">AI</span>
      </span>
    </div>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function EvidenceBadge({
  state,
}: {
  state: Question["evidence_state"];
}) {
  if (!state) return null;
  const definitions = {
    supported: { label: "根拠あり", tone: "info", icon: BookOpen },
    partial: { label: "一部のみ確認", tone: "warning", icon: AlertTriangle },
    missing: { label: "根拠が見つからない", tone: "neutral", icon: FileSearch },
    conflict: { label: "資料間で相違あり", tone: "warning", icon: Files },
  };
  const item = definitions[state],
    Icon = item.icon;
  return (
    <Badge tone={item.tone}>
      <Icon size={15} aria-hidden="true" />
      {item.label}
    </Badge>
  );
}
export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return message ? (
    <div className="notice notice-danger" role="alert">
      <AlertCircle size={20} aria-hidden="true" />
      <div>
        {message}
        {retry && (
          <button className="text-button" onClick={retry}>
            再試行する <ArrowRight size={16} />
          </button>
        )}
      </div>
    </div>
  ) : null;
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <AlertCircle size={19} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        {icon || <MessageSquareText size={26} />}
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Loading({ label = "読み込み中" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="loading-dot" />
      {label}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id="dialog-title">{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="閉じる"
        >
          <X size={22} />
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
export function Outcome({
  value,
  onChange,
}: {
  value: Question["outcome"];
  onChange: (value: Question["outcome"]) => void;
}) {
  return (
    <div className="outcome">
      <div>
        <span className="eyebrow">担当者の対応結果</span>
        <span className="muted small"> あとから変更できます</span>
      </div>
      <div className="button-row">
        <button
          className={`button button-secondary ${value === "answered" ? "is-selected" : ""}`}
          aria-pressed={value === "answered"}
          onClick={() => onChange(value === "answered" ? "" : "answered")}
        >
          <Check size={17} />
          回答できた
        </button>
        <button
          className={`button button-secondary ${value === "follow_up" ? "is-selected" : ""}`}
          aria-pressed={value === "follow_up"}
          onClick={() => onChange(value === "follow_up" ? "" : "follow_up")}
        >
          <AlertCircle size={17} />
          要確認
        </button>
      </div>
    </div>
  );
}
export const dateTime = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
export const timeOnly = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
