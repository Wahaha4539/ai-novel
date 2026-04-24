from dataclasses import asdict

from app.core.logging import get_logger, log_event
from app.models.dto import RetrievalHit
from app.models.enums import MemoryStatus
from app.repositories.lorebook_repo import LorebookRepository
from app.repositories.memory_repo import MemoryRepository
from app.services.cache_service import CacheService


logger = get_logger(__name__)


class RetrievalService:
    def __init__(self) -> None:
        self.memory_repo = MemoryRepository()
        self.lorebook_repo = LorebookRepository()
        self.cache_service = CacheService()

    @staticmethod
    def _serialize_hits(hits: list[RetrievalHit]) -> list[dict]:
        return [asdict(hit) for hit in hits]

    @staticmethod
    def _deserialize_hits(items: list[dict]) -> list[RetrievalHit]:
        return [RetrievalHit(**item) for item in items]

    @staticmethod
    def _format_hit_for_log(hit: RetrievalHit) -> dict:
        """把召回命中项整理成完整日志结构，方便直接检查召回质量。

        输入:
            hit: 单条召回结果。
        输出:
            可 JSON 序列化的命中项字段，包含完整 content。
        副作用:
            无。
        """
        return {
            "sourceType": hit.source_type,
            "sourceId": hit.source_id,
            "title": hit.title,
            "score": hit.score,
            "metadata": hit.metadata,
            "content": hit.content,
        }

    def _log_recall_bundle(
        self,
        project_id: str,
        context: dict,
        *,
        include_lorebook: bool,
        include_memory: bool,
        lorebook_hits: list[RetrievalHit],
        memory_hits: list[RetrievalHit],
        ranked_hits: list[RetrievalHit],
    ) -> None:
        """打印本次召回输入和完整命中内容，便于人工观察召回效果。

        输入:
            project_id: 项目 ID。
            context: 召回上下文，通常包含 queryText/objective。
            include_lorebook/include_memory: 本次召回是否启用对应来源。
            lorebook_hits/memory_hits/ranked_hits: 原始与排序压缩后的召回结果。
        输出:
            None。
        副作用:
            向 worker 日志写入完整召回内容；内容可能较长，排查完成后可按需关闭。
        """
        # 这里故意不截断 content：用户需要查看“找回的效果”，完整文本比摘要更有诊断价值。
        log_event(
            logger,
            "retrieval.bundle",
            projectId=project_id,
            queryText=context.get("queryText"),
            objective=context.get("objective"),
            includeLorebook=include_lorebook,
            includeMemory=include_memory,
            counts={
                "lorebook": len(lorebook_hits),
                "memory": len(memory_hits),
                "ranked": len(ranked_hits),
            },
            lorebookHits=[self._format_hit_for_log(hit) for hit in lorebook_hits],
            memoryHits=[self._format_hit_for_log(hit) for hit in memory_hits],
            rankedHits=[self._format_hit_for_log(hit) for hit in ranked_hits],
        )

    def retrieve_lorebook(self, project_id: str, context: dict) -> list[RetrievalHit]:
        rows = self.lorebook_repo.search(project_id, context.get("queryText") or context.get("objective") or "")
        return [
            RetrievalHit(
                source_type="lorebook",
                source_id=row["id"],
                title=row["title"],
                content=row["summary"] or row["content"],
                score=0.9,
                metadata={"entryType": row["entryType"]},
            )
            for row in rows
        ]

    def retrieve_memory(self, project_id: str, context: dict) -> list[RetrievalHit]:
        query_text = context.get("queryText") or context.get("objective") or "章节生成"
        return self.memory_repo.search(
            project_id,
            query_text,
            allowed_statuses=[MemoryStatus.AUTO.value, MemoryStatus.USER_CONFIRMED.value],
        )

    def rerank_and_compress(self, lorebook_hits: list[RetrievalHit], memory_hits: list[RetrievalHit]) -> list[RetrievalHit]:
        merged = sorted([*lorebook_hits, *memory_hits], key=lambda item: item.score, reverse=True)
        return merged[:6]

    def retrieve_bundle(
        self,
        project_id: str,
        context: dict,
        *,
        include_lorebook: bool,
        include_memory: bool,
    ) -> dict[str, list[RetrievalHit]]:
        payload = self.cache_service.get_recall_result(
            project_id,
            context,
            include_lorebook=include_lorebook,
            include_memory=include_memory,
            loader=lambda: self._build_recall_bundle(project_id, context, include_lorebook, include_memory),
        )
        lorebook_hits = self._deserialize_hits(payload.get("lorebookHits", []))
        memory_hits = self._deserialize_hits(payload.get("memoryHits", []))
        ranked_hits = self._deserialize_hits(payload.get("rankedHits", []))

        # 缓存命中时不会进入 _build_recall_bundle，因此在统一出口也打印一次实际交给调用方的召回内容。
        self._log_recall_bundle(
            project_id,
            context,
            include_lorebook=include_lorebook,
            include_memory=include_memory,
            lorebook_hits=lorebook_hits,
            memory_hits=memory_hits,
            ranked_hits=ranked_hits,
        )
        return {
            "lorebookHits": lorebook_hits,
            "memoryHits": memory_hits,
            "rankedHits": ranked_hits,
        }

    def _build_recall_bundle(
        self,
        project_id: str,
        context: dict,
        include_lorebook: bool,
        include_memory: bool,
    ) -> dict[str, list[dict]]:
        lorebook_hits = self.retrieve_lorebook(project_id, context) if include_lorebook else []
        memory_hits = self.retrieve_memory(project_id, context) if include_memory else []
        ranked_hits = self.rerank_and_compress(lorebook_hits, memory_hits)
        return {
            "lorebookHits": self._serialize_hits(lorebook_hits),
            "memoryHits": self._serialize_hits(memory_hits),
            "rankedHits": self._serialize_hits(ranked_hits),
        }
