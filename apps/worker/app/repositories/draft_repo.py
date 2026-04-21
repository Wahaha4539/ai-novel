import uuid

from sqlalchemy import func, select, update

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ChapterDraftModel


class DraftRepository:
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
