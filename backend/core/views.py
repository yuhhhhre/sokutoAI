import json
import logging
import time
import uuid
from functools import wraps
from pathlib import Path

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ObjectDoesNotExist, ValidationError
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import F
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.views.decorators.csrf import ensure_csrf_cookie

from .detection import detect_questions
from .ingestion import ingest_document
from .models import Citation, Document, Meeting, Membership, Question, Team, Transcript
from .retrieval import answer_question
from .serializers import document_data, meeting_data, question_data, transcript_data, user_data

logger = logging.getLogger(__name__)
User = get_user_model()


class APIError(Exception):
    def __init__(self, message, status=400, code="invalid_request"):
        self.message, self.status, self.code = message, status, code


def error_response(message, status=400, code="invalid_request"):
    return JsonResponse({"error": message, "code": code}, status=status)


def csrf_failure(request, reason=""):
    return error_response("接続の有効期限が切れました。画面を再読み込みしてください。", 403, "csrf_failed")


def require_member(request, admin=False):
    if not request.user.is_authenticated or not request.user.is_active:
        raise APIError("再ログインが必要です。", 401, "unauthenticated")
    member = Membership.objects.select_related("team", "user").filter(user_id=request.user.pk, user__is_active=True).first()
    if not member:
        raise APIError("所属チームを確認できません。", 403, "forbidden")
    if admin and member.role != "admin":
        raise APIError("管理担当者の権限が必要です。", 403, "forbidden")
    request.member = member
    return member


def endpoint(methods, *, public=False, admin=False):
    def decorate(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            try:
                if request.method not in methods:
                    return error_response("この操作には対応していません。", 405, "method_not_allowed")
                if not public:
                    require_member(request, admin)
                return view(request, *args, **kwargs)
            except APIError as exc:
                return error_response(exc.message, exc.status, exc.code)
            except (ObjectDoesNotExist, ValidationError):
                return error_response("対象が見つからないか、アクセスする権限がありません。", 404, "not_found")
            except DatabaseError:
                logger.warning("Database operation failed", exc_info=True)
                return error_response("処理が混み合っています。少し待って再試行してください。", 503, "database_busy")
        return wrapped
    return decorate


def body(request):
    try:
        value = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise APIError("JSON形式を確認してください。")
    if not isinstance(value, dict):
        raise APIError("入力形式を確認してください。")
    return value


def text_field(data, key, *, default=None, limit=6000):
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise APIError(f"{key}を1〜{limit}文字で入力してください。")
    return value.strip()


def client_id(data):
    value = data.get("client_id")
    if value is not None and (not isinstance(value, str) or not value or len(value) > 160):
        raise APIError("入力の識別子を確認してください。")
    return value


def owned_meeting(request, meeting_id):
    return Meeting.objects.get(id=meeting_id, owner=request.user, team=request.member.team)


def owned_question(request, question_id):
    return Question.objects.select_related("meeting").get(id=question_id, meeting__owner=request.user, meeting__team=request.member.team)


def team_document(request, document_id):
    return Document.objects.get(id=document_id, team=request.member.team)


def ensure_active(meeting):
    if meeting.status != "active":
        raise APIError("終了した商談には追加できません。新しい商談を開始してください。", 409, "meeting_ended")


def features():
    from .providers import provider_features
    result = provider_features()
    return {**result, "real_data_allowed": settings.ALLOW_REAL_DATA, "demo_login_available": settings.DEMO_LOGIN_ENABLED and User.objects.filter(username="demo", is_active=True, membership__isnull=False).exists(), "max_upload_mb": settings.MAX_UPLOAD_MB}


@ensure_csrf_cookie
@endpoint(["GET"], public=True)
def bootstrap(request):
    user = None
    if request.user.is_authenticated:
        try:
            require_member(request)
            user = user_data(request.user)
        except APIError:
            logout(request)
    return JsonResponse({"user": user, "csrf_token": get_token(request), "features": features()})


@endpoint(["POST"], public=True)
def auth_login(request):
    data = body(request)
    username = text_field(data, "username", limit=150)
    password = text_field(data, "password", limit=1000)
    if username == "demo" and not settings.DEMO_LOGIN_ENABLED:
        raise APIError("デモログインは無効です。", 403, "demo_disabled")
    user = authenticate(request, username=username, password=password)
    if not user or not Membership.objects.filter(user=user).exists():
        raise APIError("ユーザー名またはパスワードを確認してください。", 401, "invalid_credentials")
    login(request, user)
    return JsonResponse({"user": user_data(user), "csrf_token": get_token(request)})


@endpoint(["POST"], public=True)
def auth_logout(request):
    logout(request)
    return JsonResponse({"ok": True})


@endpoint(["GET", "POST"])
def meetings(request):
    if request.method == "GET":
        return JsonResponse([meeting_data(m) for m in Meeting.objects.filter(team=request.member.team, owner=request.user)], safe=False)
    data = body(request)
    title = text_field(data, "title", limit=200)
    mode = data.get("mode", "online")
    if not isinstance(mode, str) or mode not in {"online", "in_person"}:
        raise APIError("商談モードを確認してください。")
    is_sample = data.get("is_sample", True)
    if not isinstance(is_sample, bool) or (not is_sample and not settings.ALLOW_REAL_DATA):
        raise APIError("現在は架空データによる検証のみ利用できます。", 403, "real_data_disabled")
    meeting = Meeting.objects.create(team=request.member.team, owner=request.user, title=title, mode=mode, is_sample=is_sample)
    return JsonResponse(meeting_data(meeting, True), status=201)


@endpoint(["GET", "PATCH"])
def meeting_detail(request, meeting_id):
    meeting = owned_meeting(request, meeting_id)
    if request.method == "PATCH":
        data = body(request)
        if data.get("status") != "ended":
            raise APIError("商談の状態を確認してください。")
        meeting.status = "ended"
        meeting.save(update_fields=["status"])
    return JsonResponse(meeting_data(meeting, True))


@endpoint(["POST"])
def question_create(request, meeting_id):
    meeting = owned_meeting(request, meeting_id)
    data = body(request)
    text = text_field(data, "text")
    source = data.get("source", "manual")
    if not isinstance(source, str) or source not in {"manual", "demo"}:
        raise APIError("質問の入力元を確認してください。")
    request_id = client_id(data)
    if request_id:
        existing = meeting.questions.filter(client_id=request_id).first()
        if existing:
            if existing.text != text:
                raise APIError("同じ入力識別子を別の質問には使えません。", 409, "idempotency_conflict")
            return JsonResponse(question_data(existing))
    ensure_active(meeting)
    try:
        with transaction.atomic():
            question = Question.objects.create(meeting=meeting, text=text, source=source, client_id=request_id)
    except IntegrityError:
        question = meeting.questions.get(client_id=request_id)
        if question.text != text:
            raise APIError("同じ入力識別子を別の質問には使えません。", 409, "idempotency_conflict")
    return JsonResponse(question_data(question), status=201)


@endpoint(["PATCH", "DELETE"])
def question_detail(request, question_id):
    question = owned_question(request, question_id)
    if request.method == "DELETE":
        Question.objects.filter(pk=question.pk).update(status="cancelled", revision=F("revision") + 1, attempt_id=None, answer="", conditions=[], missing_points=[], evidence_state=None, error="", elapsed_ms=None)
        question.citations.all().delete()
        return JsonResponse({"ok": True})
    if question.status == "cancelled":
        raise APIError("この質問は取り消されています。", 409, "cancelled")
    data = body(request)
    updates = {}
    if "outcome" in data:
        if not isinstance(data["outcome"], str) or data["outcome"] not in {"", "answered", "follow_up"}:
            raise APIError("対応結果を確認してください。")
        updates["outcome"] = data["outcome"]
    text_changed = "text" in data and text_field(data, "text") != question.text
    if text_changed:
        updates.update(text=text_field(data, "text"), revision=F("revision") + 1, status="pending", attempt_id=None, answer="", conditions=[], missing_points=[], evidence_state=None, error="", elapsed_ms=None, outcome="")
    if not updates:
        return JsonResponse(question_data(question))
    with transaction.atomic():
        if not Question.objects.filter(pk=question.pk, revision=question.revision).exclude(status="cancelled").update(**updates):
            raise APIError("質問が更新されています。最新の内容で再試行してください。", 409, "stale_revision")
        if text_changed:
            question.citations.all().delete()
    question.refresh_from_db()
    return JsonResponse(question_data(question))


@endpoint(["POST"])
def question_answer(request, question_id):
    question = owned_question(request, question_id)
    revision = body(request).get("revision")
    if type(revision) is not int or revision != question.revision:
        raise APIError("質問が更新されています。最新の内容で再試行してください。", 409, "stale_revision")
    if question.status == "cancelled":
        raise APIError("この質問は取り消されています。", 409, "cancelled")
    if question.status == "ready":
        return JsonResponse(question_data(question))
    now = timezone.now()
    if question.status == "searching" and question.started_at and (now - question.started_at).total_seconds() < settings.ANSWER_TIMEOUT_SECONDS:
        return JsonResponse(question_data(question), status=202)
    attempt = uuid.uuid4()
    # Claim the exact revision AND previous attempt. A second request cannot
    # overwrite an active attempt, and a timed-out attempt cannot win on return.
    claimed = Question.objects.filter(pk=question.pk, revision=revision, status=question.status, attempt_id=question.attempt_id).update(status="searching", attempt_id=attempt, started_at=now, error="", evidence_state=None, answer="", conditions=[], missing_points=[])
    if not claimed:
        raise APIError("処理状態が更新されました。最新の内容を確認してください。", 409, "attempt_changed")
    started = time.monotonic()
    try:
        if not question.meeting.is_sample and not settings.ALLOW_REAL_DATA:
            raise ValueError("実データの利用は無効です。")
        result = answer_question(question.text, request.member.team_id, question.context)
        if time.monotonic() - started > settings.ANSWER_TIMEOUT_SECONDS:
            raise TimeoutError("回答の準備が時間切れになりました。")
        require_member(request)
        if not Question.objects.filter(pk=question.pk, meeting__owner=request.user, meeting__team=request.member.team).exists():
            raise APIError("この商談を閲覧する権限がありません。", 403, "forbidden")
        document_ids = {s["document_id"] for s in result["sources"]}
        with transaction.atomic():
            # Take SQLite's write lock before reading document state. Two
            # simultaneous answers must not upgrade competing read snapshots.
            if not Question.objects.filter(pk=question.pk, revision=revision, attempt_id=attempt, status="searching").update(started_at=F("started_at")):
                raise APIError("質問が更新されています。以前の結果は反映しませんでした。", 409, "stale_revision")
            if Document.objects.filter(id__in=document_ids, team_id=request.member.team_id, active=True).count() != len(document_ids):
                raise ValueError("処理中に参照資料が変更されました。再試行してください。")
            updated = Question.objects.filter(pk=question.pk, revision=revision, attempt_id=attempt, status="searching", meeting__owner_id=request.user.pk, meeting__team_id=request.member.team_id).update(
                status="ready", answer=result["answer"], conditions=result["conditions"], missing_points=result["missing_points"], evidence_state=result["evidence_state"], error="", elapsed_ms=round((time.monotonic() - started) * 1000),
            )
            if not updated:
                raise APIError("質問が更新または取り消されたため、以前の結果は反映しませんでした。", 409, "stale_revision")
            question.citations.all().delete()
            Citation.objects.bulk_create([Citation(question_id=question.pk, document_id=s["document_id"], document_name=s["document_name"], location=s["location"], quote=s["quote"], context=s["context"], version=s["version"], is_sample=s["is_sample"], position=i) for i, s in enumerate(result["sources"])])
    except APIError:
        raise
    except Exception:
        # Provider/network details may contain URLs, prompts or credentials.
        # Only controlled text is ever returned to the client or stored.
        error = "時間内に回答を準備できませんでした。再試行してください。" if time.monotonic() - started >= settings.ANSWER_TIMEOUT_SECONDS else "資料を検索・処理できませんでした。再試行してください。"
        updated = Question.objects.filter(pk=question.pk, revision=revision, attempt_id=attempt, status="searching").update(status="error", error=error, evidence_state=None, elapsed_ms=round((time.monotonic() - started) * 1000))
        if not updated:
            raise APIError("質問が更新されています。以前の結果は反映しませんでした。", 409, "stale_revision")
    question.refresh_from_db()
    return JsonResponse(question_data(question))


def save_transcript(meeting, text, request_id):
    with transaction.atomic():
        # Establish a write lock before checking the current meeting state.
        # A concurrent end action cannot slip between this check and insertion.
        if not Meeting.objects.filter(pk=meeting.pk, status="active").update(status=F("status")):
            raise APIError("商談は終了しています。新しい商談を開始してください。", 409, "meeting_ended")
        if request_id:
            transcript, created = Transcript.objects.get_or_create(meeting=meeting, client_id=request_id, defaults={"text": text})
            if not created:
                if transcript.text != text:
                    raise APIError("同じ入力識別子を別の発言には使えません。", 409, "idempotency_conflict")
                return {"transcript": transcript_data(transcript), "questions": [question_data(q) for q in transcript.questions.all()]}
        else:
            transcript = Transcript.objects.create(meeting=meeting, text=text)
        previous = meeting.transcripts.exclude(id=transcript.id).order_by("-created_at").first()
        context = previous.text if previous else ""
        questions = [Question.objects.create(meeting=meeting, transcript=transcript, text=question, context=context, source="transcript") for question in detect_questions(text)]
    return {"transcript": transcript_data(transcript), "questions": [question_data(q) for q in questions]}


@endpoint(["POST"])
def transcript_create(request, meeting_id):
    meeting = owned_meeting(request, meeting_id)
    ensure_active(meeting)
    data = body(request)
    if data.get("is_final", True) is not True:
        raise APIError("確定した発言のみ送信してください。", 400, "interim_transcript")
    return JsonResponse(save_transcript(meeting, text_field(data, "text", limit=12000), client_id(data)), status=201)


@endpoint(["POST"])
def audio_create(request, meeting_id):
    meeting = owned_meeting(request, meeting_id)
    ensure_active(meeting)
    if not settings.ALLOW_REAL_DATA and (not meeting.is_sample or request.POST.get("is_sample") != "true"):
        raise APIError("架空の模擬音声であることを確認してください。", 403, "real_data_disabled")
    request_id = client_id(request.POST)
    if request_id:
        existing = meeting.transcripts.filter(client_id=request_id).first()
        if existing:
            return JsonResponse({"transcript": transcript_data(existing), "questions": [question_data(q) for q in existing.questions.all()]})
    from .providers import provider_features, transcribe_audio
    from .whisper_local import InvalidAudio, WhisperBusy, WhisperError, WhisperTimeout
    features = provider_features()
    if not features.get("transcription_available"):
        raise APIError(features.get("transcription_label", "音声文字起こしが未設定です。手入力をご利用ください。"), 503, "transcription_unavailable")
    upload = request.FILES.get("file")
    if not upload or upload.size > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise APIError("音声ファイルのサイズを確認してください。")
    audio = upload.read()
    if len(audio) < 12 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        raise APIError("WAV形式の音声を送信してください。")
    try:
        text = transcribe_audio(audio, "audio.wav").strip()
    except InvalidAudio as exc:
        raise APIError(str(exc), 400, "invalid_audio")
    except WhisperBusy as exc:
        raise APIError(str(exc), 503, "transcription_busy")
    except WhisperTimeout as exc:
        raise APIError(str(exc), 504, "transcription_timeout")
    except WhisperError as exc:
        raise APIError(str(exc), 503, "transcription_unavailable")
    except Exception:
        raise APIError("音声を文字起こしできませんでした。入力を確認して再試行してください。", 502, "transcription_failed")
    if not text:
        return JsonResponse({"transcript": None, "questions": []})
    require_member(request)
    ensure_active(owned_meeting(request, meeting_id))
    return JsonResponse(save_transcript(meeting, text, request_id), status=201)


@endpoint(["GET", "POST"])
def documents(request):
    if request.method == "GET":
        return JsonResponse([document_data(d) for d in Document.objects.filter(team=request.member.team)], safe=False)
    require_member(request, admin=True)
    upload = request.FILES.get("file")
    if not upload:
        raise APIError("ファイルを選択してください。")
    if upload.size > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise APIError(f"ファイルは{settings.MAX_UPLOAD_MB}MB以下にしてください。", 413, "file_too_large")
    source_type = Path(upload.name).suffix.lower().lstrip(".")
    if source_type not in {"txt", "md", "markdown", "pdf"}:
        raise APIError("TXT・Markdown・文字選択可能なPDFを選択してください。", 415, "unsupported_file")
    is_sample = request.POST.get("is_sample") == "true"
    if not is_sample and not settings.ALLOW_REAL_DATA:
        raise APIError("現在は架空データのみ登録できます。", 403, "real_data_disabled")
    name = request.POST.get("name", "").strip() or upload.name
    version = request.POST.get("version", "").strip()
    if len(name) > 240 or len(version) > 120:
        raise APIError("資料名または版の文字数を確認してください。")
    replacement = request.POST.get("replaces_id")
    old = team_document(request, replacement) if replacement else None
    with transaction.atomic():
        document = ingest_document(team=request.member.team, name=name, version=version, source_type=source_type, contents=upload.read(), is_sample=is_sample)
        # Failed replacements cannot silently remove the last usable version.
        if old and document.status == "ready":
            old.active = False
            old.save(update_fields=["active"])
    return JsonResponse(document_data(document, True), status=201)


@endpoint(["GET", "PATCH", "DELETE"])
def document_detail(request, document_id):
    document = team_document(request, document_id)
    if request.method == "GET":
        return JsonResponse(document_data(document, True))
    require_member(request, admin=True)
    if request.method == "PATCH":
        active = body(request).get("active")
        if not isinstance(active, bool):
            raise APIError("検索対象の状態を確認してください。")
        if active and document.status == "failed":
            raise APIError("文章を読み取れない資料は検索対象にできません。", 409, "unreadable_document")
        document.active = active
        document.save(update_fields=["active"])
        return JsonResponse(document_data(document))
    with transaction.atomic():
        affected = Question.objects.filter(citations__document=document).distinct()
        count = affected.count()
        affected.delete()
        document.delete()
    return JsonResponse({"ok": True, "deleted_questions": count})


@endpoint(["GET"], admin=True)
def document_delete_preview(request, document_id):
    document = team_document(request, document_id)
    return JsonResponse({"name": document.name, "affected_questions": Question.objects.filter(citations__document=document).distinct().count(), "chunk_count": document.chunks.count()})


@endpoint(["GET", "POST"], admin=True)
def members(request):
    if request.method == "GET":
        users = User.objects.filter(membership__team=request.member.team).select_related("membership__team").order_by("id")
        return JsonResponse([user_data(user) for user in users], safe=False)
    data = body(request)
    username = text_field(data, "username", limit=150)
    if not all(character.isalnum() or character in "@.+-_" for character in username):
        raise APIError("ユーザー名は文字・数字と @ . + - _ を使用してください。")
    password = text_field(data, "password", limit=1000)
    display_name = text_field(data, "display_name", default=username, limit=150)
    role = data.get("role", "member")
    if not isinstance(role, str) or role not in {"admin", "member"}:
        raise APIError("役割を確認してください。")
    new_user = User(username=username, first_name=display_name)
    try:
        validate_password(password, new_user)
    except ValidationError as exc:
        raise APIError(" ".join(exc.messages))
    try:
        with transaction.atomic():
            new_user.set_password(password)
            new_user.save()
            Membership.objects.create(user=new_user, team=request.member.team, role=role)
    except IntegrityError:
        raise APIError("このユーザー名は使用できません。", 409, "username_unavailable")
    return JsonResponse(user_data(new_user), status=201)


@endpoint(["PATCH"], admin=True)
def member_detail(request, user_id):
    data = body(request)
    if "is_active" in data and not isinstance(data["is_active"], bool):
        raise APIError("利用状態を確認してください。")
    if "role" in data and (not isinstance(data["role"], str) or data["role"] not in {"admin", "member"}):
        raise APIError("役割を確認してください。")
    with transaction.atomic():
        # SQLite ignores select_for_update; an actual team write obtains the
        # write lock before checking the last-admin invariant.
        Team.objects.filter(pk=request.member.team_id).update(name=F("name"))
        require_member(request, admin=True)
        member = Membership.objects.select_related("user").get(user_id=user_id, team=request.member.team)
        active = data.get("is_active", member.user.is_active)
        role = data.get("role", member.role)
        if member.role == "admin" and member.user.is_active and (not active or role != "admin"):
            others = Membership.objects.filter(team=request.member.team, role="admin", user__is_active=True).exclude(pk=member.pk)
            if not others.exists():
                raise APIError("最後の管理担当者は利用停止・権限変更できません。", 409, "last_admin")
        member.role = role
        member.save(update_fields=["role"])
        member.user.is_active = active
        member.user.save(update_fields=["is_active"])
    return JsonResponse(user_data(member.user))
