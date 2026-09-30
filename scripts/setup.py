"""Install this project's dependencies and seed fictional data only."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv


ROOT = Path(__file__).resolve().parent.parent
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10以上が必要です。")
    node = shutil.which("node.exe" if os.name == "nt" else "node")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not node or not npm:
        raise SystemExit("Node.js 22.12以上とnpmをインストールしてください。")
    try:
        node_version = tuple(
            int(part)
            for part in subprocess.check_output([node, "--version"], text=True)
            .strip()
            .lstrip("v")
            .split(".")[:3]
        )
    except (OSError, subprocess.CalledProcessError, ValueError):
        raise SystemExit("Node.jsのバージョンを確認できませんでした。")
    if node_version < (22, 12, 0):
        raise SystemExit("Node.js 22.12以上が必要です。Node.jsを更新してください。")
    if not PYTHON.exists():
        venv.create(ROOT / ".venv", with_pip=True)
    run(PYTHON, "-m", "pip", "install", "-r", ROOT / "backend/requirements-lock.txt")
    run(npm, "ci", cwd=ROOT / "frontend")
    run(PYTHON, "manage.py", "migrate", cwd=ROOT / "backend")
    run(PYTHON, "manage.py", "seed_demo", cwd=ROOT / "backend")
    print("準備ができました。python scripts/dev.py で起動できます。")


if __name__ == "__main__":
    main()
