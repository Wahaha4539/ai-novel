"""Repository for Character lookups during chapter generation.
Supports scope-aware filtering so the pipeline only sees characters
relevant to the current volume (global + volume-specific).
"""
import uuid

from sqlalchemy import asc, or_, select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import CharacterModel


class CharacterRepository:
    """Reads character info for prompt building with scope-aware filtering."""

    def list_related(self, project_id: str, volume_no: int | None = None) -> list[dict]:
        """List characters relevant to the given volume.
        When volume_no is provided, returns:
          - scope='global' characters (main cast)
          - scope='volume_{volume_no}' characters (volume-specific supporting cast)
          - scope IS NULL characters (legacy/unscoped)
        When volume_no is None, returns all characters (up to 30).
        """
        with SessionLocal() as session:
            stmt = (
                select(CharacterModel)
                .where(CharacterModel.project_id == uuid.UUID(project_id))
            )

            # Filter by scope when volume context is available
            if volume_no is not None:
                volume_scope = f"volume_{volume_no}"
                stmt = stmt.where(
                    or_(
                        CharacterModel.scope == "global",
                        CharacterModel.scope == volume_scope,
                        CharacterModel.scope.is_(None),
                    )
                )

            rows = session.execute(
                stmt.order_by(asc(CharacterModel.created_at)).limit(30)
            ).scalars().all()

            return [
                {
                    "id": str(row.id),
                    "name": row.name,
                    "roleType": row.role_type,
                    "speechStyle": row.speech_style,
                    # Rich character details for prompt building
                    "personalityCore": row.personality_core,
                    "motivation": row.motivation,
                    "backstory": row.backstory,
                    "scope": row.scope,
                }
                for row in rows
            ]
