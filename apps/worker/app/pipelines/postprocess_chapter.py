from app.core.logging import get_logger, log_event
from app.models.schemas import GenerateChapterJobResult, MemoryRebuildRequest
from app.pipelines.fact_validation import FactValidationPipeline
from app.pipelines.memory_review import MemoryReviewPipeline
from app.pipelines.polish_chapter import PolishChapterPipeline
from app.pipelines.rebuild_memory import RebuildMemoryPipeline
from app.repositories.validation_repo import ValidationRepository

logger = get_logger(__name__)

MAX_AUTO_FIX_ATTEMPTS = 3
DEFAULT_POLISH_INSTRUCTION = "请在不改变剧情事实、人物关系和章节主线结果的前提下，润色当前章节正文：提升句子流畅度、画面感、节奏和衔接，修正明显语病与重复表达。直接输出润色后的完整章节正文，不要添加说明。"


class PostProcessChapterPipeline:
    """Orchestrate polish → memory rebuild → memory review → validation → fix."""

    def __init__(self) -> None:
        self.polish_pipeline = PolishChapterPipeline()
        self.memory_rebuild_pipeline = RebuildMemoryPipeline()
        self.fact_validation_pipeline = FactValidationPipeline()
        self.memory_review_pipeline = MemoryReviewPipeline()
        self.validation_repo = ValidationRepository()

    def run(self, project_id: str, chapter_id: str, generation_result: GenerateChapterJobResult) -> dict:
        """Run the full post-generation chain and return completion metadata.

        Args:
            project_id: Project UUID.
            chapter_id: Chapter UUID.
            generation_result: Initial generation result used as baseline metadata.

        Returns:
            A dict with final draft id, word count, and per-step summaries.

        Raises:
            ValueError when validation issues remain after automatic repair.
        """
        log_context = {"projectId": project_id, "chapterId": chapter_id}
        steps: list[dict] = []
        log_event(logger, "postprocess.started", **log_context)

        polish = self.polish_pipeline.run(project_id, chapter_id, DEFAULT_POLISH_INSTRUCTION)
        steps.append({"step": "polish", "draftId": polish["draftId"], "wordCount": polish["polishedWordCount"]})

        rebuild = self._rebuild_memory(project_id, chapter_id)
        steps.append({"step": "memory_rebuild", "processedChapterCount": rebuild.processed_chapter_count})

        # Review freshly rebuilt pending facts before validation. Otherwise deterministic
        # rules may block on facts that the unattended reviewer would reject, which makes
        # background generation fail while the same manual review→validate flow succeeds.
        memory_review = self.memory_review_pipeline.run(project_id, chapter_id)
        steps.append({"step": "memory_review", **memory_review})

        validation = self.fact_validation_pipeline.run(project_id, chapter_id)
        open_issues = self.validation_repo.list_open_by_chapter(chapter_id)
        steps.append({"step": "validation", "createdCount": validation["createdCount"], "openIssueCount": len(open_issues)})

        open_issues = self._auto_fix_until_clean(project_id, chapter_id, open_issues, steps)
        if open_issues:
            raise ValueError(f"当前章节仍有 {len(open_issues)} 个校验问题，请人工处理后重试。")

        log_event(logger, "postprocess.completed", **log_context, finalDraftId=polish["draftId"])
        return {
            "draftId": polish["draftId"],
            "summary": generation_result.summary,
            "actualWordCount": polish["polishedWordCount"],
            "steps": steps,
        }

    def _auto_fix_until_clean(self, project_id: str, chapter_id: str, issues: list[dict], steps: list[dict]) -> list[dict]:
        """Run bounded auto-fix cycles and return any unresolved issues."""
        remaining_issues = issues
        for attempt in range(1, MAX_AUTO_FIX_ATTEMPTS + 1):
            if not remaining_issues:
                break

            log_event(
                logger,
                "postprocess.auto_fix.attempt_started",
                projectId=project_id,
                chapterId=chapter_id,
                attempt=attempt,
                maxAttempts=MAX_AUTO_FIX_ATTEMPTS,
                openIssueCount=len(remaining_issues),
                issueTypes=[issue.get("issueType") for issue in remaining_issues],
            )
            instruction = self._build_validation_fix_instruction(remaining_issues)
            polish = self.polish_pipeline.run(project_id, chapter_id, instruction)
            rebuild = self._rebuild_memory(project_id, chapter_id)
            # Auto-fix rewrites can produce new pending_review facts. Audit them before
            # re-validating so rejected extraction noise does not keep the retry loop stuck.
            memory_review = self.memory_review_pipeline.run(project_id, chapter_id)
            validation = self.fact_validation_pipeline.run(project_id, chapter_id)
            remaining_issues = self.validation_repo.list_open_by_chapter(chapter_id)
            steps.append(
                {
                    "step": "auto_fix",
                    "attempt": attempt,
                    "draftId": polish["draftId"],
                    "processedChapterCount": rebuild.processed_chapter_count,
                    "reviewedCount": memory_review["reviewedCount"],
                    "confirmedCount": memory_review["confirmedCount"],
                    "rejectedCount": memory_review["rejectedCount"],
                    "createdIssueCount": validation["createdCount"],
                    "openIssueCount": len(remaining_issues),
                }
            )
            log_event(
                logger,
                "postprocess.auto_fix.attempt_completed",
                projectId=project_id,
                chapterId=chapter_id,
                attempt=attempt,
                maxAttempts=MAX_AUTO_FIX_ATTEMPTS,
                draftId=polish["draftId"],
                processedChapterCount=rebuild.processed_chapter_count,
                reviewedCount=memory_review["reviewedCount"],
                confirmedCount=memory_review["confirmedCount"],
                rejectedCount=memory_review["rejectedCount"],
                createdIssueCount=validation["createdCount"],
                openIssueCount=len(remaining_issues),
                willRetry=bool(remaining_issues and attempt < MAX_AUTO_FIX_ATTEMPTS),
            )

        return remaining_issues

    @staticmethod
    def _rebuild_memory(project_id: str, chapter_id: str):
        """Rebuild facts from the latest current draft after a rewrite step."""
        return RebuildMemoryPipeline().run(MemoryRebuildRequest(projectId=project_id, chapterId=chapter_id, dryRun=False))

    @staticmethod
    def _build_validation_fix_instruction(issues: list[dict]) -> str:
        """Create the same all-at-once repair instruction previously built by the frontend."""
        issue_lines = []
        for index, issue in enumerate(issues, start=1):
            lines = [
                f"问题 {index}",
                f"- 类型：{issue.get('issueType')}",
                f"- 严重程度：{issue.get('severity')}",
                f"- 详情：{issue.get('message')}",
            ]
            if issue.get("suggestion"):
                lines.append(f"- 已有建议：{issue['suggestion']}")
            issue_lines.append("\n".join(lines))

        return "\n".join(
            [
                "请一次性修复以下全部结构化事实校验问题，不要逐条孤立改写，不要重写整章，不要改变主线结果。",
                "修复方式：合并考虑所有问题，在相关段落补充必要过渡、空间移动、时间衔接或事实澄清；保持原有叙事视角、语气和人物关系。",
                "\n\n".join(issue_lines),
                "输出要求：直接输出修复后的完整章节正文，不要添加说明、标题、diff 或分析。",
            ]
        )