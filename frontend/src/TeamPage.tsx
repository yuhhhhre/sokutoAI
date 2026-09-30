import { useEffect, useState } from "react";
import { Plus, ShieldCheck, UserPlus, Users } from "lucide-react";
import { api, errorMessage, json } from "./api";
import type { User } from "./types";
import {
  Badge,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
} from "./components";
export default function TeamPage({ user }: { user: User }) {
  const [members, setMembers] = useState<User[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(false),
    [changing, setChanging] = useState<{
      member: User;
      data: { is_active?: boolean; role?: "admin" | "member" };
    } | null>(null),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setMembers(await api<User[]>("members/"));
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
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">TEAM SETTINGS</div>
          <h1>チーム管理</h1>
          <p>{user.team_name}の利用者と権限を管理します。</p>
        </div>
        <button
          className="button button-primary"
          onClick={() => setAdding(true)}
        >
          <Plus size={18} />
          メンバーを追加
        </button>
      </div>
      <Notice>
        商品資料はチーム共有、商談履歴は本人のみが閲覧できます。管理担当者も、他のメンバーの商談履歴は閲覧できません。
      </Notice>
      <ErrorNotice message={error} />
      <div className="section-heading">
        <h2>
          <Users size={20} />
          メンバー <span className="count">{members.length}</span>
        </h2>
      </div>
      <div className="list-card">
        {loading ? (
          <Loading />
        ) : !members.length ? (
          <Empty title="メンバーはいません" />
        ) : (
          members.map((member) => (
            <div className="member-row" key={member.id}>
              <span className="avatar">
                {(member.display_name || member.username).slice(0, 1)}
              </span>
              <div className="member-name">
                <strong>
                  {member.display_name || member.username}
                  {member.id === user.id && <Badge>あなた</Badge>}
                </strong>
                <span>{member.username}</span>
              </div>
              <label className="member-role">
                <span className="visually-hidden">
                  {member.display_name}の権限
                </span>
                <select
                  value={member.role}
                  disabled={member.id === user.id}
                  onChange={(e) =>
                    setChanging({
                      member,
                      data: { role: e.target.value as "admin" | "member" },
                    })
                  }
                >
                  <option value="admin">管理担当者</option>
                  <option value="member">営業担当者</option>
                </select>
              </label>
              <Badge tone={member.is_active ? "success" : "neutral"}>
                {member.is_active ? "利用中" : "利用停止"}
              </Badge>
              <button
                className="button button-secondary"
                disabled={member.id === user.id}
                onClick={() =>
                  setChanging({
                    member,
                    data: { is_active: !member.is_active },
                  })
                }
              >
                {member.is_active ? "利用を停止" : "利用を再開"}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="roles-explanation">
        <div>
          <ShieldCheck size={21} />
          <h3>管理担当者</h3>
          <p>
            メンバーの追加・利用停止、資料の登録・管理、自分の商談を操作します。
          </p>
        </div>
        <div>
          <Users size={21} />
          <h3>営業担当者</h3>
          <p>チームの資料を参照して、自分の商談と質問・回答を操作します。</p>
        </div>
      </div>
      {adding && (
        <AddMember
          onClose={() => setAdding(false)}
          onComplete={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {changing && (
        <Modal title="メンバーの設定を変更" onClose={() => setChanging(null)}>
          <div className="form-stack">
            <p>
              <strong>
                {changing.member.display_name || changing.member.username}
              </strong>
              さんの
              {changing.data.role
                ? `権限を「${changing.data.role === "admin" ? "管理担当者" : "営業担当者"}」に変更します。`
                : changing.data.is_active
                  ? "利用を再開します。"
                  : "利用を停止します。ログイン中のアクセスも制限されます。"}
            </p>
            <ErrorNotice message={error} />
            <div className="modal-actions">
              <button
                className="button button-secondary"
                onClick={() => setChanging(null)}
              >
                キャンセル
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(
                      `members/${changing.member.id}/`,
                      json("PATCH", changing.data),
                    );
                    setChanging(null);
                    await load();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                変更を保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function AddMember({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) {
  const [form, setForm] = useState({
      username: "",
      password: "",
      display_name: "",
      role: "member",
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="メンバーを追加" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("members/", json("POST", form));
            onComplete();
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        <label className="field">
          表示名
          <input
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            required
            autoFocus
          />
        </label>
        <label className="field">
          ユーザー名
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            autoComplete="off"
          />
        </label>
        <label className="field">
          初期パスワード
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            autoComplete="new-password"
          />
          <span className="field-hint">
            8文字以上。本人へ安全な方法で共有してください。
          </span>
        </label>
        <label className="field">
          権限
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            <option value="member">営業担当者</option>
            <option value="admin">管理担当者</option>
          </select>
        </label>
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
            <UserPlus size={17} />
            {busy ? "追加中…" : "メンバーを追加"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
