"""Install official local Whisper and provision the configured model explicitly."""
import argparse
from setup import ROOT, PYTHON, run


def main():
    parser = argparse.ArgumentParser(description="ローカルWhisperを準備します。モデルは一度ダウンロードします。")
    parser.add_argument("--model", choices=["tiny", "base", "small", "medium", "large", "large-v3", "turbo"])
    args = parser.parse_args()
    if not PYTHON.exists():
        raise SystemExit("先に python scripts/setup.py を実行してください。")
    run(PYTHON, "-m", "pip", "install", "-r", ROOT / "backend/requirements-whisper.txt")
    options = ["--model", args.model] if args.model else []
    run(PYTHON, "manage.py", "prepare_whisper", *options, cwd=ROOT / "backend")
    print("Whisperの準備ができました。アプリを再起動してください。")


if __name__ == "__main__":
    main()
