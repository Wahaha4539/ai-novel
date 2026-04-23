"""Repository for StyleProfile lookups during chapter generation.
Provides writing style info (POV, tense, prose style, pacing) for prompt building.
"""
import uuid

from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import StyleProfileModel


class StyleProfileRepository:
    """Reads the project's default style profile for prompt injection."""

    def get_default(self, project_id: str) -> dict | None:
        """Return the first StyleProfile for the project (typically named '引导生成').
        Falls back to None if no profile exists, letting the pipeline use hardcoded defaults."""
        with SessionLocal() as session:
            row = session.scalar(
                select(StyleProfileModel)
                .where(StyleProfileModel.project_id == uuid.UUID(project_id))
                .order_by(StyleProfileModel.created_at.asc())
                .limit(1)
            )
            if row is None:
                return None
            return {
                "id": str(row.id),
                "name": row.name,
                "pov": row.pov,
                "tense": row.tense,
                "proseStyle": row.prose_style,
                "pacing": row.pacing,
                "dialogueDensity": row.dialogue_density,
                "narrationDensity": row.narration_density,
                "descriptionDensity": row.description_density,
                "darknessLevel": row.darkness_level,
                "humorLevel": row.humor_level,
                "emotionalIntensity": row.emotional_intensity,
            }
