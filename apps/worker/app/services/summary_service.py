"""
SummaryService — Generates chapter summaries via LLM.

Sends the generated chapter text along with project/chapter context
to the LLM to produce a concise narrative summary suitable for
downstream memory injection and context retrieval.
"""

import json

from app.core.logging import get_logger, log_event
from app.models.dto import BuiltPrompt
from app.services.llm_gateway import LlmGateway

logger = get_logger(__name__)

# Maximum text length to include in the prompt to avoid token overflow
_MAX_TEXT_CHARS = 8000

# System prompt instructs the LLM to produce a tight chapter summary
_SYSTEM_PROMPT = """你是一名专业的小说分析助手。你的任务是为一章小说正文撰写简洁、精确的章节摘要。

要求：
1. 摘要长度控制在 80～200 字。
2. 必须覆盖：核心事件、主要角色的行为与心理变化、章节结尾的悬念或转折。
3. 使用第三人称客观叙述，不要加入你自己的评价。
4. 直接输出摘要正文，不要加标题、序号或其他包裹格式。"""


class SummaryService:
    """Summarizes a chapter's generated text using LLM."""

    def __init__(self) -> None:
        self.llm = LlmGateway()

    def summarize_chapter(self, text: str, project: dict, chapter: dict) -> str:
        """
        Call LLM to produce a chapter summary.

        Args:
            text: The full generated chapter text.
            project: Project metadata dict (title, genre, etc.).
            chapter: Chapter metadata dict (title, chapterNo, objective, conflict).

        Returns:
            A concise summary string (80~200 chars).
        """
        # Truncate overly long text to stay within token budget
        truncated_text = text[:_MAX_TEXT_CHARS]

        project_title = project.get("title", "未命名作品")
        chapter_title = chapter.get("title", f"第{chapter.get('chapterNo', '?')}章")
        chapter_no = chapter.get("chapterNo", "?")
        objective = chapter.get("objective", "")
        conflict = chapter.get("conflict", "")

        user_prompt = (
            f"作品：《{project_title}》\n"
            f"章节：第{chapter_no}章「{chapter_title}」\n"
        )
        if objective:
            user_prompt += f"章节目标：{objective}\n"
        if conflict:
            user_prompt += f"核心冲突：{conflict}\n"
        user_prompt += f"\n--- 正文 ---\n{truncated_text}\n--- 正文结束 ---\n\n请输出本章摘要："

        prompt = BuiltPrompt(
            system=_SYSTEM_PROMPT,
            user=user_prompt,
            debug={"service": "summary", "chapterNo": chapter_no},
        )

        try:
            # Summary doesn't need many tokens
            result = self.llm.generate(prompt, target_word_count=200)
            log_event(logger, "summary.llm.ok", chapterNo=chapter_no, length=len(result))
            return result.strip()
        except Exception as exc:
            # Fallback: return a generic placeholder so the pipeline doesn't crash
            log_event(logger, "summary.llm.failed", chapterNo=chapter_no, error=str(exc))
            return f"第{chapter_no}章「{chapter_title}」摘要生成失败，待人工补充。"
