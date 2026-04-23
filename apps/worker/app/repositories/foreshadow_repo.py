"""Repository for ForeshadowTrack operations during chapter generation.
Supports:
  - Safe replace (only deletes auto_extracted, protects guided/manual)
  - Planned foreshadow retrieval for prompt injection
"""
import uuid

from sqlalchemy import delete, or_, select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ForeshadowTrackModel


class ForeshadowRepository:
    """Manages foreshadow tracks for the generation pipeline."""

    def replace_for_chapter(
        self,
        project_id: str,
        chapter_id: str,
        chapter_no: int | None,
        source_draft_id: str | None,
        foreshadows: list[dict],
    ) -> dict:
        """Replace auto-extracted foreshadow tracks for a chapter.
        IMPORTANT: Only deletes records with source='auto_extracted' to protect
        guided wizard's manually-planned foreshadows (source='guided' or 'manual').
        """
        project_uuid = uuid.UUID(project_id)
        chapter_uuid = uuid.UUID(chapter_id)
        draft_uuid = uuid.UUID(source_draft_id) if source_draft_id else None
        created: list[dict] = []
        with SessionLocal.begin() as session:
            # Only delete auto-extracted records, preserving guided/manual ones
            deleted = session.execute(
                delete(ForeshadowTrackModel).where(
                    ForeshadowTrackModel.project_id == project_uuid,
                    ForeshadowTrackModel.chapter_id == chapter_uuid,
                    ForeshadowTrackModel.source == "auto_extracted",
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
                    scope=foreshadow.get("scope", "chapter"),
                    source="auto_extracted",
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

    def list_planned_for_chapter(
        self,
        project_id: str,
        chapter_no: int,
    ) -> list[dict]:
        """Retrieve guided-planned foreshadow tracks relevant to a specific chapter.
        A foreshadow is relevant if:
          - Its metadata.plantChapter matches this chapter (needs to be planted)
          - Its metadata.revealChapter matches this chapter (needs to be revealed/paid off)
          - Its firstSeenChapterNo or lastSeenChapterNo bracket this chapter
        Only returns source='guided' records (from the guided wizard's foreshadow step).
        """
        project_uuid = uuid.UUID(project_id)
        with SessionLocal() as session:
            # Fetch all guided foreshadows for the project
            rows = session.execute(
                select(ForeshadowTrackModel).where(
                    ForeshadowTrackModel.project_id == project_uuid,
                    ForeshadowTrackModel.source == "guided",
                )
            ).scalars().all()

            result: list[dict] = []
            for row in rows:
                meta = row.metadata_json or {}
                plant_chapter = meta.get("plantChapter")
                reveal_chapter = meta.get("revealChapter")
                # Determine relevance: planted here, revealed here, or within active range
                is_plant = plant_chapter == chapter_no
                is_reveal = reveal_chapter == chapter_no
                in_range = (
                    row.first_seen_chapter_no is not None
                    and row.first_seen_chapter_no <= chapter_no
                    and (row.last_seen_chapter_no is None or row.last_seen_chapter_no >= chapter_no)
                )

                if is_plant or is_reveal or in_range:
                    role = "plant" if is_plant else ("reveal" if is_reveal else "active")
                    result.append({
                        "title": row.title,
                        "detail": row.detail,
                        "role": role,
                        "technique": meta.get("technique"),
                        "payoff": meta.get("payoff"),
                        "involvedCharacters": meta.get("involvedCharacters", []),
                        "plantChapter": plant_chapter,
                        "revealChapter": reveal_chapter,
                    })

            return result