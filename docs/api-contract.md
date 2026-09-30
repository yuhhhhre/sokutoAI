# React / Django API契約

実装用。機能の基準は`poc-spec.md`、表示の基準は`../DESIGN.md`。全APIは`/api/`配下、JSONはsnake_case。Djangoのセッション認証＋CSRFを使い、開発時はViteから同一オリジンでプロキシする。日時はISO 8601、IDは文字列として扱える値。エラーは`{error: string, code?: string}`と適切なHTTPステータス。

## 型

```ts
type User = {id: number; username: string; display_name: string; role: 'admin'|'member'; team_name: string; is_active: boolean};
type Features = {answer_mode: 'local'|'openai'; transcription_available: boolean; transcription_mode: 'whisper'|'openai'|'disabled'; transcription_label: string; transcription_timeout_ms: number; real_data_allowed: boolean; demo_login_available: boolean; max_upload_mb: number};
type Citation = {id: string; document_id: string; document_name: string; location: string; quote: string; context: string; version: string; active: boolean; is_sample: boolean};
type Question = {id: string; meeting_id: string; text: string; source: 'manual'|'transcript'|'demo'; status: 'pending'|'searching'|'ready'|'error'|'cancelled'; revision: number; answer: string; conditions: string[]; missing_points: string[]; evidence_state: 'supported'|'partial'|'missing'|'conflict'|null; citations: Citation[]; outcome: ''|'answered'|'follow_up'; error: string; created_at: string; elapsed_ms: number|null; started_at: string|null};
type Transcript = {id: string; text: string; created_at: string};
type Meeting = {id: string; title: string; mode: 'online'|'in_person'; status: 'active'|'ended'; created_at: string; question_count: number; follow_up_count: number; questions?: Question[]; transcripts?: Transcript[]};
type Document = {id: string; name: string; version: string; source_type: string; status: 'ready'|'partial'|'failed'; active: boolean; is_sample: boolean; created_at: string; chunk_count: number; error: string; chunks?: {id: string; text: string; location: string}[]};
```

## エンドポイント

- `GET bootstrap/` → `{user: User|null, csrf_token: string, features: Features}`。未ログインでも可。
- `POST auth/login/` `{username,password}` → `{user,csrf_token}`。
- `POST auth/logout/` → `{ok:true}`。
- `GET meetings/` → `Meeting[]`。本人の商談のみ。
- `POST meetings/` `{title,mode}` → `Meeting`。
- `GET meetings/:id/` → `Meeting`（questions、transcriptsを含む）。
- `PATCH meetings/:id/` `{status:'ended'}` → `Meeting`。
- `POST meetings/:id/questions/` `{text,source?:'manual'|'demo',client_id?:string}` → `Question`（pending）。
- `POST questions/:id/answer/` `{revision:number}` → `Question`。検索・回答を実行。古いrevisionは409。重複・競合処理で過去の結果を上書きしない。
- `PATCH questions/:id/` `{text?:string,outcome?:''|'answered'|'follow_up'}` → `Question`。text変更はrevisionを進めpendingへ戻す。
- `DELETE questions/:id/` → `{ok:true}`。取り消し。旧処理は結果を書き戻さない。
- `POST meetings/:id/transcripts/` `{text,client_id?:string}` → `{transcript:Transcript,questions:Question[]}`。確定発言から質問を検知・作成。非質問は空配列。
- `POST meetings/:id/audio/` multipart `file`（WAV）＋`client_id`＋`is_sample=true` → `{transcript:Transcript|null,questions:Question[]}`。初期はローカルWhisper。16bit PCM・8〜96kHz・1〜2ch・10秒以内を受け付ける（実装上の上限）。未準備は503 `transcription_unavailable`、混雑は503 `transcription_busy`、音声形式エラーは400 `invalid_audio`、認識の時間切れは504 `transcription_timeout`。無音はnullと空配列。実データ利用未許可の場合は模擬音声の申告を必須とし、音声ファイルは保存しない。既存client_idの再送は同じ発言・質問を返す。
- `GET documents/` → `Document[]`。所属チームの資料。
- `POST documents/` multipart `file`、`name?`、`version?`、`replaces_id?`、`is_sample=true` → `Document`。管理担当者のみ。`replaces_id`で指定した旧版は、新版が完全に読み取れた場合だけ検索対象から外す。同名資料の自動判定は行わない。初期は10MB・TXT／Markdown／文字選択可能PDF。上限は実装上の初期値であり仕様保証ではない。
- `GET documents/:id/` → `Document`（chunksを含む）。
- `PATCH documents/:id/` `{active:boolean}` → `Document`。管理担当者のみ。
- `GET documents/:id/delete-preview/` → `{name:string,affected_questions:number,chunk_count:number}`。管理担当者のみ。
- `DELETE documents/:id/` → `{ok:true,deleted_questions:number}`。管理担当者のみ。原文・引用・関連回答を削除。
- `GET members/` → `User[]`。管理担当者のみ。
- `POST members/` `{username,password,display_name,role}` → `User`。同じチームへ追加。
- `PATCH members/:id/` `{is_active?:boolean,role?:'admin'|'member'}` → `User`。最後の管理者を失う変更は拒否。

## 実装の境界

ローカル標準モードは実際の登録資料を検索する抽出方式で、生成AI接続済みとは表示しない。外部AIはサーバー環境変数で有効化する。架空データのデモログインはローカル開発用に限り、`demo` / `sokuto-demo`（管理担当者）をseedコマンドで作る。実データ利用の可否は独立した設定として初期false。

音声認識は`TRANSCRIPTION_MODE`、回答生成は`AI_MODE`で独立して選ぶ。初期は`whisper`＋`local`で、外部AIへの通信なし。Whisperのモデルは明示的なセットアップで準備し、音声リクエスト中にはダウンロードしない。`transcription_available`は依存パッケージとモデルファイルの存在確認で、実音声の認識成功の保証ではない。`transcription_label`を状態・セットアップ案内として表示する。`transcription_timeout_ms`はクライアントの通信上限。Whisperはサーバーで30秒を初期上限とし、時間切れ時に認識プロセスを破棄する。プロセスごとに1件ずつ実行し、他リクエストのロック待機は最大3秒。実行中と待機中の合計に上限を適用する。

フロントはpendingの質問を作成・受信した後にanswer APIを呼ぶ。検索の開始・完了は実際のリクエストに連動させる。全質問を処理しても表示選択は保持する。バックエンドの質問処理はHTTPリクエスト単位で行い、永続ジョブキューはこの初期実装に含めない。

`started_at`は直近の回答処理開始時刻、`elapsed_ms`はサーバーの検索・回答処理時間です。質問発話終了からの文字起こし・通信・画面描画を含む仕様書の応答時間とは異なり、性能目標の達成値には使いません。無音の音声処理は`{transcript:null,questions:[]}`を返すことがあります。
