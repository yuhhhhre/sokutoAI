import { useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  CircleHelp,
  FileText,
  FlaskConical,
  LogOut,
  Menu,
  MessageSquareText,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { api, errorMessage, json, setCsrfToken } from "./api";
import type { Features, User } from "./types";
import { Badge, Brand, ErrorNotice, Loading } from "./components";
import MeetingsPage from "./MeetingsPage";
import LivePage from "./LivePage";
import DocumentsPage from "./DocumentsPage";
import TeamPage from "./TeamPage";

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [features, setFeatures] = useState<Features | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const location = useLocation(),
    compact =
      new URLSearchParams(location.search).get("compact") === "1" &&
      location.pathname.startsWith("/meetings/");
  const bootstrap = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{
        user: User | null;
        features: Features;
        csrf_token: string;
      }>("bootstrap/");
      setUser(result.user);
      setFeatures(result.features);
      setCsrfToken(result.csrf_token);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void bootstrap();
    const expired = () => {
      setUser(null);
      setError(
        "再ログインが必要です。アカウントの利用状態を確認してください。",
      );
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => setMobileNav(false), [location.pathname]);
  const logout = async () => {
    try {
      await api("auth/logout/", json("POST", {}));
      setUser(null);
      await bootstrap();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (loading)
    return (
      <div className="app-loading">
        <Brand />
        <Loading label="ワークスペースを準備しています" />
      </div>
    );
  if (!features)
    return (
      <div className="connection-page">
        <Brand />
        <h1>接続を確認してください</h1>
        <ErrorNotice message={error} retry={() => void bootstrap()} />
      </div>
    );
  if (!user)
    return (
      <Login
        features={features}
        initialError={error}
        onLogin={(next) => {
          setUser(next);
          setError("");
        }}
      />
    );
  const navigation = (
    <>
      <NavLink
        to="/meetings"
        className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
      >
        <MessageSquareText size={20} />
        商談
      </NavLink>
      <NavLink
        to="/documents"
        className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
      >
        <FileText size={20} />
        商品資料・FAQ
      </NavLink>
      {user.role === "admin" && (
        <NavLink
          to="/team"
          className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
        >
          <Users size={20} />
          チーム管理
        </NavLink>
      )}
    </>
  );
  const pageTitle = location.pathname.startsWith("/documents")
    ? "商品資料・FAQ"
    : location.pathname.startsWith("/team")
      ? "チーム管理"
      : "商談";
  return (
    <div className={`app-shell ${compact ? "compact-shell" : ""}`}>
      {!compact && (
        <>
          <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
            <div className="sidebar-brand">
              <Brand />
              <button
                className="icon-button mobile-only"
                onClick={() => setMobileNav(false)}
                aria-label="メニューを閉じる"
              >
                <X />
              </button>
            </div>
            <div className="workspace-label">
              <span className="workspace-avatar">S</span>
              <div>
                <strong>{user.team_name}</strong>
                <span>チームワークスペース</span>
              </div>
              <ChevronDown size={16} />
            </div>
            <div className="nav-label">ワークスペース</div>
            <nav aria-label="メインナビゲーション">{navigation}</nav>
            <div className="sidebar-bottom">
              <div className="mode-note">
                <span className="small-icon">
                  <BookOpen size={18} />
                </span>
                <strong>
                  {features.answer_mode === "local"
                    ? "資料をもとに回答"
                    : "AIアシストモード"}
                </strong>
                <p>
                  {features.answer_mode === "local"
                    ? "登録資料から関連する記載を抽出します。"
                    : "登録資料を参照して回答候補を作成します。"}
                </p>
                <span className="small muted">
                  {features.answer_mode === "local"
                    ? "外部の生成AIは未使用"
                    : "外部AI接続を使用"}
                </span>
              </div>
              <div className="sidebar-footer">
                <ShieldCheck size={15} />
                <span>履歴は自分だけに表示</span>
              </div>
            </div>
          </aside>
          {mobileNav && (
            <button
              className="nav-scrim"
              aria-label="メニューを閉じる"
              onClick={() => setMobileNav(false)}
            />
          )}
          <div className="main-area">
            <header className="topbar">
              <div className="breadcrumb">
                <button
                  className="icon-button mobile-only"
                  onClick={() => setMobileNav(true)}
                  aria-label="メニューを開く"
                >
                  <Menu size={21} />
                </button>
                <span>ワークスペース</span>
                <span className="breadcrumb-slash">/</span>
                <strong>{pageTitle}</strong>
              </div>
              <div className="topbar-right">
                {!features.real_data_allowed && (
                  <Badge tone="info">
                    <FlaskConical size={15} />
                    架空データで検証中
                  </Badge>
                )}
                <div className="profile">
                  <span className="avatar">
                    {(user.display_name || user.username).slice(0, 1)}
                  </span>
                  <span className="profile-name">
                    {user.display_name || user.username}
                  </span>
                </div>
                <button
                  className="icon-button"
                  onClick={() => void logout()}
                  aria-label="ログアウト"
                  title="ログアウト"
                >
                  <LogOut size={18} />
                </button>
              </div>
            </header>
            <main id="main" className="main-content">
              {error && <ErrorNotice message={error} />}
              <AppRoutes user={user} features={features} />
            </main>
            <footer className="page-footer">
              <span>
                ソクトウAI{" "}
                <span className="muted">/ 営業の会話を、もっと前へ。</span>
              </span>
              <span>
                <CircleHelp size={14} />
                回答候補は、根拠と条件を確認してご利用ください
              </span>
            </footer>
          </div>
        </>
      )}
      {compact && (
        <main className="compact-main">
          <AppRoutes user={user} features={features} />
        </main>
      )}
    </div>
  );
}
function AppRoutes({ user, features }: { user: User; features: Features }) {
  const location = useLocation();
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/meetings" replace />} />
      <Route path="/meetings" element={<MeetingsPage />} />
      <Route
        path="/meetings/:id"
        element={<LivePage key={location.pathname} features={features} />}
      />
      <Route
        path="/documents"
        element={<DocumentsPage user={user} features={features} />}
      />
      <Route
        path="/team"
        element={
          user.role === "admin" ? (
            <TeamPage user={user} />
          ) : (
            <Navigate to="/meetings" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/meetings" replace />} />
    </Routes>
  );
}
function Login({
  features,
  initialError,
  onLogin,
}: {
  features: Features;
  initialError: string;
  onLogin: (user: User) => void;
}) {
  const [username, setUsername] = useState(
      features.demo_login_available ? "demo" : "",
    ),
    [password, setPassword] = useState(
      features.demo_login_available ? "sokuto-demo" : "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(initialError);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User; csrf_token: string }>(
        "auth/login/",
        json("POST", { username, password }),
      );
      setCsrfToken(result.csrf_token);
      onLogin(result.user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div className="login-message">
          <span className="eyebrow">YOUR CONVERSATION, SUPPORTED.</span>
          <h1>
            「確認して戻ります」を、
            <br />
            その場の答えに。
          </h1>
          <p>
            会話を続けながら、回答候補と根拠を確認。
            <br />
            あなたの商談に、頼れるもう一つの視点を。
          </p>
          <div className="login-flow">
            <span>
              <MessageSquareText />
              質問をとらえる
            </span>
            <ArrowRight />
            <span>
              <BookOpen />
              根拠を確かめる
            </span>
          </div>
        </div>
        <p className="small muted">法人営業のためのリアルタイム商談アシスト</p>
      </div>
      <div className="login-form-area">
        <form className="login-form" onSubmit={submit}>
          <Badge tone="info">TEAM WORKSPACE</Badge>
          <h2>おかえりなさい</h2>
          <p className="muted">チームのアカウントでログインしてください。</p>
          <ErrorNotice message={error} />
          <label className="field">
            ユーザー名
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </label>
          <label className="field">
            パスワード
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="button button-primary full-width" disabled={busy}>
            {busy ? "ログイン中…" : "ログイン"}
            <ArrowRight size={18} />
          </button>
          {features.demo_login_available && (
            <div className="demo-login-note">
              <FlaskConical size={18} />
              <div>
                <strong>ローカル検証用のアカウント</strong>
                <p>
                  架空の商品資料と模擬商談で、アシストを試せます。初期値はローカル開発用です。
                </p>
              </div>
            </div>
          )}
          <p className="small muted login-policy">
            <ShieldCheck size={15} />
            商談履歴は、ログインした本人だけが閲覧できます。
          </p>
        </form>
      </div>
    </div>
  );
}
