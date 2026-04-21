import uuid

from sqlalchemy import desc, or_, select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import LorebookEntryModel


class LorebookRepository:
    def search(self, project_id: str, query_text: str, limit: int = 5) -> list[dict]:
        project_uuid = uuid.UUID(project_id)
        with SessionLocal() as session:
            stmt = select(LorebookEntryModel).where(LorebookEntryModel.project_id == project_uuid)
            if query_text:
                pattern = f"%{query_text}%"
                stmt = stmt.where(
                    or_(
                        LorebookEntryModel.title.ilike(pattern),
                        LorebookEntryModel.content.ilike(pattern),
                    )
                )

            rows = session.execute(
                stmt.order_by(desc(LorebookEntryModel.updated_at)).limit(limit)
            ).scalars().all()

            return [
                {
                    "id": str(row.id),
                    "title": row.title,
                    "entryType": row.entry_type,
                    "content": row.content,
                    "summary": row.summary,
                }
                for row in rows
            ]
