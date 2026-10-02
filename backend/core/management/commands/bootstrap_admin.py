import os

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Membership, Team


class Command(BaseCommand):
    help = "Create the initial production admin account."

    @transaction.atomic
    def handle(self, *args, **options):
        username = os.getenv("BOOTSTRAP_ADMIN_USERNAME", "").strip()
        password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
        display_name = os.getenv(
            "BOOTSTRAP_ADMIN_DISPLAY_NAME",
            username,
        ).strip()
        team_name = os.getenv(
            "BOOTSTRAP_TEAM_NAME",
            "ソクトウAI チーム",
        ).strip()

        if not username:
            raise CommandError("BOOTSTRAP_ADMIN_USERNAME is required.")

        User = get_user_model()

        existing = User.objects.filter(username=username).first()

        if existing:
            membership = Membership.objects.filter(user=existing).first()

            if membership:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Admin already exists: {username}"
                    )
                )
                return

            team = (
                Team.objects.filter(name=team_name).first()
                or Team.objects.create(name=team_name)
            )

            Membership.objects.create(
                user=existing,
                team=team,
                role="admin",
            )

            self.stdout.write(
                self.style.SUCCESS(
                    f"Added admin membership: {username}"
                )
            )
            return

        if not password:
            raise CommandError("BOOTSTRAP_ADMIN_PASSWORD is required.")

        candidate = User(
            username=username,
            first_name=display_name or username,
        )

        try:
            validate_password(password, candidate)
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages))

        team = (
            Team.objects.filter(name=team_name).first()
            or Team.objects.create(name=team_name)
        )

        user = User.objects.create_user(
            username=username,
            password=password,
            first_name=display_name or username,
        )

        Membership.objects.create(
            user=user,
            team=team,
            role="admin",
        )

        self.stdout.write(
            self.style.SUCCESS(
                f"Created production admin: {username}"
            )
        )