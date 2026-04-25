import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import (
    ChapterModel,
    CharacterModel,
    CharacterStateSnapshotModel,
    ForeshadowTrackModel,
    StoryEventModel,
)


class FactValidationRepository:
    """Read-only fact snapshots used by deterministic validation rules."""

    def load_scope(self, project_id: str, chapter_id: str | None = None) -> dict[str, list[dict]]:
        """Load chapters, extracted facts, and dead characters for validation.

        Args:
            project_id: Project UUID.
            chapter_id: Optional chapter UUID; when present only that chapter's
                extracted facts are validated, matching the existing API route.

        Returns:
            Dictionary of serializable row dictionaries grouped by fact type.
        """
        project_uuid = uuid.UUID(project_id)
        chapter_uuid = uuid.UUID(chapter_id) if chapter_id else None

        with SessionLocal() as session:
            chapter_stmt = select(ChapterModel).where(ChapterModel.project_id == project_uuid)
            event_stmt = select(StoryEventModel).where(StoryEventModel.project_id == project_uuid)
            state_stmt = select(CharacterStateSnapshotModel).where(
                CharacterStateSnapshotModel.project_id == project_uuid
            )
            foreshadow_stmt = select(ForeshadowTrackModel).where(ForeshadowTrackModel.project_id == project_uuid)

            if chapter_uuid:
                chapter_stmt = chapter_stmt.where(ChapterModel.id == chapter_uuid)
                event_stmt = event_stmt.where(StoryEventModel.chapter_id == chapter_uuid)
                state_stmt = state_stmt.where(CharacterStateSnapshotModel.chapter_id == chapter_uuid)
                foreshadow_stmt = foreshadow_stmt.where(ForeshadowTrackModel.chapter_id == chapter_uuid)

            chapters = session.execute(chapter_stmt.order_by(ChapterModel.chapter_no.asc())).scalars().all()
            events = session.execute(
                event_stmt.order_by(
                    StoryEventModel.chapter_no.asc(),
                    StoryEventModel.timeline_seq.asc(),
                    StoryEventModel.created_at.asc(),
                )
            ).scalars().all()
            states = session.execute(
                state_stmt.order_by(CharacterStateSnapshotModel.chapter_no.asc(), CharacterStateSnapshotModel.created_at.asc())
            ).scalars().all()
            foreshadows = session.execute(
                foreshadow_stmt.order_by(ForeshadowTrackModel.chapter_no.asc(), ForeshadowTrackModel.created_at.asc())
            ).scalars().all()
            dead_characters = session.execute(
                select(CharacterModel).where(CharacterModel.project_id == project_uuid, CharacterModel.is_dead.is_(True))
            ).scalars().all()

            return {
                "chapters": [
                    {
                        "id": str(row.id),
                        "chapterNo": row.chapter_no,
                        "title": row.title,
                        "timelineSeq": row.timeline_seq,
                    }
                    for row in chapters
                ],
                "storyEvents": [
                    {
                        "id": str(row.id),
                        "chapterId": str(row.chapter_id),
                        "chapterNo": row.chapter_no,
                        "title": row.title,
                        "participants": row.participants or [],
                        "timelineSeq": row.timeline_seq,
                    }
                    for row in events
                ],
                "characterStates": [
                    {
                        "id": str(row.id),
                        "chapterId": str(row.chapter_id),
                        "chapterNo": row.chapter_no,
                        "characterName": row.character_name,
                        "stateType": row.state_type,
                        "stateValue": row.state_value,
                        "status": row.status,
                    }
                    for row in states
                ],
                "foreshadowTracks": [
                    {
                        "id": str(row.id),
                        "chapterId": str(row.chapter_id) if row.chapter_id else None,
                        "chapterNo": row.chapter_no,
                        "title": row.title,
                        "firstSeenChapterNo": row.first_seen_chapter_no,
                        "lastSeenChapterNo": row.last_seen_chapter_no,
                    }
                    for row in foreshadows
                ],
                "deadCharacters": [{"id": str(row.id), "name": row.name} for row in dead_characters],
            }