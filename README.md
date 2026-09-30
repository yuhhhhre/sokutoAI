# sokutoAI

会議・商談中の質問に、回答候補と登録資料の根拠を提示する「ソクトウAI」のPoCです。フロントエンドはReact＋TypeScript、バックエンドはDjangoです。

## ローカルで起動する

Python 3.10以上、Node.js 22.12以上とnpm 10以上を用意してください。macOSではHomebrewで`brew install node`、Windowsでは[Node.js公式サイト](https://nodejs.org/)のLTS版をインストールできます。Pythonは各OS向けの公式インストーラーを利用してください。

初回セットアップは、このプロジェクト内にPython仮想環境・ロック済み依存パッケージ・SQLite DB・架空資料と模擬商談を作成します。`frontend/package-lock.json`と`backend/requirements-lock.txt`により、通常起動に必要な依存バージョンを固定しています。

```bash
git clone https://github.com/Yuuuwod/sokutoAI.git
cd sokutoAI
python3 scripts/setup.py
python3 scripts/dev.py
```

Windowsでは`python3`を`py`に読み替えます。依存関係を変更したときは、Python依存ロックファイルとnpmロックファイルも更新してから共有してください。

Windowsでは`python3`を`py`に読み替えます。起動後は[ソクトウAIを開く](http://127.0.0.1:5173)。終了は起動したターミナルで`Ctrl+C`です。

ローカル検証用のログインはユーザー名`demo`、パスワード`sokuto-demo`。管理担当者として架空資料と自分の模擬商談を操作できます。共有環境・本番向けの認証情報として使わないでください。

### 試す流れ

1. ログインし、登録済みの模擬商談を開くか、新しい商談を開始します。
2. 模擬発言の再生、または「導入するまでどのくらいかかりますか？」などの質問を入力します。
3. 回答候補・必要条件・引用を確認し、「原文を見る」で資料の該当箇所を開きます。
4. 「回答できた」「要確認」を記録し、質問履歴で振り返ります。
5. 「資料」で架空のTXT・Markdown・文字選択可能PDFを追加し、検索除外・削除の挙動を確認します。

回答の初期モードは外部送信を伴わない**ローカル抽出検索**です。登録資料の文章を実際に検索して表示します。生成AIによる自由な理解・回答とは異なります。音声認識には、以下のローカルWhisperを使います。「模擬発言を流す」はテキスト投入であり、音声認識とは別です。

### このPCでWhisperを使う

基本セットアップの後に一度実行します。公式の`openai-whisper`とPyTorch等を仮想環境へインストールし、日本語対応の`small`モデルを`.local/whisper/`にダウンロードします。APIキーは不要です。

```bash
python3 scripts/setup_whisper.py
python3 scripts/dev.py
```

すでに起動している場合は`Ctrl+C`で終了してから起動し直し、画面を再読み込みしてください。Windowsでは`python3`を`py`に読み替えます。

1. 新しい商談で「対面」を選び、「音声を取り込む」を押します。
2. 架空の商材による模擬音声であることを確認し、開始してマイク利用を許可します。
3. 「料金はいくらですか」「導入するまでどのくらいかかりますか」などと話します。
4. 発言を区切ると文字起こしから質問を検知し、回答候補・根拠を自動で表示します。認識間違いは「質問を修正」で直せます。
5. 「取り込みを停止」で入力を終了します。表示更新の一時停止中も音声認識と検索は続きます。

音声はブラウザからこのPCのDjangoへ渡し、Whisperがローカルで認識します。初期設定`AI_MODE=local`・`TRANSCRIPTION_MODE=whisper`では音声・認識テキスト・資料を外部AIへ送信しません。音声をアプリのファイルとして保存せず、メモリ上で処理します。認識テキスト・質問・回答はローカルDBの商談履歴へ保存します。パッケージ・モデルの初回ダウンロードには通信が必要です。

日本語・CPU・4スレッドを初期値とし、モデルを使い回す子プロセスで認識します。baseよりsmallの方が初期の日本語3問の誤認識が少なかったためsmallを選択しました。測定条件・結果は[検証状況](docs/implementation-status.md#ローカルwhisperの実測)に記録しています。モデルの初回読み込みは追加の待ち時間がかかります。

現在は約0.8秒の無音または最大6秒で発言を区切る方式です。逐次の途中認識・話者分離は行いません。区切りをまたぐ質問、雑音、無音以外の環境音には追加検証が必要です。サーバーは16bit PCM WAV（8〜96kHz、1〜2ch、10秒以内）を受け付け、メモリ上で16kHzへ変換するため、この取り込み経路にFFmpegは不要です。Whisper CLIで別形式の音声ファイルを使う場合は公式手順を参照してください。

設定を変える場合は`.env.example`を参考に`.env`へ指定します。`WHISPER_MODEL`変更時は`python3 scripts/setup_whisper.py --model モデル名`で先にモデルを準備し、再起動します。`WHISPER_TIMEOUT_SECONDS=30`は待機・初回読み込み・認識を含む打ち切り値です。時間切れは子プロセスを終了し、次回に再作成します。ブラウザはその5秒後を通信の上限とします。モデルが未準備なら取り込みを無効にし、手入力は利用できます。音声認識を止めた構成には`TRANSCRIPTION_MODE=disabled`を使います。

### 任意の外部AIによる回答生成

必要な場合だけ`.env.example`を`.env`へコピーし、サーバー側に以下を設定します。APIキーはフロントエンドへ置かないでください。

```dotenv
AI_MODE=openai
OPENAI_API_KEY=自分のAPIキー
OPENAI_TEXT_MODEL=gpt-4.1-mini
TRANSCRIPTION_MODE=whisper
ALLOW_REAL_DATA=false
```

再起動後、認識した質問・会話文脈・検索資料をOpenAIのResponses APIに送信して回答候補を生成します。音声認識はローカルWhisperのままです。外部AIの利用にはAPI利用料金が発生します。回答は引用ID・原文一致・数値の裏付けを検査しますが、意味の正しさの保証にはならず、人の確認が必要です。既存の外部文字起こしアダプターは`TRANSCRIPTION_MODE=openai`と`OPENAI_TRANSCRIBE_MODEL`を明示した場合だけ利用します。ローカルWhisperから自動で外部APIへ切り替えることはありません。

オンラインはブラウザの画面・タブ音声共有、対面はマイク入力を使います。画面映像は送信せず、音声ファイルはアプリに保存しません。開始時に模擬音声であることを確認してください。音声トラックが取得できない場合は、その旨を表示し手入力を使えます。

**Mac／WindowsとMeet／Zoom／Teamsの全組み合わせで会議相手の音声が取得できることは、まだ実証していません。** 特にブラウザからのデスクトップアプリ音声取得は環境依存です。音声を短く区切る方式の精度・遅延も要検証で、必要ならネイティブ補助アプリやストリーミング方式へ拡張します。

実データ利用は別の条件です。クラウドAIへの送信範囲・社内ルール・権限・保持条件・商談での音声利用の運用を確定するまで`ALLOW_REAL_DATA=false`を維持します。デモ表示を外すだけで実商談への準備が完了したとは扱いません。

参考：[公式Whisper](https://github.com/openai/whisper)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[音声文字起こしAPI](https://developers.openai.com/api/docs/guides/speech-to-text)、[ブラウザの画面・音声取得](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)。

## 構成と検証

| パス | 役割 |
| --- | --- |
| `frontend/` | React画面、入力・音声取得、表示選択の保持、Vite開発サーバー |
| `backend/` | Django JSON API、セッション認証・CSRF、チーム権限、資料と商談の保存・検索 |
| `backend/core/providers.py` | 任意の外部AI接続。初期設定ではネットワーク呼び出しなし |
| `backend/core/whisper_local.py` | 公式Whisperのローカル認識・メモリ上のWAV変換・タイムアウト管理 |
| `scripts/` | Mac／Windows向けのセットアップ・起動 |
| [仕様書](docs/poc-spec.md) / [デザイン](DESIGN.md) / [開発ルール](AGENTS.md) | 実装と評価の基準 |
| [API契約](docs/api-contract.md) | 画面・サーバー間の型と操作 |
| [実装・検証状況](docs/implementation-status.md) | 確認済みの範囲、未検証の環境、次の評価段階 |

```bash
# リポジトリルートから（Windowsは .venv\Scripts\python.exe）
.venv/bin/python backend/manage.py check
.venv/bin/python backend/manage.py test core

# フロントエンド
cd frontend
npm test
npm run build
```

開発時はViteの`/api/`プロキシでDjango（127.0.0.1:8000）へ接続します。セッションとCSRFを有効にし、資料は所属チーム内、商談履歴は本人だけが参照できる仮運用です。管理者でも他者の商談本文へアクセスできません。

ローカル検索は日本語の語句・文字列と属性を使う検証用の方式です。複雑な言い換え、条件比較、表の解釈には限界があります。検索・質問検知の評価、外部AIの実接続、全対象環境の音声取得、部署規模の同時利用、実商談での効果評価を経てPoCの完了を判断します。SQLiteとDjango開発サーバーを、そのまま社外公開・本番運用しないでください。

## Git運用ルール

`main` は常にリリース可能な状態に保ちます。作業は直接 `main` に
push せず、タスクごとのブランチとプルリクエスト（PR）を経由します。
```text
main
├── feat/login-ui        # 担当A: 画面・コンポーネント
├── feat/login-api       # 担当B: API・認証処理
├── fix/login-error      # 不具合修正
└── chore/update-deps    # 依存関係・設定
```

### 1. タスクを分解して担当を決める

実装を始める前に、GitHub Issues などで小さく独立したタスクに分けます。
たとえばログイン機能なら、次のように分けます。

| Issue | 内容 | 担当 |
| --- | --- | --- |
| #10 | ログイン画面を作る | A |
| #11 | 認証APIを実装する | B |
| #12 | ログインの結合テストを追加する | A または B |

同じファイルを2人が同時に編集しない分け方を優先します。共通の型や設定を
変更する必要がある場合は、先に短いPRとしてマージしてから各タスクを始めます。

### 2. 最新のmainから作業ブランチを作る

各担当者は作業前に `main` を最新化し、Issue番号を含むブランチを作ります。

```bash
git switch main
git pull origin main
git switch -c feat/10-login-ui
```

ブランチ名は `feat/<issue番号>-<内容>`、バグ修正は
`fix/<issue番号>-<内容>` の形式にします。

### 3. 小さくコミットしてpushする

1つの目的ごとにコミットします。コミットメッセージは何を変えたかが分かる
短い文にします。

```bash
git add src/components/LoginForm.tsx
git commit -m "feat: add login form"
git push -u origin feat/10-login-ui
```

作業中に `main` が更新されたら、PRを出す前に取り込みます。

```bash
git fetch origin
git merge origin/main
# 衝突があれば解消してテストする
git push
```

### 4. PRを作成して相手がレビューする

GitHubで、作業ブランチから `main` へのPRを作成します。PRには以下を記載するように。

- 関連Issue（例: `Closes #10`）
- 変更内容と動作確認方法
- レビューしてほしい点

もう一人はコード、テスト、画面の動作を確認し、問題なければ承認します。
修正依頼があれば同じブランチにコミットして対応します。CIがある場合は、
テストが成功していることもマージ条件にします。

### 5. mainへマージする

※メインのマージをするときはどうするかは相談
承認とテスト成功後、PRをSquash and merge（一つのコミットへ取り込むこと）で `main` にマージします。
マージしたブランチは削除します。各自のローカル環境も最新化します。

```bash
git switch main
git pull origin main
git branch -d feat/10-login-ui
```

複数のタスクをマージする順番に依存関係がある場合は、土台になるPRから先に
マージします。後続のPRはその後に `main` を取り込み、動作を再確認します。

### 6. リリースする

リリース対象のPRがすべて `main` に入ったら、`main` 上でテストと動作確認を
行い、バージョンタグを付けてpushします。

```bash
git switch main
git pull origin main
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

GitHubの **Releases** でタグ `v1.0.0` を選び、変更内容をまとめて公開します。
デプロイを自動化している場合は、このタグのpushをリリースのトリガーにします。

### 日々の確認

作業開始時とPR作成前には、次を実行して差分を確認します。

```bash
git status
git log --oneline --decorate -5
git fetch origin
```

困ったときは、独断で共有ブランチを強制pushせず、ペアの相手と相談してから
対応します。
