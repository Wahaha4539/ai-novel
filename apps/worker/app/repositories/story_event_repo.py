import uuid

from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import StoryEventModel


class StoryEventRepository:
    def replace_for_chapter(
        self,
        project_id: str,
        chapter_id: str,
        chapter_no: int | None,
        source_draft_id: str | None,
        events: list[dict],
    ) -> dict:
        project_uuid = uuid.UUID(project_id)
        chapter_uuid = uuid.UUID(chapter_id)
        draft_uuid = uuid.UUID(source_draft_id) if source_draft_id else None
        created: list[dict] = []
        with SessionLocal.begin() as session:
            deleted = session.execute(
                delete(StoryEventModel).where(
                    StoryEventModel.project_id == project_uuid,
                    StoryEventModel.chapter_id == chapter_uuid,
                )
            ).rowcount or 0

            for event in events:
                row = StoryEventModel(
                    project_id=project_uuid,
                    chapter_id=chapter_uuid,
                    chapter_no=chapter_no,
                    source_draft_id=draft_uuid,
                    title=event["title"],
                    event_type=event.get("eventType", "event"),
                    description=event["description"],
                    participants=event.get("participants", []),
                    timeline_seq=event.get("timelineSeq"),
                    status=event.get("status", "detected"),
                    metadata_json=event.get("metadata", {}),
                )
                session.add(row)
                session.flush()
                created.append(
                    {
                        "id": str(row.id),
                        "title": row.title,
                        "eventType": row.event_type,
                        "status": row.status,
                    }
                )

        return {"deleted": deleted, "created": created}

    def list_before_chapter(self, project_id: str, chapter_no: int, limit: int = 30) -> list[dict]:
        """
        Load story events from all chapters before the given chapter_no.

        Returns the most recent `limit` events ordered chronologically.
        Used for cross-chapter continuity validation.
        """
        from sqlalchemy import select as sa_select
        project_uuid = uuid.UUID(project_id)
        with SessionLocal() as session:
            rows = session.execute(
                sa_select(StoryEventModel)
                .where(
                    StoryEventModel.project_id == project_uuid,
                    StoryEventModel.chapter_no < chapter_no,
                )
                .order_by(StoryEventModel.chapter_no.desc())
                .limit(limit)
            ).scalars().all()

            return [
                {
                    "title": row.title,
                    "chapterNo": row.chapter_no,
                    "eventType": row.event_type,
                    "description": row.description,
                    "participants": row.participants or [],
                }
                for row in reversed(rows)  # Chronological order
            ]