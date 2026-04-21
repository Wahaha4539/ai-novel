import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ChapterModel


class ChapterRepository:
    def get_snapshot(self, chapter_id: str, project_id: str) -> dict:
        with SessionLocal() as session:
            row = session.scalar(
                select(ChapterModel).where(
                    ChapterModel.id == uuid.UUID(chapter_id),
                    ChapterModel.project_id == uuid.UUID(project_id),
                )
            )
            if row is None:
                raise ValueError(f"章节不存在：{chapter_id}")

            return {
                "id": str(row.id),
                "projectId": str(row.project_id),
                "chapterNo": row.chapter_no,
                "title": row.title,
                "objective": row.objective,
                "conflict": row.conflict,
                "outline": row.outline,
                "expectedWordCount": row.expected_word_count,
                "status": row.status,
                "actualWordCount": row.actual_word_count,
            }

    def get(self, chapter_id: str, project_id: str, request_payload: dict) -> dict:
        chapter = self.get_snapshot(chapter_id, project_id)
        return {
            **chapter,
            "expectedWordCount": chapter.get("expectedWordCount") or request_payload.get("wordCount") or 3500,
        }
