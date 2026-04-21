import uuid

from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ForeshadowTrackModel


class ForeshadowRepository:
    def replace_for_chapter(
        self,
        project_id: str,
        chapter_id: str,
        chapter_no: int | None,
        source_draft_id: str | None,
        foreshadows: list[dict],
    ) -> dict:
        project_uuid = uuid.UUID(project_id)
        chapter_uuid = uuid.UUID(chapter_id)
        draft_uuid = uuid.UUID(source_draft_id) if source_draft_id else None
        created: list[dict] = []
        with SessionLocal.begin() as session:
            deleted = session.execute(
                delete(ForeshadowTrackModel).where(
                    ForeshadowTrackModel.project_id == project_uuid,
                    ForeshadowTrackModel.chapter_id == chapter_uuid,
                )
            ).rowcount or 0

            for foreshadow in foreshadows:
                row = ForeshadowTrackModel(
                    project_id=project_uuid,
                    chapter_id=chapter_uuid,
                    chapter_no=chapter_no,
                    source_draft_id=draft_uuid,
                    title=foreshadow["title"],
                    detail=foreshadow.get("detail"),
                    status=foreshadow.get("status", "planned"),
                    first_seen_chapter_no=foreshadow.get("firstSeenChapterNo", chapter_no),
                    last_seen_chapter_no=foreshadow.get("lastSeenChapterNo", chapter_no),
                    metadata_json=foreshadow.get("metadata", {}),
                )
                session.add(row)
                session.flush()
                created.append(
                    {
                        "id": str(row.id),
                        "title": row.title,
                        "status": row.status,
                    }
                )

        return {"deleted": deleted, "created": created}