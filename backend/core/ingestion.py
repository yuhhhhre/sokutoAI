"""Text extraction with source positions; files are never kept on disk."""
from io import BytesIO
import re

from pypdf import PdfReader

from .models import Chunk, Document


def split_sections(text, prefix=""):
    """Keep a heading's paragraphs together so pricing conditions aren't lost."""
    sections = []
    heading = ""
    buffer = []
    paragraph = 1

    def flush():
        nonlocal paragraph
        body = "\n".join(buffer).strip()
        if body:
            location = " ／ ".join(part for part in (prefix, heading or f"段落 {paragraph}") if part)
            sections.append((location[:240], body))
            paragraph += 1
        buffer.clear()

    for line in text.splitlines():
        if re.match(r"^#{1,6}\s+", line):
            flush()
            heading = re.sub(r"^#{1,6}\s+", "", line).strip()
        else:
            buffer.append(line)
    flush()
    # Plain-text documents have no headings: paragraphs are useful source locations.
    if len(sections) == 1 and not heading:
        body = sections[0][1]
        paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        if len(paragraphs) > 1:
            sections = [(" ／ ".join(filter(None, [prefix, f"段落 {i}"])), p) for i, p in enumerate(paragraphs, 1)]
    return sections


def ingest_document(*, team, name, version, source_type, contents, is_sample=True):
    sections = []
    failed_pages = []
    error = ""
    try:
        if source_type == "pdf":
            reader = PdfReader(BytesIO(contents))
            if reader.is_encrypted:
                raise ValueError("暗号化されたPDFには対応していません。")
            for number, page in enumerate(reader.pages, 1):
                try:
                    extracted = page.extract_text() or ""
                except Exception:
                    extracted = ""
                if not extracted.strip():
                    failed_pages.append(f"p.{number}")
                else:
                    sections.extend(split_sections(extracted, f"p.{number}"))
            if failed_pages:
                error = "文章を読み取れないページ：" + "、".join(failed_pages)
        else:
            try:
                text = contents.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = contents.decode("cp932")
            if "\x00" in text:
                raise ValueError("テキスト形式のファイルを選択してください。")
            sections = split_sections(text)
    except Exception as exc:
        error = str(exc) if isinstance(exc, (ValueError, UnicodeError)) else "ファイルから文章を取り出せませんでした。"
    if not sections:
        error = error or "この資料から文章を取り出せませんでした。文字選択可能なPDF・TXT・Markdownをご利用ください。"
    status = "failed" if not sections else "partial" if failed_pages else "ready"
    doc = Document.objects.create(
        team=team, name=name, version=version, source_type=source_type,
        status=status, active=bool(sections), is_sample=is_sample,
        raw_text="\n\n".join(text for _, text in sections), error=error,
    )
    Chunk.objects.bulk_create([Chunk(document=doc, location=location, text=text, position=i) for i, (location, text) in enumerate(sections)])
    return doc
