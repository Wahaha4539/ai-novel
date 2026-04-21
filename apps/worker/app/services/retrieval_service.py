from dataclasses import asdict

from app.models.dto import RetrievalHit
from app.models.enums import MemoryStatus
from app.repositories.lorebook_repo import LorebookRepository
from app.repositories.memory_repo import MemoryRepository
from app.services.cache_service import CacheService


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
        return {
            "lorebookHits": self._deserialize_hits(payload.get("lorebookHits", [])),
            "memoryHits": self._deserialize_hits(payload.get("memoryHits", [])),
            "rankedHits": self._deserialize_hits(payload.get("rankedHits", [])),
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
