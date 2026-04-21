import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ProjectModel


class ProjectRepository:
    def get(self, project_id: str) -> dict:
        with SessionLocal() as session:
            row = session.scalar(select(ProjectModel).where(ProjectModel.id == uuid.UUID(project_id)))
            if row is None:
                raise ValueError(f"项目不存在：{project_id}")

            return {
                "id": str(row.id),
                "title": row.title,
                "genre": row.genre,
                "theme": row.theme,
                "tone": row.tone,
                "synopsis": row.synopsis,
            }
