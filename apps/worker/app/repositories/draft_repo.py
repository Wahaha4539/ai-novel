import uuid

from sqlalchemy import func, select, update

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ChapterDraftModel, ChapterModel


class DraftRepository:
    @staticmethod
    def _serialize_chapter(row: ChapterModel) -> dict:
        return {
            "id": str(row.id),
            "projectId": str(row.project_id),
            "chapterNo": row.chapter_no,
            "title": row.title,
            "objective": row.objective,
            "conflict": row.conflict,
            "revealPoints": row.reveal_points,
            "foreshadowPlan": row.foreshadow_plan,
            "outline": row.outline,
            "expectedWordCount": row.expected_word_count,
            "actualWordCount": row.actual_word_count,
            "status": row.status,
            "timelineSeq": row.timeline_seq,
        }

    @staticmethod
    def _serialize_draft(row: ChapterDraftModel) -> dict:
        return {
            "id": str(row.id),
            "chapterId": str(row.chapter_id),
            "versionNo": row.version_no,
            "content": row.content,
            "source": row.source,
            "modelInfo": row.model_info,
            "generationContext": row.generation_context,
            "isCurrent": row.is_current,
            "createdAt": row.created_at.isoformat() if row.created_at else None,
        }

    def create_chapter_draft(self, chapter_id: str, content: str, model_info: dict, generation_context: dict) -> dict:
        chapter_uuid = uuid.UUID(chapter_id)
        with SessionLocal.begin() as session:
            current_version = session.scalar(
                select(func.max(ChapterDraftModel.version_no)).where(ChapterDraftModel.chapter_id == chapter_uuid)
            )
            version_no = (current_version or 0) + 1
            session.execute(
                update(ChapterDraftModel)
                .where(ChapterDraftModel.chapter_id == chapter_uuid)
                .values(is_current=False)
            )
            row = ChapterDraftModel(
                chapter_id=chapter_uuid,
                version_no=version_no,
                content=content,
                source="ai",
                model_info=model_info,
                generation_context=generation_context,
                is_current=True,
            )
            session.add(row)
            session.flush()

            return {
                "id": str(row.id),
                "chapterId": chapter_id,
                "versionNo": version_no,
                "content": content,
                "source": "ai",
                "modelInfo": model_info,
                "generationContext": generation_context,
            }

    def list_current_project_drafts(self, project_id: str, chapter_id: str | None = None) -> list[dict]:
        project_uuid = uuid.UUID(project_id)
        with SessionLocal() as session:
            stmt = (
                select(ChapterDraftModel, ChapterModel)
                .join(ChapterModel, ChapterDraftModel.chapter_id == ChapterModel.id)
                .where(
                    ChapterModel.project_id == project_uuid,
                    ChapterDraftModel.is_current.is_(True),
                )
                .order_by(ChapterModel.chapter_no.asc())
            )
            if chapter_id:
                stmt = stmt.where(ChapterModel.id == uuid.UUID(chapter_id))

            rows = session.execute(stmt).all()
            return [
                {
                    "chapter": self._serialize_chapter(chapter),
                    "draft": self._serialize_draft(draft),
                }
                for draft, chapter in rows
            ]
