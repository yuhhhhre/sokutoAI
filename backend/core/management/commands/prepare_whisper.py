import os
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from core.whisper_local import MODELS


class Command(BaseCommand):
    help = "公式Whisperモデルをダウンロード・読み込み確認する（音声は送信しない）"

    def add_arguments(self, parser):
        parser.add_argument("--model", choices=MODELS, default=settings.WHISPER_MODEL)

    def handle(self, *args, **options):
        try:
            import certifi
            import torch
            import whisper
        except ImportError as exc:
            raise CommandError("python scripts/setup_whisper.py を実行してください。") from exc
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        model = options["model"]
        target = Path(settings.WHISPER_MODEL_DIR)
        target.mkdir(parents=True, exist_ok=True)
        torch.set_num_threads(settings.WHISPER_THREADS)
        self.stdout.write(f"Whisper {model} を準備します。初回は公式のモデルファイルをダウンロードします。")
        whisper.load_model(model, device=settings.WHISPER_DEVICE, download_root=str(target))
        self.stdout.write(self.style.SUCCESS(f"Whisper {model} を読み込めました。保存先: {target}"))
        if model != settings.WHISPER_MODEL:
            self.stdout.write(f"使用するには .env に WHISPER_MODEL={model} を設定してください。")
