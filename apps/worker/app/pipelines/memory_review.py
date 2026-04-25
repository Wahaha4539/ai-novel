import json

from app.core.logging import get_logger, log_event
from app.models.dto import BuiltPrompt
from app.repositories.memory_review_repo import MemoryReviewRepository
from app.services.cache_service import CacheService
from app.services.llm_gateway import LlmGateway

logger = get_logger(__name__)


class MemoryReviewPipeline:
    """Resolve pending_review memory chunks with an unattended LLM audit."""

    def __init__(self) -> None:
        self.repo = MemoryReviewRepository()
        self.llm = LlmGateway()
        self.cache_service = CacheService()

    def run(self, project_id: str, chapter_id: str | None = None) -> dict:
        """Confirm or reject pending_review memories for a chapter.

        Args:
            project_id: Project UUID.
            chapter_id: Optional chapter UUID scope.

        Returns:
            Review counts and applied decisions.
        """
        log_context = {"projectId": project_id, "chapterId": chapter_id}
        queue = self.repo.list_pending(project_id, chapter_id)
        if not queue:
            return {"reviewedCount": 0, "confirmedCount": 0, "rejectedCount": 0, "decisions": []}

        prompt = BuiltPrompt(
            system="你是小说事实层审计员。只判断 pending_review 记忆是否应采纳进入事实层，或拒绝移除。必须输出严格 JSON。",
            user="\n".join(
                [
                    "请审核以下待确认记忆。判断标准：",
                    "1. 与章节事实、人物状态、路线、伏笔一致且有助于后续检索的，action=confirm。",
                    "2. 重复、误读、过度推断、与上下文冲突、只是临时心理描写不应固化的，action=reject。",
                    "3. 不要新增 id，不要省略任何输入项。",
                    '输出格式：[{"id":"...","action":"confirm|reject","reason":"简短中文理由"}]',
                    json.dumps(queue, ensure_ascii=False),
                ]
            ),
            debug={"service": "memory_review", "chapterId": chapter_id},
        )

        answer = self.llm.generate(prompt, app_step="memory_review")
        decisions = self._parse_decisions(answer)
        allowed_ids = {item["id"] for item in queue}
        applied: list[dict] = []
        confirmed_count = 0
        rejected_count = 0

        for decision in decisions:
            if decision["id"] not in allowed_ids:
                continue
            next_status = "user_confirmed" if decision["action"] == "confirm" else "rejected"
            # Decision propagation keeps MemoryChunk and derived fact statuses in sync.
            self.repo.apply_decision(project_id, decision["id"], next_status)
            confirmed_count += 1 if decision["action"] == "confirm" else 0
            rejected_count += 1 if decision["action"] == "reject" else 0
            applied.append(decision)

        self.cache_service.invalidate_project_recall_results(project_id)
        log_event(
            logger,
            "memory_review.completed",
            **log_context,
            reviewedCount=len(applied),
            confirmedCount=confirmed_count,
            rejectedCount=rejected_count,
        )
        return {
            "reviewedCount": len(applied),
            "confirmedCount": confirmed_count,
            "rejectedCount": rejected_count,
            "skippedCount": len(queue) - len(applied),
            "decisions": applied,
        }

    @staticmethod
    def _parse_decisions(text: str) -> list[dict]:
        """Parse strict JSON decisions from possible Markdown-wrapped LLM output."""
        raw = text.strip()
        if "```" in raw:
            parts = raw.split("```")
            raw = parts[1].removeprefix("json").strip() if len(parts) >= 3 else raw
        start = min([idx for idx in (raw.find("["), raw.find("{")) if idx >= 0], default=-1)
        end = max(raw.rfind("]"), raw.rfind("}"))
        if start < 0 or end < start:
            raise ValueError("LLM 未返回可解析的审核 JSON")

        parsed = json.loads(raw[start : end + 1])
        items = parsed if isinstance(parsed, list) else parsed.get("decisions") if isinstance(parsed, dict) else []
        decisions: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            action = item.get("action")
            memory_id = item.get("id")
            if isinstance(memory_id, str) and action in {"confirm", "reject"}:
                decisions.append({"id": memory_id, "action": action, "reason": item.get("reason")})
        return decisions