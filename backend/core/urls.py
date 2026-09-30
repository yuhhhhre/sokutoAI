from django.urls import path
from . import views

urlpatterns = [
    path("bootstrap/", views.bootstrap),
    path("auth/login/", views.auth_login),
    path("auth/logout/", views.auth_logout),
    path("meetings/", views.meetings),
    path("meetings/<uuid:meeting_id>/", views.meeting_detail),
    path("meetings/<uuid:meeting_id>/questions/", views.question_create),
    path("meetings/<uuid:meeting_id>/transcripts/", views.transcript_create),
    path("meetings/<uuid:meeting_id>/audio/", views.audio_create),
    path("questions/<uuid:question_id>/", views.question_detail),
    path("questions/<uuid:question_id>/answer/", views.question_answer),
    path("documents/", views.documents),
    path("documents/<uuid:document_id>/", views.document_detail),
    path("documents/<uuid:document_id>/delete-preview/", views.document_delete_preview),
    path("members/", views.members),
    path("members/<int:user_id>/", views.member_detail),
]
