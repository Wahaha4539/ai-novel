import uuid

from app.db.session import SessionLocal
from app.models.schemas import ValidationIssue
from app.models.sqlalchemy_models import ValidationIssueModel


class ValidationRepository:
    def save_many(self, project_id: str, chapter_id: str, issues: list[ValidationIssue]) -> list[ValidationIssue]:
        if not issues:
            return issues

        with SessionLocal.begin() as session:
            for issue in issues:
                session.add(
                    ValidationIssueModel(
                        project_id=uuid.UUID(project_id),
                        chapter_id=uuid.UUID(chapter_id),
                        issue_type=issue.issue_type,
                        severity=issue.severity.value,
                        message=issue.message,
                        evidence=issue.evidence,
                        suggestion=issue.suggestion,
                    )
                )
        return issues
