import uuid

from django.conf import settings
from django.db import models


class Team(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)


class Membership(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="membership")
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=12, choices=[("admin", "管理担当者"), ("member", "営業担当者")], default="member")


class Meeting(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    team = models.ForeignKey(Team, on_delete=models.CASCADE)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    mode = models.CharField(max_length=12, default="online")
    status = models.CharField(max_length=12, default="active")
    is_sample = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Transcript(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="transcripts")
    text = models.TextField()
    client_id = models.CharField(max_length=160, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [models.UniqueConstraint(fields=["meeting", "client_id"], name="unique_transcript_request")]


class Question(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="questions")
    transcript = models.ForeignKey(Transcript, null=True, blank=True, on_delete=models.SET_NULL, related_name="questions")
    text = models.TextField()
    context = models.TextField(blank=True)
    source = models.CharField(max_length=12, default="manual")
    client_id = models.CharField(max_length=180, null=True, blank=True)
    status = models.CharField(max_length=12, default="pending")
    revision = models.PositiveIntegerField(default=1)
    attempt_id = models.UUIDField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    answer = models.TextField(blank=True)
    conditions = models.JSONField(default=list)
    missing_points = models.JSONField(default=list)
    evidence_state = models.CharField(max_length=12, null=True, blank=True)
    outcome = models.CharField(max_length=12, blank=True)
    error = models.TextField(blank=True)
    elapsed_ms = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [models.UniqueConstraint(fields=["meeting", "client_id"], name="unique_question_request")]


class Document(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="documents")
    name = models.CharField(max_length=240)
    version = models.CharField(max_length=120, blank=True)
    source_type = models.CharField(max_length=12)
    status = models.CharField(max_length=12, default="ready")
    active = models.BooleanField(default=True)
    is_sample = models.BooleanField(default=True)
    raw_text = models.TextField(blank=True)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Chunk(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="chunks")
    text = models.TextField()
    location = models.CharField(max_length=240)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position"]


class Citation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="citations")
    document = models.ForeignKey(Document, on_delete=models.CASCADE, related_name="citations")
    document_name = models.CharField(max_length=240)
    location = models.CharField(max_length=240)
    quote = models.TextField()
    context = models.TextField()
    version = models.CharField(max_length=120, blank=True)
    is_sample = models.BooleanField(default=True)
    position = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["position"]
