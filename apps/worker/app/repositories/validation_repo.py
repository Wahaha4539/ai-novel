import uuid

from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models.schemas import ValidationIssue
from app.models.sqlalchemy_models import ValidationIssueModel


class ValidationRepository:
    """Persistence helpers for validation issues used by worker pipelines."""

    def save_many(self, project_id: str, chapter_id: str, issues: list[ValidationIssue]) -> list[ValidationIssue]:
        """Append validation-engine issues for a chapter.

        Args:
            project_id: Project UUID.
            chapter_id: Chapter UUID.
            issues: Issues emitted by the validation engine.

        Returns:
            The same issue list for convenient pipeline chaining.

        Side effects:
            Inserts open ValidationIssue rows when the list is non-empty.
        """
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

    def replace_fact_rule_issues(self, project_id: str, chapter_id: str, issues: list[dict]) -> dict[str, int]:
        """Replace deterministic fact-rule issues for one chapter.

        The API implementation deletes/recreates this issue family on every
        validation run. Keeping the worker behavior identical makes repeated
        background post-processing idempotent and prevents stale open issues
        from blocking the next chapter.
        """
        fact_rule_types = {
            "timeline_conflict",
            "dead_character_appearance",
            "foreshadow_first_seen_mismatch",
            "foreshadow_range_invalid",
        }
        with SessionLocal.begin() as session:
            deleted = session.execute(
                delete(ValidationIssueModel).where(
                    ValidationIssueModel.project_id == uuid.UUID(project_id),
                    ValidationIssueModel.chapter_id == uuid.UUID(chapter_id),
                    ValidationIssueModel.issue_type.in_(fact_rule_types),
                )
            )
            for issue in issues:
                session.add(
                    ValidationIssueModel(
                        project_id=uuid.UUID(project_id),
                        chapter_id=uuid.UUID(issue.get("chapterId") or chapter_id),
                        issue_type=issue["issueType"],
                        severity=issue["severity"],
                        entity_type=issue.get("entityType"),
                        entity_id=uuid.UUID(issue["entityId"]) if issue.get("entityId") else None,
                        message=issue["message"],
                        evidence=issue.get("evidence") or [],
                        suggestion=issue.get("suggestion"),
                    )
                )
        return {"deletedCount": int(deleted.rowcount or 0), "createdCount": len(issues)}

    def list_open_by_chapter(self, chapter_id: str) -> list[dict]:
        """Return unresolved validation issues for auto-fix decision making."""
        with SessionLocal() as session:
            rows = session.execute(
                select(ValidationIssueModel)
                .where(
                    ValidationIssueModel.chapter_id == uuid.UUID(chapter_id),
                    ValidationIssueModel.status == "open",
                )
                .order_by(ValidationIssueModel.created_at.desc())
            ).scalars().all()

            return [
                {
                    "id": str(row.id),
                    "issueType": row.issue_type,
                    "severity": row.severity,
                    "message": row.message,
                    "evidence": row.evidence or [],
                    "suggestion": row.suggestion,
                }
                for row in rows
            ]
