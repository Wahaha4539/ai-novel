import uuid

from sqlalchemy import asc, select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import CharacterModel


class CharacterRepository:
    def list_related(self, project_id: str) -> list[dict]:
        with SessionLocal() as session:
            rows = session.execute(
                select(CharacterModel)
                .where(CharacterModel.project_id == uuid.UUID(project_id))
                .order_by(asc(CharacterModel.created_at))
                .limit(20)
            ).scalars().all()

            return [
                {
                    "id": str(row.id),
                    "name": row.name,
                    "roleType": row.role_type,
                    "speechStyle": row.speech_style,
                }
                for row in rows
            ]
