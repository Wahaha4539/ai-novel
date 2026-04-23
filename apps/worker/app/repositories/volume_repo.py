"""Repository for Volume lookups during chapter generation.
Provides volume context (title, synopsis, objective) for prompt building.
"""
import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ChapterModel, VolumeModel


class VolumeRepository:
    """Reads volume info for the generation pipeline."""

    def get_by_id(self, volume_id: str) -> dict | None:
        """Fetch a single volume by its ID."""
        with SessionLocal() as session:
            row = session.scalar(
                select(VolumeModel).where(VolumeModel.id == uuid.UUID(volume_id))
            )
            if row is None:
                return None
            return self._serialize(row)

    def get_by_chapter(self, project_id: str, chapter_id: str) -> dict | None:
        """Resolve the parent volume for a given chapter via Chapter.volumeId.
        Returns None if the chapter has no volume or the volume doesn't exist."""
        with SessionLocal() as session:
            chapter = session.scalar(
                select(ChapterModel).where(
                    ChapterModel.id == uuid.UUID(chapter_id),
                    ChapterModel.project_id == uuid.UUID(project_id),
                )
            )
            if chapter is None or chapter.volume_id is None:
                return None

            volume = session.scalar(
                select(VolumeModel).where(VolumeModel.id == chapter.volume_id)
            )
            if volume is None:
                return None
            return self._serialize(volume)

    @staticmethod
    def _serialize(row: VolumeModel) -> dict:
        return {
            "id": str(row.id),
            "projectId": str(row.project_id),
            "volumeNo": row.volume_no,
            "title": row.title,
            "synopsis": row.synopsis,
            "objective": row.objective,
            "chapterCount": row.chapter_count,
            "status": row.status,
        }
