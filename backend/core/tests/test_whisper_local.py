from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
import wave

from django.test import SimpleTestCase, override_settings

from core.providers import provider_features, transcribe_audio
from core.whisper_local import (
    InvalidAudio, LocalWhisper, WhisperBusy, WhisperError, WhisperTimeout,
    checkpoint_path, read_pcm, readiness,
)


def wav_bytes(rate=16000, channels=1, width=2, seconds=0.1):
    stream = BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        audio.writeframes(bytes(round(seconds * rate) * channels * width))
    return stream.getvalue()


@override_settings(WHISPER_MODEL="base", WHISPER_MODEL_DIR="/unused", WHISPER_DEVICE="cpu",
                   WHISPER_THREADS=4, WHISPER_TIMEOUT_SECONDS=30, TRANSCRIPTION_MODE="whisper")
class WhisperTests(SimpleTestCase):
    def test_pcm_accepts_browser_rates_and_stereo(self):
        for rate, channels in [(16000, 1), (44100, 2), (48000, 1)]:
            with self.subTest(rate=rate, channels=channels):
                pcm, actual_rate, actual_channels = read_pcm(wav_bytes(rate, channels))
                self.assertEqual((actual_rate, actual_channels), (rate, channels))
                self.assertEqual(len(pcm), round(rate * 0.1) * channels * 2)

    def test_invalid_or_excessive_pcm_rejected_before_inference(self):
        for contents in [b"not wav", wav_bytes(width=1), wav_bytes(channels=3),
                         wav_bytes(rate=4000), wav_bytes(seconds=0),
                         wav_bytes(seconds=10.1), wav_bytes()[:-2]]:
            with self.subTest(size=len(contents)), self.assertRaises(InvalidAudio):
                read_pcm(contents)

    @patch("core.whisper_local.find_spec", return_value=None)
    def test_missing_dependencies_are_actionable(self, _find):
        ready, message = readiness()
        self.assertFalse(ready)
        self.assertIn("セットアップ", message)

    @patch("core.whisper_local.find_spec", return_value=object())
    def test_missing_checkpoint_is_not_implicitly_downloaded(self, _find):
        with TemporaryDirectory() as directory, override_settings(WHISPER_MODEL_DIR=directory):
            self.assertFalse(readiness()[0])
            with patch("core.whisper_local.multiprocessing.get_context") as spawn:
                with self.assertRaises(WhisperError):
                    LocalWhisper().transcribe(wav_bytes())
                spawn.assert_not_called()
            Path(directory, "base.pt").touch()
            self.assertTrue(readiness()[0])

    def test_alias_checkpoint_paths_match_official_downloads(self):
        for name, filename in [("large", "large-v3.pt"), ("turbo", "large-v3-turbo.pt")]:
            with override_settings(WHISPER_MODEL=name):
                self.assertEqual(checkpoint_path().name, filename)
        with override_settings(WHISPER_MODEL="base.en"), self.assertRaises(WhisperError):
            checkpoint_path()

    @override_settings(AI_MODE="local", OPENAI_API_KEY="")
    @patch("core.whisper_local.readiness", return_value=(True, "local"))
    @patch("core.whisper_local.local_whisper.transcribe", return_value="料金はいくらですか？")
    @patch("core.providers.requests.post")
    def test_whisper_is_independent_of_cloud_answer_mode(self, post, transcribe, _ready):
        self.assertTrue(provider_features()["transcription_available"])
        contents = wav_bytes()
        self.assertEqual(transcribe_audio(contents, "segment.wav"), "料金はいくらですか？")
        transcribe.assert_called_once_with(contents)
        post.assert_not_called()

    @patch("core.whisper_local.readiness", return_value=(True, "local"))
    @patch("core.whisper_local.multiprocessing.get_context")
    def test_worker_reuse_passes_only_current_audio(self, context, _ready):
        parent, child, process = Mock(), Mock(), Mock()
        context.return_value.Pipe.return_value = (parent, child)
        context.return_value.Process.return_value = process
        parent.recv.side_effect = [(True, "料金は？"), (True, "期間は？")]
        service = LocalWhisper()
        try:
            first, second = wav_bytes(), wav_bytes(rate=48000)
            self.assertEqual(service.transcribe(first), "料金は？")
            self.assertEqual(service.transcribe(second), "期間は？")
            process.start.assert_called_once()
            self.assertEqual([call.args[0] for call in parent.send.call_args_list], [read_pcm(first), read_pcm(second)])
            child.close.assert_called_once()
        finally:
            service.close()

    @patch("core.whisper_local.readiness", return_value=(True, "local"))
    def test_timeout_terminates_worker_and_next_request_can_recover(self, _ready):
        service, connection, process = LocalWhisper(), Mock(), Mock()
        service.connection, service.process = connection, process
        connection.poll.return_value = False
        with patch.object(service, "_ensure_worker"):
            with self.assertRaises(WhisperTimeout):
                service.transcribe(wav_bytes())
        process.terminate.assert_called_once()
        connection.close.assert_called_once()
        self.assertIsNone(service.connection)
        self.assertFalse(service.lock.locked())
        recovered = Mock()
        recovered.recv.return_value = (True, "新しい質問ですか？")
        with patch.object(service, "_ensure_worker", side_effect=lambda: setattr(service, "connection", recovered)):
            self.assertEqual(service.transcribe(wav_bytes()), "新しい質問ですか？")
        service.close()

    @patch("core.whisper_local.readiness", return_value=(True, "local"))
    @override_settings(WHISPER_TIMEOUT_SECONDS=0.001)
    def test_busy_request_does_not_touch_other_users_worker(self, _ready):
        service = LocalWhisper()
        service.lock.acquire()
        try:
            with patch.object(service, "_ensure_worker") as ensure:
                with self.assertRaises(WhisperBusy):
                    service.transcribe(wav_bytes())
                ensure.assert_not_called()
                self.assertTrue(service.lock.locked())
        finally:
            service.lock.release()

    @patch("core.whisper_local.readiness", return_value=(True, "local"))
    def test_broken_worker_does_not_reveal_internal_error(self, _ready):
        service = LocalWhisper()
        with patch.object(service, "_ensure_worker", side_effect=OSError("private path")):
            with self.assertRaises(WhisperError) as error:
                service.transcribe(wav_bytes())
        self.assertNotIn("private", str(error.exception))
        self.assertFalse(service.lock.locked())
