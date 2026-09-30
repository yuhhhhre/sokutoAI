import json
from io import BytesIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase, override_settings
from pypdf import PdfWriter

from core.ingestion import ingest_document
from core.models import Citation, Meeting, Membership, Question, Team, Transcript


@override_settings(AI_MODE="local", TRANSCRIPTION_MODE="disabled", ALLOW_REAL_DATA=False)
class APITests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.team = Team.objects.create(name="検証")
        self.other_team = Team.objects.create(name="別チーム")
        self.admin = User.objects.create_user("admin", password="Example-p@ss123")
        self.member = User.objects.create_user("member", password="Example-p@ss123")
        self.outsider = User.objects.create_user("outsider", password="Example-p@ss123")
        Membership.objects.create(team=self.team, user=self.admin, role="admin")
        Membership.objects.create(team=self.team, user=self.member, role="member")
        Membership.objects.create(team=self.other_team, user=self.outsider, role="admin")
        self.client.force_login(self.admin)
        self.meeting = Meeting.objects.create(team=self.team, owner=self.admin, title="模擬商談")
        self.document = self.doc("料金", "# Standardプランの料金\nStandardプランの月額料金は30,000円（税別）で、10名まで利用できます。最低契約期間は12か月で、年払い・国内法人への提供が条件です。初期費用は50,000円（税別）です。")

    def doc(self, name, text, **kwargs):
        return ingest_document(team=kwargs.pop("team", self.team), name=name, version="v1", source_type="md", contents=text.encode(), **kwargs)

    def send(self, method, path, data=None):
        return getattr(self.client, method)("/api/" + path, data=json.dumps(data or {}), content_type="application/json")

    def new_question(self, text="料金はいくらですか？", **kwargs):
        return Question.objects.create(meeting=kwargs.pop("meeting", self.meeting), text=text, **kwargs)

    def answer(self, question):
        return self.send("post", f"questions/{question.id}/answer/", {"revision": question.revision})

    def test_session_and_csrf_required_including_login(self):
        client = Client(enforce_csrf_checks=True)
        self.assertEqual(client.get("/api/meetings/").status_code, 401)
        self.assertEqual(client.post("/api/auth/login/", {"username": "admin", "password": "Example-p@ss123"}).status_code, 403)
        token = client.get("/api/bootstrap/").json()["csrf_token"]
        response = client.post("/api/auth/login/", json.dumps({"username": "admin", "password": "Example-p@ss123"}), content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 200)
        token = response.json()["csrf_token"]
        response = client.post("/api/meetings/", json.dumps({"title": "模擬"}), content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 201)

    def test_private_meetings_even_for_same_team_admin(self):
        other = Meeting.objects.create(team=self.team, owner=self.member, title="非公開")
        question = self.new_question(meeting=other)
        self.assertEqual(self.client.get(f"/api/meetings/{other.pk}/").status_code, 404)
        self.assertEqual(self.answer(question).status_code, 404)
        self.assertEqual(len(self.client.get("/api/meetings/").json()), 1)

    def test_cross_team_documents_and_search_denied(self):
        other = self.doc("他社秘密", "# 保存地域\nデータの保存地域は火星です。", team=self.other_team)
        self.assertEqual(self.client.get(f"/api/documents/{other.pk}/").status_code, 404)
        self.assertEqual(self.send("delete", f"documents/{other.pk}/").status_code, 404)
        result = self.answer(self.new_question("データの保存地域はどこですか？")).json()
        self.assertEqual(result["evidence_state"], "missing")
        self.assertNotIn("火星", json.dumps(result, ensure_ascii=False))

    def test_member_cannot_manage_docs_or_users(self):
        self.client.force_login(self.member)
        self.assertEqual(self.send("patch", f"documents/{self.document.pk}/", {"active": False}).status_code, 403)
        self.assertEqual(self.client.get("/api/members/").status_code, 403)
        self.assertEqual(self.client.get("/api/documents/").status_code, 200)

    def test_deactivation_immediately_invalidates_session(self):
        self.admin.is_active = False
        self.admin.save()
        self.assertEqual(self.client.get("/api/meetings/").status_code, 401)

    def test_permission_change_reflected_on_next_request(self):
        Membership.objects.filter(user=self.admin).update(role="member")
        self.assertEqual(self.client.get("/api/members/").status_code, 403)

    def test_last_admin_protected(self):
        self.assertEqual(self.send("patch", f"members/{self.admin.pk}/", {"is_active": False}).status_code, 409)
        self.assertEqual(self.send("patch", f"members/{self.admin.pk}/", {"role": "member"}).status_code, 409)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active)

    def test_invalid_enum_json_types_are_controlled_errors(self):
        self.assertEqual(self.send("post", "meetings/", {"title": "模擬", "mode": []}).status_code, 400)
        self.assertEqual(self.send("post", f"meetings/{self.meeting.pk}/questions/", {"text": "質問", "source": {}}).status_code, 400)
        question = self.new_question()
        self.assertEqual(self.send("patch", f"questions/{question.pk}/", {"outcome": []}).status_code, 400)
        self.assertEqual(self.send("patch", f"members/{self.admin.pk}/", {"role": {}}).status_code, 400)

    def test_create_member_and_reject_weak_password(self):
        data = {"username": "newmember", "display_name": "営業担当", "role": "member", "password": "123"}
        self.assertEqual(self.send("post", "members/", data).status_code, 400)
        data["password"] = "New-user-Complex-882"
        response = self.send("post", "members/", data)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["team_name"], "検証")
        self.assertNotIn("password", response.json())

    def test_actual_extractive_answer_keeps_pricing_conditions_and_quote(self):
        result = self.answer(self.new_question()).json()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["evidence_state"], "supported")
        self.assertIn("30,000円", result["answer"])
        self.assertIn("12か月", " ".join(result["conditions"]))
        self.assertIn("50,000円", " ".join(result["conditions"]))
        self.assertEqual(result["citations"][0]["quote"], self.document.chunks.first().text)

    def test_question_create_idempotency(self):
        data = {"text": "料金はいくらですか？", "client_id": "client-1"}
        first = self.send("post", f"meetings/{self.meeting.pk}/questions/", data)
        second = self.send("post", f"meetings/{self.meeting.pk}/questions/", data)
        self.assertEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(Question.objects.count(), 1)
        data["text"] = "違う質問ですか？"
        self.assertEqual(self.send("post", f"meetings/{self.meeting.pk}/questions/", data).status_code, 409)

    def test_answer_idempotency_keeps_one_citation_set(self):
        question = self.new_question()
        first = self.answer(question).json()
        with patch("core.views.answer_question", side_effect=AssertionError("should not run")):
            second = self.answer(question).json()
        self.assertEqual(first["citations"], second["citations"])

    def test_revision_edit_discards_in_flight_result(self):
        question = self.new_question()
        from core.retrieval import answer_question
        result = answer_question(question.text, self.team.id)
        def edit_during_generation(*args):
            self.assertEqual(self.send("patch", f"questions/{question.pk}/", {"text": "新しい質問ですか？"}).status_code, 200)
            return result
        with patch("core.views.answer_question", side_effect=edit_during_generation):
            response = self.answer(question)
        self.assertEqual(response.status_code, 409)
        question.refresh_from_db()
        self.assertEqual((question.text, question.status, question.answer, question.revision), ("新しい質問ですか？", "pending", "", 2))
        self.assertEqual(question.citations.count(), 0)

    def test_cancel_discards_in_flight_result(self):
        question = self.new_question()
        from core.retrieval import answer_question
        result = answer_question(question.text, self.team.id)
        def cancel(*args):
            self.send("delete", f"questions/{question.pk}/")
            return result
        with patch("core.views.answer_question", side_effect=cancel):
            response = self.answer(question)
        self.assertEqual(response.status_code, 409)
        question.refresh_from_db()
        self.assertEqual(question.status, "cancelled")
        self.assertEqual(question.citations.count(), 0)

    def test_reversed_response_order_keeps_question_identity(self):
        first = self.new_question()
        second = self.new_question("保存地域はどこですか？")
        second_result = self.answer(second).json()
        first_result = self.answer(first).json()
        self.assertEqual(second_result["id"], str(second.pk))
        self.assertEqual(first_result["id"], str(first.pk))
        self.assertEqual(second_result["evidence_state"], "missing")
        self.assertEqual(first_result["evidence_state"], "supported")

    def test_provider_error_is_distinct_from_missing_and_retry_safe(self):
        question = self.new_question()
        with patch("core.providers.generate_answer", side_effect=RuntimeError("SECRET_KEY must not leak")):
            result = self.answer(question).json()
        self.assertEqual(result["status"], "error")
        self.assertIsNone(result["evidence_state"])
        self.assertNotIn("SECRET", json.dumps(result))
        result = self.answer(question).json()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(Question.objects.count(), 1)

    def test_timed_out_result_is_not_persisted(self):
        question = self.new_question()
        with patch("core.views.time.monotonic", side_effect=[0, 31, 31, 31]):
            result = self.answer(question).json()
        self.assertEqual(result["status"], "error")
        self.assertIn("時間内", result["error"])
        self.assertIsNone(result["evidence_state"])
        self.assertEqual(result["citations"], [])

    def test_user_revocation_during_generation_stops_response(self):
        question = self.new_question()
        from core.retrieval import answer_question
        result = answer_question(question.text, self.team.id)
        def deactivate(*args):
            get_user_model().objects.filter(pk=self.admin.pk).update(is_active=False)
            return result
        with patch("core.views.answer_question", side_effect=deactivate):
            response = self.answer(question)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("answer", response.json())
        self.assertFalse(Citation.objects.exists())

    def test_membership_change_during_generation_does_not_leak_previous_team_data(self):
        question = self.new_question()
        from core.retrieval import answer_question
        result = answer_question(question.text, self.team.id)
        def move_team(*args):
            Membership.objects.filter(user=self.admin).update(team=self.other_team)
            return result
        with patch("core.views.answer_question", side_effect=move_team):
            response = self.answer(question)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("answer", response.json())
        self.assertFalse(Citation.objects.exists())

    def test_stale_revision_rejected(self):
        question = self.new_question()
        self.send("patch", f"questions/{question.pk}/", {"text": "保存地域はどこですか？"})
        self.assertEqual(self.answer(question).status_code, 409)

    def test_document_deactivation_retains_snapshot_but_not_retrieval(self):
        question = self.new_question()
        self.answer(question)
        self.send("patch", f"documents/{self.document.pk}/", {"active": False})
        snapshot = self.client.get(f"/api/meetings/{self.meeting.pk}/").json()["questions"][0]["citations"][0]
        self.assertFalse(snapshot["active"])
        self.assertIn("30,000円", snapshot["quote"])
        self.assertEqual(self.answer(self.new_question()).json()["evidence_state"], "missing")

    def test_complete_deletion_removes_raw_chunks_citations_and_all_affected_answers(self):
        other_meeting = Meeting.objects.create(team=self.team, owner=self.member, title="別の本人専用商談")
        question = self.new_question()
        self.answer(question)
        other_question = self.new_question(meeting=other_meeting)
        Citation.objects.create(question=other_question, document=self.document, document_name="料金", quote="原文", context="原文", location="段落1")
        preview = self.client.get(f"/api/documents/{self.document.pk}/delete-preview/").json()
        self.assertEqual(preview["affected_questions"], 2)
        response = self.send("delete", f"documents/{self.document.pk}/")
        self.assertEqual(response.json()["deleted_questions"], 2)
        self.assertFalse(Question.objects.exists())
        self.assertFalse(Citation.objects.exists())
        self.assertFalse(self.document.chunks.exists())

    def test_delete_document_during_generation_prevents_persisting_old_source(self):
        question = self.new_question()
        from core.retrieval import answer_question
        result = answer_question(question.text, self.team.id)
        def remove(*args):
            self.document.delete()
            return result
        with patch("core.views.answer_question", side_effect=remove):
            response = self.answer(question).json()
        self.assertEqual(response["status"], "error")
        self.assertIsNone(response["evidence_state"])
        self.assertEqual(Citation.objects.count(), 0)

    def test_transcript_detection_idempotency_and_non_questions(self):
        path = f"meetings/{self.meeting.pk}/transcripts/"
        self.assertEqual(self.send("post", path, {"text": "はい、ありがとうございます。", "client_id": "a"}).json()["questions"], [])
        first = self.send("post", path, {"text": "料金を知りたいです。導入は何週間ですか？", "client_id": "b"}).json()
        again = self.send("post", path, {"text": "料金を知りたいです。導入は何週間ですか？", "client_id": "b"}).json()
        self.assertEqual(len(first["questions"]), 2)
        self.assertEqual(first, again)
        self.assertEqual(self.send("post", path, {"text": "料金は", "is_final": False}).status_code, 400)

    def test_transcript_checks_meeting_state_inside_transaction(self):
        from core.views import APIError, save_transcript
        Meeting.objects.filter(pk=self.meeting.pk).update(status="ended")
        with self.assertRaises(APIError):
            save_transcript(self.meeting, "料金はいくらですか？", "late-audio")
        self.assertFalse(Transcript.objects.exists())

    def test_upload_guard_failed_extraction_and_replace(self):
        file = lambda text=b"# test\nnew": SimpleUploadedFile("guide.md", text)
        self.assertEqual(self.client.post("/api/documents/", {"file": file()}).status_code, 403)
        response = self.client.post("/api/documents/", {"file": file(b""), "is_sample": "true", "replaces_id": str(self.document.pk)})
        self.assertEqual(response.json()["status"], "failed")
        self.document.refresh_from_db()
        self.assertTrue(self.document.active)
        response = self.client.post("/api/documents/", {"file": file(), "is_sample": "true", "replaces_id": str(self.document.pk)})
        self.assertEqual(response.json()["status"], "ready")
        self.document.refresh_from_db()
        self.assertFalse(self.document.active)

    def test_scanned_pdf_is_failed_not_available(self):
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        stream = BytesIO()
        writer.write(stream)
        response = self.client.post("/api/documents/", {"file": SimpleUploadedFile("scan.pdf", stream.getvalue()), "is_sample": "true"})
        self.assertEqual(response.json()["status"], "failed")
        self.assertFalse(response.json()["active"])
        self.assertIn("p.1", response.json()["error"])

    def test_audio_requires_ack_and_config_and_does_not_store_file(self):
        path = f"/api/meetings/{self.meeting.pk}/audio/"
        self.assertEqual(self.client.post(path, {}).status_code, 403)
        self.assertEqual(self.client.post(path, {"is_sample": "true"}).status_code, 503)
        wave = b"RIFF\x00\x00\x00\x00WAVE" + b"0" * 100
        with patch("core.providers.provider_features", return_value={"transcription_available": True}), patch("core.providers.transcribe_audio", return_value="料金はいくらですか？") as transcribe:
            response = self.client.post(path, {"file": SimpleUploadedFile("audio.wav", wave), "is_sample": "true", "client_id": "audio-1"})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.json()["questions"]), 1)
        transcribe.assert_called_once()

    def test_real_meeting_cannot_be_sent_when_setting_disabled(self):
        self.meeting.is_sample = False
        self.meeting.save()
        with patch("core.views.answer_question") as run:
            result = self.answer(self.new_question()).json()
        self.assertEqual(result["status"], "error")
        run.assert_not_called()
        with patch("core.providers.transcribe_audio") as transcribe:
            response = self.client.post(f"/api/meetings/{self.meeting.pk}/audio/", {"is_sample": "true"})
        self.assertEqual(response.status_code, 403)
        transcribe.assert_not_called()

    @override_settings(TRANSCRIPTION_MODE="whisper")
    @patch("core.whisper_local.readiness", return_value=(True, "Whisper base"))
    def test_local_audio_errors_remain_errors_and_preserve_history(self, _ready):
        from core.tests.test_whisper_local import wav_bytes
        from core.whisper_local import InvalidAudio, WhisperBusy, WhisperTimeout
        path = f"/api/meetings/{self.meeting.pk}/audio/"
        previous = self.new_question()
        for exception, status, code in [(InvalidAudio("invalid"), 400, "invalid_audio"),
                                        (WhisperBusy("busy"), 503, "transcription_busy"),
                                        (WhisperTimeout("timeout"), 504, "transcription_timeout")]:
            with patch("core.whisper_local.local_whisper.transcribe", side_effect=exception):
                response = self.client.post(path, {"file": SimpleUploadedFile("audio.wav", wav_bytes()), "is_sample": "true"})
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json()["code"], code)
        self.assertEqual(list(self.meeting.questions.values_list("pk", flat=True)), [previous.pk])
        self.assertEqual(Transcript.objects.count(), 0)

    @override_settings(TRANSCRIPTION_MODE="whisper")
    @patch("core.whisper_local.readiness", return_value=(True, "Whisper base"))
    def test_local_audio_idempotency_silence_and_meeting_end(self, _ready):
        from core.tests.test_whisper_local import wav_bytes
        path = f"/api/meetings/{self.meeting.pk}/audio/"
        def upload(client_id):
            return self.client.post(path, {"file": SimpleUploadedFile("audio.wav", wav_bytes()), "is_sample": "true", "client_id": client_id})
        with patch("core.whisper_local.local_whisper.transcribe", return_value="料金はいくらですか？") as transcribe:
            first = upload("local-1")
            self.assertEqual(first.status_code, 201)
            self.assertEqual(upload("local-1").json(), first.json())
            transcribe.assert_called_once()
        with patch("core.whisper_local.local_whisper.transcribe", return_value=""):
            self.assertEqual(upload("silence").json(), {"transcript": None, "questions": []})
        def end_while_recognizing(_contents):
            self.meeting.status = "ended"
            self.meeting.save()
            return "保存地域はどこですか？"
        with patch("core.whisper_local.local_whisper.transcribe", side_effect=end_while_recognizing):
            self.assertEqual(upload("ended").status_code, 409)
        self.assertEqual(Transcript.objects.count(), 1)
