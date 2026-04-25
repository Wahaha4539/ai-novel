import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import CharacterStateSnapshotModel, ForeshadowTrackModel, MemoryChunkModel


class MemoryReviewRepository:
    """Worker-side persistence for pending memory review decisions."""

    def list_pending(self, project_id: str, chapter_id: str | None = None) -> list[dict]:
        """Load pending_review memory chunks for optional chapter scope."""
        project_uuid = uuid.UUID(project_id)
        with SessionLocal() as session:
            stmt = select(MemoryChunkModel).where(
                MemoryChunkModel.project_id == project_uuid,
                MemoryChunkModel.status == "pending_review",
            )
            if chapter_id:
                stmt = stmt.where(MemoryChunkModel.source_type == "chapter", MemoryChunkModel.source_id == uuid.UUID(chapter_id))

            rows = session.execute(stmt.order_by(MemoryChunkModel.created_at.desc()).limit(100)).scalars().all()
            return [
                {
                    "id": str(row.id),
                    "memoryType": row.memory_type,
                    "summary": row.summary,
                    "content": row.content,
                    "sourceTrace": row.source_trace or {},
                    "metadata": row.metadata_json or {},
                }
                for row in rows
            ]

    def apply_decision(self, project_id: str, memory_id: str, next_status: str) -> dict[str, int]:
        """Update memory review status and propagate it to derived fact rows."""
        project_uuid = uuid.UUID(project_id)
        memory_uuid = uuid.UUID(memory_id)
        with SessionLocal.begin() as session:
            memory = session.execute(
                select(MemoryChunkModel).where(MemoryChunkModel.project_id == project_uuid, MemoryChunkModel.id == memory_uuid)
            ).scalar_one_or_none()
            if not memory:
                return {"characterStateSnapshotCount": 0, "foreshadowTrackCount": 0}

            session.execute(
                update(MemoryChunkModel)
                .where(MemoryChunkModel.id == memory_uuid)
                .values(status=next_status, updated_at=datetime.now(UTC))
            )

            source_trace = memory.source_trace or {}
            metadata = memory.metadata_json or {}
            chapter_id = source_trace.get("chapterId") if isinstance(source_trace.get("chapterId"), str) else None
            kind = source_trace.get("kind") if isinstance(source_trace.get("kind"), str) else None
            character_count = 0
            foreshadow_count = 0

            if chapter_id and kind == "character_state":
                character_name = metadata.get("character") if isinstance(metadata.get("character"), str) else None
                state_type = metadata.get("stateType") if isinstance(metadata.get("stateType"), str) else None
                state_value = self._parse_state_value(memory.content)
                stmt = (
                    update(CharacterStateSnapshotModel)
                    .where(
                        CharacterStateSnapshotModel.project_id == project_uuid,
                        CharacterStateSnapshotModel.chapter_id == uuid.UUID(chapter_id),
                    )
                    .values(status=next_status, updated_at=datetime.now(UTC))
                )
                if character_name:
                    stmt = stmt.where(CharacterStateSnapshotModel.character_name == character_name)
                if state_type:
                    stmt = stmt.where(CharacterStateSnapshotModel.state_type == state_type)
                if state_value:
                    stmt = stmt.where(CharacterStateSnapshotModel.state_value == state_value)
                character_count = int(session.execute(stmt).rowcount or 0)

            if chapter_id and kind == "foreshadow":
                title = memory.summary or memory.content
                result = session.execute(
                    update(ForeshadowTrackModel)
                    .where(
                        ForeshadowTrackModel.project_id == project_uuid,
                        ForeshadowTrackModel.chapter_id == uuid.UUID(chapter_id),
                        ForeshadowTrackModel.title == title,
                    )
                    .values(status=next_status, updated_at=datetime.now(UTC))
                )
                foreshadow_count = int(result.rowcount or 0)

            return {"characterStateSnapshotCount": character_count, "foreshadowTrackCount": foreshadow_count}

    @staticmethod
    def _parse_state_value(content: str) -> str | None:
        """Extract state value from '角色：状态' style memory content."""
        for separator in ("：", ":"):
            if separator in content:
                return content.split(separator, 1)[1].strip() or None
        return None