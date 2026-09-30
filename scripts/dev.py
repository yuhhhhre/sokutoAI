"""Run the local React and Django development servers together."""

import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


ROOT = Path(__file__).resolve().parent.parent
PYTHON = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def main():
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not PYTHON.exists() or not npm or not (ROOT / "frontend/node_modules").exists():
        raise SystemExit("先に python scripts/setup.py を実行してください。")
    processes = []

    def interrupt(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        creation = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        processes.append(subprocess.Popen([str(PYTHON), "manage.py", "runserver", "127.0.0.1:8000", "--noreload"], cwd=ROOT / "backend", **creation))
        processes.append(subprocess.Popen([npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], cwd=ROOT / "frontend", **creation))
        print("ソクトウAI: http://127.0.0.1:5173 ／ 終了: Ctrl+C", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.4)
        if any(process.returncode for process in processes if process.returncode is not None):
            raise SystemExit("起動に失敗しました。上のエラーとポートの使用状況を確認してください。")
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
                else:
                    os.killpg(process.pid, signal.SIGKILL)


if __name__ == "__main__":
    main()
