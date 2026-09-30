"""Official Whisper in an isolated, reusable local process; audio stays in memory."""
import atexit
from importlib.util import find_spec
from io import BytesIO
import multiprocessing
from pathlib import Path
import threading
import time
import wave

from django.conf import settings

MODELS = ("tiny", "base", "small", "medium", "large", "large-v3", "turbo")
MAX_AUDIO_SECONDS = 10


class WhisperError(RuntimeError):
    pass


class InvalidAudio(WhisperError):
    pass


class WhisperBusy(WhisperError):
    pass


class WhisperTimeout(WhisperError):
    pass


def checkpoint_path():
    if settings.WHISPER_MODEL not in MODELS:
        raise WhisperError("Whisperの日本語対応モデルを指定してください。")
    filename = {"large": "large-v3", "turbo": "large-v3-turbo"}.get(settings.WHISPER_MODEL, settings.WHISPER_MODEL)
    return Path(settings.WHISPER_MODEL_DIR) / f"{filename}.pt"


def readiness():
    if any(find_spec(name) is None for name in ("whisper", "torch", "scipy")):
        return False, "Whisperの準備が必要です。管理担当者にセットアップを依頼してください。"
    try:
        path = checkpoint_path()
    except WhisperError as exc:
        return False, str(exc)
    if not path.is_file():
        return False, "Whisperモデルが未準備です。管理担当者にセットアップを依頼してください。"
    return True, f"Whisper {settings.WHISPER_MODEL}・ローカル音声認識"


def read_pcm(contents):
    """Accept only bounded PCM WAV, without invoking a decoder or writing files."""
    try:
        with wave.open(BytesIO(contents), "rb") as audio:
            channels, rate, frames = audio.getnchannels(), audio.getframerate(), audio.getnframes()
            if audio.getcomptype() != "NONE" or audio.getsampwidth() != 2 or channels not in (1, 2):
                raise InvalidAudio("16bit PCM・モノラルまたはステレオのWAVが必要です。")
            if not 8000 <= rate <= 96000 or not 0 < frames <= rate * MAX_AUDIO_SECONDS:
                raise InvalidAudio("音声は10秒以内の短いWAVに区切って送信してください。")
            pcm = audio.readframes(frames)
            if len(pcm) != frames * channels * 2:
                raise InvalidAudio("音声ファイルのデータが不足しています。取り込みを再開してください。")
            return pcm, rate, channels
    except (wave.Error, EOFError, ValueError) as exc:
        raise InvalidAudio("WAV形式の音声を読み取れませんでした。") from exc


def _worker_main(connection, model_path, device, threads):
    """No Django state or previous user's transcript enters the model context."""
    try:
        import math
        import numpy as np
        from scipy.signal import resample_poly
        import torch
        import whisper

        torch.set_num_threads(threads)
        # A pre-provisioned path prevents a request from triggering a download.
        model = whisper.load_model(model_path, device=device)
        while True:
            pcm, rate, channels = connection.recv()
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            if channels == 2:
                audio = audio.reshape(-1, 2).mean(axis=1)
            # Avoid Whisper inventing a transcript from digital silence.
            if float(np.sqrt(np.mean(audio * audio))) < 0.001:
                connection.send((True, ""))
                continue
            if rate != 16000:
                divisor = math.gcd(rate, 16000)
                audio = resample_poly(audio, 16000 // divisor, rate // divisor).astype(np.float32)
            result = model.transcribe(audio, language="ja", task="transcribe", fp16=False,
                                      verbose=None, temperature=0.0, condition_on_previous_text=False)
            text = result.get("text")
            if not isinstance(text, str):
                raise ValueError("Invalid transcript")
            connection.send((True, text.strip()))
    except (EOFError, BrokenPipeError):
        pass
    except Exception:
        # Never return exception details, local paths, or model inputs.
        try:
            connection.send((False, "Whisperで音声を認識できませんでした。モデルと実行環境を確認してください。"))
        except (OSError, EOFError):
            pass
    finally:
        connection.close()


class LocalWhisper:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.connection = None
        self.configuration = None

    def close(self):
        if self.connection is not None:
            self.connection.close()
        if self.process is not None:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
        self.process = self.connection = self.configuration = None

    def _ensure_worker(self):
        configuration = (str(checkpoint_path()), settings.WHISPER_DEVICE, settings.WHISPER_THREADS)
        if self.process and self.process.is_alive() and self.configuration == configuration:
            return
        self.close()
        context = multiprocessing.get_context("spawn")
        parent, child = context.Pipe()
        process = context.Process(target=_worker_main, args=(child, *configuration), daemon=True)
        try:
            process.start()
        except Exception:
            parent.close()
            raise
        finally:
            child.close()
        self.process, self.connection, self.configuration = process, parent, configuration

    def transcribe(self, contents):
        pcm = read_pcm(contents)
        ready, message = readiness()
        if not ready:
            raise WhisperError(message)
        deadline = time.monotonic() + settings.WHISPER_TIMEOUT_SECONDS
        if not self.lock.acquire(timeout=min(3, settings.WHISPER_TIMEOUT_SECONDS)):
            raise WhisperBusy("音声認識が混み合っています。少し待って取り込みを再開してください。")
        try:
            self._ensure_worker()
            self.connection.send(pcm)
            if not self.connection.poll(max(0, deadline - time.monotonic())):
                self.close()
                raise WhisperTimeout("Whisperの音声認識が時間切れになりました。短く話して再開するか、手入力してください。")
            ok, text = self.connection.recv()
            if not ok:
                self.close()
                raise WhisperError(text)
            return text
        except WhisperError:
            raise
        except Exception as exc:
            self.close()
            raise WhisperError("Whisperの音声認識が停止しました。取り込みを再開してください。") from exc
        finally:
            self.lock.release()


local_whisper = LocalWhisper()
atexit.register(local_whisper.close)
