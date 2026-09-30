"""Small, inspectable Japanese extractive retriever for the local PoC.

It returns actual document passages, never guesses missing product facts. This is
a baseline with explicit limitations, not an evaluated semantic search model.
"""
import re
import unicodedata

from .models import Chunk

FACETS = {
    "料金": ("料金", "価格", "費用", "月額", "いくら"),
    "初期費用": ("初期費用", "初期料金", "初期コスト"),
    "導入期間": ("導入", "何週間", "利用開始", "納期", "いつから"),
    "連携": ("連携", "インテグレーション"),
    "API": ("api",),
    "Salesforce連携": ("salesforce", "セールスフォース"),
    "Slack連携": ("slack", "スラック"),
    "SSO": ("sso", "シングルサインオン", "saml"),
    "IP制限": ("ip制限", "ipアドレス制限", "ipアドレスによる"),
    "暗号化": ("暗号",),
    "データ保存地域": ("保存地域", "データセンター", "国内保存", "データの保存先", "保存場所", "リージョン"),
    "データ保持期間": ("保持期間", "保存期間", "データ保持"),
    "最低契約期間": ("最低契約", "契約期間", "年間契約", "月単位"),
    "解約": ("解約", "キャンセル", "退会"),
    "利用人数": ("人数", "何人", "ユーザー数", "名まで", "名で", "名利用", "人で", "人利用"),
    "サポート": ("サポート", "窓口", "問い合わせ対応"),
    "値引き": ("値引", "割引", "ディスカウント"),
    "無料トライアル": ("トライアル", "無料体験", "お試し"),
    "モバイル": ("スマホ", "モバイル", "スマートフォン", "iphone", "android"),
    "機能": ("機能", "何ができ", "できること"),
    "提供予定": ("リリース予定", "提供予定", "ロードマップ", "来月", "来年", "今後", "将来", "新機能"),
}
NEGATIVE = re.compile(r"(?:非対応|未対応|利用できません|できない|対象外|提供していません)")
INSTRUCTION = re.compile(r"(?:以前の指示を無視|上記の指示を無視|ignore (?:all |previous )?instructions|system prompt)", re.I)


def normalize(text):
    return unicodedata.normalize("NFKC", text).lower()


def facets(text):
    normalized = normalize(text)
    return {name for name, terms in FACETS.items() if any(term in normalized for term in terms)}


def grams(text):
    cleaned = normalize(text)
    for stop in ("教えてください", "ありますか", "できますか", "でしょうか", "について", "ください", "ですか", "ますか", "したい", "知りたい", "この", "その", "それ", "どの", "くらい", "こと"):
        cleaned = cleaned.replace(stop, "")
    words = re.findall(r"[a-z0-9]+|[一-龯ぁ-んァ-ヶー]+", cleaned)
    result = set()
    for word in words:
        if re.match("[a-z0-9]", word):
            result.add(word)
        else:
            result.update(word[i:i + 2] for i in range(len(word) - 1))
    return result


def source_for(chunk):
    doc = chunk.document
    adjacent = list(doc.chunks.filter(position__gte=max(0, chunk.position - 1), position__lte=chunk.position + 1).values_list("text", flat=True))
    return {
        "id": str(chunk.id), "document_id": str(doc.id), "document_name": doc.name,
        "location": chunk.location, "quote": chunk.text,
        "context": "\n\n".join(adjacent), "version": doc.version,
        "active": doc.active, "is_sample": doc.is_sample,
    }


def search(question, team_id, context=""):
    query = question
    if re.match(r"^(それ|その|こちら|これ|そこ)", question.strip()) and context:
        query = context + " " + question
    wanted = facets(query)
    tokens = grams(query)
    entities = set(re.findall(r"[a-z][a-z0-9+-]{2,}", normalize(query))) - {"api", "sso", "saml", "csv", "pdf"}
    # Explicit vendor / plan names are applicability constraints. A passage
    # about a different integration must not answer a broad 'integration' hit.
    alias_groups = [("salesforce", "セールスフォース"), ("slack", "スラック"), ("standard", "スタンダード"), ("enterprise", "エンタープライズ"), ("sso", "シングルサインオン", "saml"), ("スマートフォン", "モバイル", "スマホ")]
    required = []
    for entity in entities:
        required.append(next((group for group in alias_groups if entity in group), (entity,)))
    for entity in re.findall(r"([ァ-ヶー]{3,})(?:と連携|に対応|プラン)", query):
        required.append(next((group for group in alias_groups if entity in group), (entity,)))
    candidates = []
    for chunk in Chunk.objects.select_related("document").filter(document__team_id=team_id, document__active=True, document__status__in=["ready", "partial"]):
        combined = chunk.location + " " + chunk.text
        if INSTRUCTION.search(combined):
            continue
        normalized = normalize(combined)
        if any(not any(term in normalized for term in group) for group in required):
            continue
        if "提供予定" in wanted and "提供予定" not in facets(combined):
            continue
        covered = facets(combined) & wanted
        overlap = len(tokens & grams(combined)) / max(len(tokens), 1)
        if wanted and not covered:
            continue
        if not wanted and (overlap < .35 or len(tokens & grams(combined)) < 2):
            continue
        score = len(covered) * 3 + overlap
        candidates.append((score, chunk, covered))
    candidates.sort(key=lambda item: (-item[0], item[1].position, str(item[1].id)))
    # Prefer passages directly about the question; retain parallel sources to
    # expose contradictions instead of selecting one version silently.
    best = candidates[0][0] if candidates else 0
    threshold = max(1.5, best * .45) if wanted else max(.35, best * .65)
    selected = [item for item in candidates if item[0] >= threshold][:6]
    covered = set().union(*(item[2] for item in selected)) if selected else set()
    return [source_for(item[1]) for item in selected], sorted(wanted - covered)


def conflicts(question, sources):
    wanted = facets(question)
    plan_alias = {"スタンダード": "standard", "エンタープライズ": "enterprise"}
    plan_pattern = r"(?:standard|pro|enterprise|スタンダード|エンタープライズ)"
    question_plans = {plan_alias.get(p, p) for p in re.findall(plan_pattern, normalize(question))}
    for facet in wanted:
        pertinent = [s for s in sources if facet in facets(s["quote"] + " " + s["location"])]
        if len({s["document_id"] for s in pertinent}) < 2:
            continue
        values = []
        for source in pertinent:
            for text in re.split(r"[。\n]", normalize(source["quote"])):
                # Scope eligibility/negation to the actual statement rather
                # than an unrelated plan elsewhere in the same passage.
                if facet not in facets(text):
                    continue
                plan = [plan_alias.get(p, p) for p in re.findall(plan_pattern, text)]
                if question_plans and plan and not question_plans.intersection(plan):
                    continue
                if facet == "料金":
                    value = re.findall(r"月額(?:料金)?[は：:\s]*([0-9,]+)\s*円", text)
                elif facet == "導入期間":
                    value = re.findall(r"(\d+\s*[〜~～-]\s*\d+|\d+)\s*週間", text)
                elif facet in {"IP制限", "SSO", "Salesforce連携", "Slack連携"}:
                    value = ["no" if NEGATIVE.search(text) else "yes"]
                else:
                    continue
                if value:
                    values.append((tuple(plan[:1]), tuple(value), source["document_id"]))
        for i, left in enumerate(values):
            if any(left[0] == right[0] and left[1] != right[1] and left[2] != right[2] for right in values[i + 1:]):
                return True
    return False


def extract_sentences(source):
    text = source["quote"]
    text = re.sub(r"^Q[：:].*\n?", "", text, flags=re.M)
    text = re.sub(r"^(?:A[：:]|回答[：:])\s*", "", text, flags=re.M)
    return [s.strip() for s in re.findall(r"[^。！？\n]+[。！？]?", text) if s.strip()]


def local_answer(question, sources, missing):
    if not sources:
        return {"answer": "登録資料では確認できません", "conditions": [], "missing_points": missing or ["質問に対応する記載が登録資料にありません。"], "evidence_state": "missing", "source_ids": []}
    if conflicts(question, sources):
        return {"answer": "資料間で記載が異なるため、現時点では断定できません。両方の根拠を確認してください。", "conditions": [], "missing_points": ["適用する資料・版と条件の確認が必要です。"], "evidence_state": "conflict", "source_ids": [s["id"] for s in sources]}
    selected = []
    seen = set()
    wanted = facets(question)
    for source in sources:
        remaining = (facets(source["quote"] + source["location"]) & wanted) - seen
        if not selected or remaining:
            selected.append(source)
            seen |= remaining
        if len(selected) == 3:
            break
    sentences = []
    conditions = []
    for number, source in enumerate(selected, 1):
        parts = extract_sentences(source)
        if not parts:
            continue
        # The entire passage remains visible in citations. Extra sentences are
        # conditions, never silently discarded (notably pricing eligibility).
        sentences.append(parts[0] + f" [{number}]")
        conditions.extend(part + f" [{number}]" for part in parts[1:])
    partial = list(missing)
    if "料金" in facets(question):
        pricing = " ".join(s["quote"] for s in selected)
        for label, pattern in (("料金の税区分", r"税込|税別|税抜|消費税"), ("料金の対象プラン", r"プラン"), ("料金の人数条件", r"\d+\s*(?:名|人)|ユーザー"), ("料金の契約期間", r"契約|月単位|年単位")):
            if not re.search(pattern, pricing):
                partial.append(label + "が資料から確認できません。")
    for source in selected:
        if re.search(r"未記載|別途確認|個別確認|要確認", source["quote"]):
            partial.append("資料に別途確認が必要な条件があります。")
    return {
        "answer": "\n".join(sentences), "conditions": list(dict.fromkeys(conditions)),
        "missing_points": list(dict.fromkeys(partial)),
        "evidence_state": "partial" if partial else "supported",
        "source_ids": [s["id"] for s in selected],
    }


def answer_question(question, team_id, context=""):
    sources, missing = search(question, team_id, context)
    result = local_answer(question, sources, missing)
    # Missing evidence and contradictions cannot be overridden by a generator.
    if sources and result["evidence_state"] not in {"missing", "conflict"}:
        from django.conf import settings
        if not settings.ALLOW_REAL_DATA and any(not source["is_sample"] for source in sources):
            raise ValueError("実資料の利用は無効です。")
        from .providers import generate_answer
        generated = generate_answer(question, context, sources)
        if generated is not None:
            ids = generated.get("source_ids", [])
            valid = {s["id"] for s in sources}
            state = generated.get("evidence_state")
            if not isinstance(ids, list) or (not ids and state != "missing") or not all(isinstance(sid, str) for sid in ids) or not set(ids).issubset(valid):
                raise ValueError("AI回答の根拠を確認できませんでした。")
            if generated.get("evidence_state") not in {"supported", "partial", "missing", "conflict"}:
                raise ValueError("AI回答の状態を確認できませんでした。")
            if not isinstance(generated.get("answer"), str) or not all(isinstance(generated.get(key), list) and all(isinstance(v, str) for v in generated[key]) for key in ("conditions", "missing_points")):
                raise ValueError("AI回答の形式を確認できませんでした。")
            if state == "missing":
                generated.update(answer="登録資料では確認できません", conditions=[], source_ids=[])
            else:
                # Local condition markers refer to the local citation order.
                # Retain those sources first before appending provider-only ones.
                generated["source_ids"] = list(dict.fromkeys(result["source_ids"] + generated["source_ids"]))
                generated["conditions"] = list(dict.fromkeys(generated["conditions"] + result["conditions"]))
                generated["missing_points"] = list(dict.fromkeys(generated["missing_points"] + result["missing_points"]))
                if result["evidence_state"] == "partial" and state == "supported":
                    generated["evidence_state"] = "partial"
            result = generated
    by_id = {s["id"]: s for s in sources}
    result["sources"] = [by_id[sid] for sid in result["source_ids"]]
    return result
