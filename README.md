# sokutoAI

## インストール方法
git clone https://github.com/Yuuuwod/sokutoAI.git

## gitの使い方
# gitの基本的な考え方
main←メインブランチ
 ├── feat/login←ブランチ
 ├── feat/user-profile←ブランチ
 ├── fix/login-error←ブランチ
 └── chore/update-deps←ブランチ
---ブランチに機能を分けて作って、メインにマージする

# mainを最新にする
git switch main
git pull origin main

# ブランチを作る
git switch -c feat/login

# 対象のブランチにプッシュする
git push -u origin test/readme-update

# 