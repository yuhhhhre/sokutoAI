# sokutoAI

## インストール方法
git clone https://github.com/Yuuuwod/sokutoAI.git

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
