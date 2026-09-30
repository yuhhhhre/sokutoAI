from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from core.ingestion import ingest_document
from core.models import Citation, Document, Meeting, Membership, Question, Team, Transcript
from core.retrieval import local_answer, search


DOCUMENTS = [
    ("FlowDesk 商品ガイド", "2026.09 / v1.2", """# 商品の概要
FlowDeskは、法人営業チーム向けの架空の案件・顧客情報共有サービスです。本資料に記載した商材・価格・条件は、ソクトウAIの検証専用の架空データです。

# 主な機能
Standardプランには、案件管理、顧客情報の共有、タスク管理、CSVエクスポート機能があります。ブラウザから利用でき、専用のデスクトップアプリのインストールは不要です。

# 利用人数
Standardプランは10名まで利用できます。11名以上での利用はEnterpriseプランの個別見積もりが必要です。

# モバイル対応
スマートフォンのブラウザから案件の閲覧と更新が可能です。専用のiPhone・Androidアプリは提供していません。
"""),
    ("FlowDesk 料金・契約ガイド", "2026.09 / v2.0", """# Standardプランの料金
Standardプランの月額料金は30,000円（税別）で、10名まで利用できます。最低契約期間は12か月で、年払い・国内法人への提供が条件です。初期費用は50,000円（税別）です。

# Enterpriseプランの料金
Enterpriseプランの料金は、利用人数と連携要件を確認したうえで個別に見積もります。金額・税区分・契約期間は個別見積書で確認してください。

# 解約手続き
Standardプランの解約は、契約満了日の30日前までに管理窓口への連絡が必要です。契約期間の途中で解約した場合、支払い済みの料金は返金しません。

# 無料トライアル
Standardプランには14日間の無料トライアルがあります。利用できるのは最大5名までで、トライアル終了後に自動課金はしません。
"""),
    ("FlowDesk 導入ガイド", "2026.09 / v1.1", """# 導入期間
標準構成の導入期間は、申し込み完了後2〜4週間が目安です。顧客情報の初期登録と管理者向けの操作説明を含みます。個別連携の開発期間は含まないため、別途確認が必要です。

# 導入に必要な準備
導入時には、管理担当者1名、利用者のメールアドレス一覧、インターネット接続環境が必要です。既存データの移行は指定のCSVテンプレートを使用してください。

# 既存システムとの連携
Salesforceとの連携とSlackへの通知に対応しています。Standardプランの標準連携は追加料金なしで利用できます。独自システムとの個別連携は、仕様の確認と別途見積もりが必要です。

# API
APIはEnterpriseプランで提供します。StandardプランではAPIを利用できません。
"""),
    ("FlowDesk セキュリティ資料", "2026.09 / v1.0", """# 暗号化
FlowDeskの通信はTLS 1.2以上で暗号化されます。保存データはAES-256による暗号化を行います。

# SSO
SAML方式のSSOはEnterpriseプランで利用できます。StandardプランのSSOは非対応です。

# IPアドレス制限
StandardプランではIPアドレス制限を利用できます。管理担当者が許可するIPアドレスを登録します。
"""),
    ("FlowDesk 顧客説明FAQ", "2026.09 / v1.3", """# サポート窓口
Standardプランのサポートは、平日10時〜18時のメール対応です。土日祝日・年末年始は対象外で、電話サポートは提供していません。

# 導入後の操作説明
導入後の操作説明はオンラインで1回、60分まで料金に含まれます。追加の説明会は別途見積もりになります。

# データのエクスポート
案件・顧客データはCSV形式でエクスポートできます。添付ファイルは個別ダウンロードが必要です。
"""),
    ("FlowDesk IP制限の補足資料", "2026.08 / 確認用", """# IPアドレス制限
StandardプランのIPアドレス制限は非対応です。Enterpriseプランへの変更が必要です。

# 検証用の注意
この架空資料は、資料間の相違を表示する試験用です。セキュリティ資料のIP制限と記載を意図的に変えています。実際の製品条件ではありません。
"""),
]


class Command(BaseCommand):
    help = "ローカル検証用の架空資料・商談と demo / sokuto-demo を作成（繰り返し実行可）"

    @transaction.atomic
    def handle(self, *args, **options):
        if not settings.DEBUG or not settings.DEMO_LOGIN_ENABLED:
            raise CommandError("seed_demoはDEBUGとDEMO_LOGIN_ENABLEDが有効なローカル開発でのみ利用できます。")
        User = get_user_model()
        existing = User.objects.filter(username="demo").first()
        if existing:
            self.stdout.write("demoアカウントは登録済みです。既存の資料・商談を保持しました。")
            return
        team = Team.objects.create(name="ソクトウAI 検証チーム")
        user = User.objects.create_user(username="demo", password="sokuto-demo", first_name="営業担当")
        Membership.objects.create(user=user, team=team, role="admin")
        for name, version, contents in DOCUMENTS:
            ingest_document(team=team, name=name, version=version, source_type="md", contents=contents.encode("utf-8"), is_sample=True)
        meeting = Meeting.objects.create(team=team, owner=user, title="青葉商事様 · サービス導入のご相談（模擬）", mode="online", status="ended")
        Meeting.objects.filter(pk=meeting.pk).update(created_at=timezone.now() - timedelta(days=1))
        examples = [
            ("Standardプランの料金はいくらですか？", "answered"),
            ("導入までどのくらいかかりますか？", "answered"),
            ("データの保存地域はどこですか？", "follow_up"),
        ]
        for index, (text, outcome) in enumerate(examples):
            transcript = Transcript.objects.create(meeting=meeting, text=text)
            question = Question.objects.create(meeting=meeting, transcript=transcript, text=text, source="demo", status="ready", outcome=outcome)
            sources, missing = search(text, team.id)
            result = local_answer(text, sources, missing)
            question.answer = result["answer"]
            question.conditions = result["conditions"]
            question.missing_points = result["missing_points"]
            question.evidence_state = result["evidence_state"]
            question.save()
            selected = {s["id"]: s for s in sources}
            for i, source_id in enumerate(result["source_ids"]):
                source = selected[source_id]
                Citation.objects.create(question=question, document_id=source["document_id"], document_name=source["document_name"], quote=source["quote"], context=source["context"], location=source["location"], version=source["version"], is_sample=True, position=i)
        Meeting.objects.create(team=team, owner=user, title="北野デザイン様 · ヒアリング（模擬）", mode="in_person", status="ended")
        self.stdout.write(self.style.SUCCESS("架空資料6件・模擬商談2件を登録しました。ログイン: demo / sokuto-demo（ローカル専用）"))
