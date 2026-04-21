from app.models.dto import RetrievalHit
from app.repositories.lorebook_repo import LorebookRepository
from app.repositories.memory_repo import MemoryRepository


class RetrievalService:
    def __init__(self) -> None:
        self.memory_repo = MemoryRepository()
        self.lorebook_repo = LorebookRepository()

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
        return self.memory_repo.search(project_id, query_text)

    def rerank_and_compress(self, lorebook_hits: list[RetrievalHit], memory_hits: list[RetrievalHit]) -> list[RetrievalHit]:
        merged = sorted([*lorebook_hits, *memory_hits], key=lambda item: item.score, reverse=True)
        return merged[:6]
