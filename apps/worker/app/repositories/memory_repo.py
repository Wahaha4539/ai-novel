import uuid

from sqlalchemy import desc, or_, select

from app.db.session import SessionLocal
from app.models.dto import RetrievalHit
from app.models.sqlalchemy_models import MemoryChunkModel


class MemoryRepository:
    def search(self, project_id: str, query_text: str) -> list[RetrievalHit]:
        with SessionLocal() as session:
            stmt = select(MemoryChunkModel).where(MemoryChunkModel.project_id == uuid.UUID(project_id))
            if query_text:
                pattern = f"%{query_text}%"
                stmt = stmt.where(
                    or_(
                        MemoryChunkModel.content.ilike(pattern),
                        MemoryChunkModel.summary.ilike(pattern),
                    )
                )

            rows = session.execute(
                stmt.order_by(desc(MemoryChunkModel.importance_score), desc(MemoryChunkModel.created_at)).limit(10)
            ).scalars().all()

            return [
                RetrievalHit(
                    source_type=row.source_type,
                    source_id=str(row.source_id),
                    title=row.summary or row.memory_type,
                    content=row.content,
                    score=0.75,
                    metadata={"memoryType": row.memory_type, **(row.metadata_json or {})},
                )
                for row in rows
            ]

    def create_many(self, project_id: str, chunks: list[dict]) -> list[dict]:
        project_uuid = uuid.UUID(project_id)
        created: list[dict] = []
        with SessionLocal.begin() as session:
            for chunk in chunks:
                row = MemoryChunkModel(
                    project_id=project_uuid,
                    source_type=chunk["sourceType"],
                    source_id=uuid.UUID(chunk["sourceId"]),
                    memory_type=chunk["memoryType"],
                    content=chunk["content"],
                    summary=chunk.get("summary"),
                    tags=chunk.get("tags", []),
                    metadata_json=chunk.get("metadata", {}),
                    importance_score=chunk.get("importanceScore", 50),
                    recency_score=chunk.get("recencyScore", 50),
                    embedding=chunk.get("embedding"),
                )
                session.add(row)
                session.flush()
                created.append({"id": str(row.id), "memoryType": row.memory_type, "content": row.content})

        return created
