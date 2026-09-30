from unittest.mock import Mock, patch

import requests
from django.test import SimpleTestCase, override_settings

from core.providers import ProviderError, _validate_answer, generate_answer, transcribe_audio


SOURCE = {"id": "source-1", "quote": "標準プランは月額30,000円（税別）です。", "document_name": "架空料金表", "is_sample": True}


def supported():
    return {"answer": "標準プランは月額30,000円（税別）です。", "conditions": ["税別"],
            "missing_points": [], "evidence_state": "supported", "source_ids": ["source-1"],
            "supporting_quotes": [{"source_id": "source-1", "quote": SOURCE["quote"]}]}


class ProviderTests(SimpleTestCase):
    @override_settings(AI_MODE="local", OPENAI_API_KEY="unused")
    @patch("core.providers.requests.post")
    def test_local_mode_does_not_transmit(self, post):
        self.assertIsNone(generate_answer("料金は？", "", [SOURCE]))
        post.assert_not_called()

    @override_settings(AI_MODE="openai", OPENAI_API_KEY="test-key", OPENAI_TEXT_MODEL="gpt-4.1-mini")
    @patch("core.providers.requests.post")
    def test_grounded_output_and_no_response_storage(self, post):
        import json
        post.return_value = Mock(json=lambda: {"status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(supported())}]}]})
        answer = generate_answer("料金は？", "", [SOURCE])
        self.assertEqual(answer["source_ids"], ["source-1"])
        self.assertFalse(post.call_args.kwargs["json"]["store"])
        self.assertNotIn("supporting_quotes", answer)

    def test_unknown_source_rejected(self):
        result = supported()
        result["source_ids"] = ["nonexistent"]
        with self.assertRaises(ProviderError):
            _validate_answer(result, [SOURCE])

    def test_fabricated_quote_rejected(self):
        result = supported()
        result["supporting_quotes"][0]["quote"] = "無料です。"
        with self.assertRaises(ProviderError):
            _validate_answer(result, [SOURCE])

    def test_numerical_claim_without_support_rejected(self):
        result = supported()
        result["answer"] = "月額10,000円です。"
        with self.assertRaises(ProviderError):
            _validate_answer(result, [SOURCE])

    def test_missing_state_cannot_smuggle_answer(self):
        result = supported()
        result["evidence_state"] = "missing"
        checked = _validate_answer(result, [SOURCE])
        self.assertEqual(checked["source_ids"], [])
        self.assertEqual(checked["answer"], "登録資料では確認できません。")

    def test_existing_number_cannot_be_reused_with_different_unit(self):
        result = supported()
        result["answer"] = "標準プランでは30,000人まで利用できます。"
        with self.assertRaises(ProviderError):
            _validate_answer(result, [SOURCE])

    @override_settings(AI_MODE="openai", OPENAI_API_KEY="test-key", ALLOW_REAL_DATA=False)
    @patch("core.providers.requests.post")
    def test_real_source_blocked_before_network(self, post):
        with self.assertRaises(ProviderError):
            generate_answer("料金は？", "", [{**SOURCE, "is_sample": False}])
        post.assert_not_called()

    @override_settings(AI_MODE="openai", OPENAI_API_KEY="test-key", ALLOW_REAL_DATA=False)
    @patch("core.providers.requests.post")
    def test_oversized_context_is_not_sent(self, post):
        with self.assertRaises(ProviderError):
            generate_answer("料金は？", "", [{**SOURCE, "quote": "文" * 60001}])
        post.assert_not_called()

    @override_settings(TRANSCRIPTION_MODE="openai", OPENAI_API_KEY="")
    @patch("core.providers.requests.post")
    def test_transcription_requires_explicit_configuration(self, post):
        with self.assertRaises(ProviderError):
            transcribe_audio(b"wav", "sample.wav")
        post.assert_not_called()

    @override_settings(TRANSCRIPTION_MODE="openai", OPENAI_API_KEY="test-key")
    @patch("core.providers.requests.post", side_effect=requests.Timeout("private response detail"))
    def test_provider_error_does_not_reveal_internal_response(self, post):
        with self.assertRaises(ProviderError) as error:
            transcribe_audio(b"wav", "sample.wav")
        self.assertNotIn("private", str(error.exception))
