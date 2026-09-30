"""Explicit deterministic baseline. No speaker identity is inferred."""
import re

QUESTION = re.compile(r"[?？]|(?:です|ます|でしょう|可能|ある|いる|できる)か(?:[。\s]|$)|知りたい|教えて(?:ください|いただ)|伺いたい|聞きたい|どのくらい|いくら|何人|何週間|いつから")


def detect_questions(text):
    segments = re.findall(r"[^。!?！？\n]+[。!?！？]?", text)
    return [segment.strip() for segment in segments if QUESTION.search(segment.strip())]
