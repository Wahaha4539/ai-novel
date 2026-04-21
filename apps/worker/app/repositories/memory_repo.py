import uuid

from sqlalchemy import delete, desc, or_, select

from app.db.session import SessionLocal
from app.models.dto import RetrievalHit
from app.models.sqlalchemy_models import MemoryChunkModel


class MemoryRepository:
    def search(self, project_id: str, query_text: str, allowed_statuses: list[str] | None = None) -> list[RetrievalHit]:
        with SessionLocal() as session:
            stmt = select(MemoryChunkModel).where(MemoryChunkModel.project_id == uuid.UUID(project_id))
            if allowed_statuses:
                stmt = stmt.where(MemoryChunkModel.status.in_(allowed_statuses))
            if query_text:
                pattern = f"%{query_text}%"
                stmt = stmt.where(
                    or_(
                        MemoryChunkModel.content.ilike(pattern),
                        MemoryChunkModel.summary.ilike(pattern),
                    )
                )

            rows = session.execute(
                stmt.order_by(
                    desc(MemoryChunkModel.importance_score),
                    desc(MemoryChunkModel.freshness_score),
                    desc(MemoryChunkModel.created_at),
                ).limit(10)
            ).scalars().all()

            return [
                RetrievalHit(
                    source_type=row.source_type,
                    source_id=str(row.source_id),
                    title=row.summary or row.memory_type,
                    content=row.content,
                    score=0.75,
                    metadata={
                        "memoryType": row.memory_type,
                        "status": row.status,
                        "sourceTrace": row.source_trace or {},
                        **(row.metadata_json or {}),
                    },
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
                    source_trace=chunk.get("sourceTrace", {}),
                    metadata_json=chunk.get("metadata", {}),
                    importance_score=chunk.get("importanceScore", 50),
                    freshness_score=chunk.get("freshnessScore", 50),
                    recency_score=chunk.get("recencyScore", 50),
                    status=chunk.get("status", "auto"),
                    embedding=chunk.get("embedding"),
                )
                session.add(row)
                session.flush()
                created.append(
                    {
                        "id": str(row.id),
                        "memoryType": row.memory_type,
                        "content": row.content,
                        "status": row.status,
                    }
                )

        return created

    def replace_for_source(self, project_id: str, source_type: str, source_id: str, chunks: list[dict]) -> dict:
        project_uuid = uuid.UUID(project_id)
        source_uuid = uuid.UUID(source_id)
        deleted = 0
        with SessionLocal.begin() as session:
            deleted = session.execute(
                delete(MemoryChunkModel).where(
                    MemoryChunkModel.project_id == project_uuid,
                    MemoryChunkModel.source_type == source_type,
                    MemoryChunkModel.source_id == source_uuid,
                )
            ).rowcount or 0

        created = self.create_many(project_id, chunks) if chunks else []
        return {
            "deleted": deleted,
            "created": created,
        }
