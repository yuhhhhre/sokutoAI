def user_data(user):
    member = user.membership
    return {"id": user.pk, "username": user.username, "display_name": user.first_name or user.username, "role": member.role, "team_name": member.team.name, "is_active": user.is_active}


def citation_data(citation):
    return {"id": str(citation.id), "document_id": str(citation.document_id), "document_name": citation.document_name, "location": citation.location, "quote": citation.quote, "context": citation.context, "version": citation.version, "active": citation.document.active, "is_sample": citation.is_sample}


def question_data(question):
    return {
        "id": str(question.id), "meeting_id": str(question.meeting_id), "text": question.text,
        "source": question.source, "status": question.status, "revision": question.revision,
        "answer": question.answer, "conditions": question.conditions, "missing_points": question.missing_points,
        "evidence_state": question.evidence_state, "citations": [citation_data(c) for c in question.citations.select_related("document").all()],
        "outcome": question.outcome, "error": question.error, "created_at": question.created_at.isoformat(), "elapsed_ms": question.elapsed_ms,
        "started_at": question.started_at.isoformat() if question.started_at else None,
    }


def transcript_data(transcript):
    return {"id": str(transcript.id), "text": transcript.text, "created_at": transcript.created_at.isoformat()}


def meeting_data(meeting, detail=False):
    questions = meeting.questions.exclude(status="cancelled")
    result = {"id": str(meeting.id), "title": meeting.title, "mode": meeting.mode, "status": meeting.status, "is_sample": meeting.is_sample, "created_at": meeting.created_at.isoformat(), "question_count": questions.count(), "follow_up_count": questions.filter(outcome="follow_up").count()}
    if detail:
        result["questions"] = [question_data(q) for q in questions]
        result["transcripts"] = [transcript_data(t) for t in meeting.transcripts.all()]
    return result


def document_data(document, detail=False):
    result = {"id": str(document.id), "name": document.name, "version": document.version, "source_type": document.source_type, "status": document.status, "active": document.active, "is_sample": document.is_sample, "created_at": document.created_at.isoformat(), "chunk_count": document.chunks.count(), "error": document.error}
    if detail:
        result["chunks"] = [{"id": str(c.id), "text": c.text, "location": c.location} for c in document.chunks.all()]
    return result
