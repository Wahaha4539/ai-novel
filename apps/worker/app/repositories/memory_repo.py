"""Repository for MemoryChunk — supports both vector and keyword search.

Uses pgvector cosine distance (<=> operator) when embedding is available,
falls back to ILIKE keyword matching when no embedding service is configured
or when the query embedding generation fails.
"""
import uuid

from sqlalchemy import delete, desc, func, or_, select, text as sa_text

from app.core.logging import get_logger
from app.db.session import SessionLocal
from app.models.dto import RetrievalHit
from app.models.sqlalchemy_models import MemoryChunkModel
from app.services.embedding_service import EmbeddingService

logger = get_logger(__name__)


class MemoryRepository:
    """MemoryChunk data access — vector search with keyword fallback."""

    def __init__(self) -> None:
        self.embedding_service = EmbeddingService()

    def search(self, project_id: str, query_text: str, allowed_statuses: list[str] | None = None) -> list[RetrievalHit]:
        """Search memory chunks using vector similarity.
        
        Always uses embedding + pgvector. If embedding service fails, the error
        will propagate up — no silent degradation to keyword search.
        """
        if not query_text:
            return []

        # 生成查询向量（失败会直接抛异常）
        query_vec = self.embedding_service.embed_text(query_text)
        logger.info("memory.search.vector", extra={"projectId": project_id, "query": query_text[:80], "vecDim": len(query_vec)})
        results = self._vector_search(project_id, query_vec, allowed_statuses)
        logger.info("memory.search.vector.done", extra={"hitCount": len(results), "topScore": results[0].score if results else 0})
        return results

    def _vector_search(
        self, project_id: str, query_vec: list[float], allowed_statuses: list[str] | None
    ) -> list[RetrievalHit]:
        """Semantic search using pgvector cosine distance."""
        with SessionLocal() as session:
            # 构建向量字符串（pgvector 要求格式 '[0.1, 0.2, ...]'）
            vec_str = "[" + ",".join(str(v) for v in query_vec) + "]"

            # jsonb 列需要先转 text 再转 vector（jsonb 不能直接 cast 成 vector）
            stmt = sa_text("""
                SELECT id, "sourceType", "sourceId", "memoryType", content, summary,
                       status, "sourceTrace", metadata, "importanceScore",
                       (CAST(CAST(embedding AS text) AS vector) <=> CAST(:vec AS vector)) AS distance
                FROM "MemoryChunk"
                WHERE "projectId" = :pid
                  AND embedding IS NOT NULL
                  {status_filter}
                ORDER BY distance ASC
                LIMIT 10
            """.format(
                status_filter="AND status = ANY(:statuses)" if allowed_statuses else ""
            ))

            params = {"pid": uuid.UUID(project_id), "vec": vec_str}
            if allowed_statuses:
                params["statuses"] = allowed_statuses

            rows = session.execute(stmt, params).fetchall()

            return [
                RetrievalHit(
                    source_type=row.sourceType,
                    source_id=str(row.sourceId),
                    title=row.summary or row.memoryType,
                    content=row.content,
                    # 将余弦距离转为相似度分数 (1 - distance)
                    score=round(max(0.0, 1.0 - (row.distance or 0.0)), 4),
                    metadata={
                        "memoryType": row.memoryType,
                        "status": row.status,
                        "searchMethod": "vector",
                    },
                )
                for row in rows
            ]

    def _keyword_search(
        self, project_id: str, query_text: str, allowed_statuses: list[str] | None
    ) -> list[RetrievalHit]:
        """Fallback keyword search using ILIKE (original behavior)."""
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
                        "searchMethod": "keyword",
                    },
                )
                for row in rows
            ]

    def create_many(self, project_id: str, chunks: list[dict], session=None) -> list[dict]:
        """Bulk-insert MemoryChunks, including embedding vectors if present.
        Accepts an optional session to participate in an external transaction."""
        project_uuid = uuid.UUID(project_id)
        created: list[dict] = []

        def _do_insert(sess):
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
                sess.add(row)
                sess.flush()
                created.append(
                    {
                        "id": str(row.id),
                        "memoryType": row.memory_type,
                        "content": row.content,
                        "status": row.status,
                        "hasEmbedding": row.embedding is not None,
                    }
                )

        # 如果调用方传入了 session，在同一事务中执行；否则开启新事务
        if session:
            _do_insert(session)
        else:
            with SessionLocal.begin() as sess:
                _do_insert(sess)

        return created

    def replace_for_source(self, project_id: str, source_type: str, source_id: str, chunks: list[dict]) -> dict:
        """Delete existing chunks for a source, then insert new ones.
        DELETE + INSERT 在同一个事务中执行，保证原子性。"""
        project_uuid = uuid.UUID(project_id)
        source_uuid = uuid.UUID(source_id)
        deleted = 0
        created: list[dict] = []
        with SessionLocal.begin() as session:
            # 先删除旧记录
            deleted = session.execute(
                delete(MemoryChunkModel).where(
                    MemoryChunkModel.project_id == project_uuid,
                    MemoryChunkModel.source_type == source_type,
                    MemoryChunkModel.source_id == source_uuid,
                )
            ).rowcount or 0

            # 在同一事务中插入新记录
            if chunks:
                created = self.create_many(project_id, chunks, session=session)

        return {
            "deleted": deleted,
            "created": created,
        }
