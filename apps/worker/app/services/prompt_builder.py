"""Prompt builder for chapter writing — assembles all context into LLM prompts.

Priority for system/user prompt source:
1. DB PromptTemplate (project-specific default)
2. DB PromptTemplate (global default)
3. File system fallback (packages/prompt-templates/)

Injects 7 context sections into the user prompt:
1. Project overview (title, genre, tone, outline, synopsis)
2. Volume context (title, objective, synopsis)
3. Style profile (POV, tense, prose style, pacing)
4. Character details (with personality, motivation)
5. Chapter specifics (title, objective, conflict, outline)
6. Foreshadow plans (plant/reveal instructions)
7. Previous chapters (last N chapters' full text)
Plus: hard facts, lorebook hits, memory recall, user instructions.
"""
from pathlib import Path

from app.core.logging import get_logger
from app.models.dto import BuiltPrompt, PromptBuildInput
from app.repositories.prompt_template_repo import PromptTemplateRepository

logger = get_logger(__name__)

# Maximum total characters for previous chapter context
_MAX_PREV_CONTEXT_TOTAL = 15000


class PromptBuilder:
    """Builds rich chapter-writing prompts from structured context."""

    def __init__(self) -> None:
        repo_root = Path(__file__).resolve().parents[4]
        self.template_root = repo_root / "packages" / "prompt-templates"
        self.prompt_template_repo = PromptTemplateRepository()

    def _read_template(self, relative_path: str) -> str:
        """Read a prompt template file from the file system (fallback)."""
        return (self.template_root / relative_path).read_text(encoding="utf-8")

    def _resolve_prompts(
        self, step_key: str, fallback_system: str, fallback_user: str, project_id: str | None = None
    ) -> tuple[str, str]:
        """Resolve system + user prompts from DB, falling back to file system.
        
        Returns:
            Tuple of (system_prompt, user_template)
        """
        db_template = self.prompt_template_repo.get_default(step_key, project_id)
        if db_template:
            logger.debug(
                "prompt.resolved_from_db",
                extra={"stepKey": step_key, "templateName": db_template["name"], "version": db_template["version"]},
            )
            return db_template["systemPrompt"], db_template["userTemplate"]

        # Fallback to file system
        logger.debug("prompt.fallback_to_filesystem", extra={"stepKey": step_key})
        return fallback_system, fallback_user

    def build_chapter_prompt(self, input_data: PromptBuildInput) -> BuiltPrompt:
        """Assemble system + user prompts with full context injection.
        
        Uses DB PromptTemplate if available (stepKey='write_chapter'),
        otherwise falls back to packages/prompt-templates/chapter/*.md.
        """
        # Resolve prompt source: DB > file system
        fs_system = self._read_template("chapter/system.md")
        fs_user = self._read_template("chapter/write_chapter.md")
        project_id = input_data.project.get("id")
        system_prompt, user_template = self._resolve_prompts("write_chapter", fs_system, fs_user, project_id)

        # --- Build each context section ---
        project_section = self._build_project_section(input_data)
        volume_section = self._build_volume_section(input_data)
        style_section = self._build_style_section(input_data)
        character_section = self._build_character_section(input_data)
        chapter_section = self._build_chapter_section(input_data)
        foreshadow_section = self._build_foreshadow_section(input_data)
        previous_section = self._build_previous_chapters_section(input_data)
        facts_section = self._build_facts_section(input_data)
        lorebook_section = self._build_lorebook_section(input_data)
        memory_section = self._build_memory_section(input_data)

        user_prompt = f"""{user_template}

{project_section}

{volume_section}

{style_section}

{character_section}

{chapter_section}

{foreshadow_section}

{facts_section}

{lorebook_section}

{memory_section}

{previous_section}

【附加指令】
{input_data.user_instruction or '无'}
"""

        return BuiltPrompt(
            system=system_prompt,
            user=user_prompt,
            debug={
                "tokenBudget": 6000,
                "lorebookCount": len(input_data.lorebook_hits),
                "memoryCount": len(input_data.memory_hits),
                "previousChapterCount": len(input_data.previous_chapters),
                "foreshadowCount": len(input_data.planned_foreshadows),
                "hasVolume": input_data.volume_info is not None,
                "hasStyleProfile": input_data.style_profile.get("pov") is not None,
                "promptSource": "db" if self.prompt_template_repo.get_default("write_chapter", project_id) else "filesystem",
                "truncated": False,
            },
        )

    @staticmethod
    def _build_project_section(data: PromptBuildInput) -> str:
        """Project-level context: title, genre, tone, synopsis, outline."""
        p = data.project
        lines = [
            "【项目概览】",
            f"标题：{p.get('title')}",
            f"类型：{p.get('genre') or '未指定'}",
            f"基调：{p.get('tone') or '未指定'}",
        ]
        if p.get("synopsis"):
            lines.append(f"故事简介：{p['synopsis']}")
        if p.get("outline"):
            # Truncate very long outlines to avoid consuming too much context
            outline_text = p["outline"][:3000]
            lines.append(f"故事总纲：{outline_text}")
        return "\n".join(lines)

    @staticmethod
    def _build_volume_section(data: PromptBuildInput) -> str:
        """Volume-level context: title, objective, synopsis."""
        vol = data.volume_info
        if not vol:
            return "【所属卷】\n未指定分卷"
        lines = [
            "【所属卷】",
            f"第{vol.get('volumeNo')}卷「{vol.get('title') or '未命名'}」",
        ]
        if vol.get("objective"):
            lines.append(f"本卷叙事目标：{vol['objective']}")
        if vol.get("synopsis"):
            lines.append(f"本卷概要：{vol['synopsis']}")
        return "\n".join(lines)

    @staticmethod
    def _build_style_section(data: PromptBuildInput) -> str:
        """Writing style constraints from the StyleProfile."""
        s = data.style_profile
        lines = [
            "【文风设定】",
            f"视角：{s.get('pov') or '第三人称限制'}",
            f"时态：{s.get('tense') or '过去时'}",
            f"文风：{s.get('proseStyle') or '冷峻、克制'}",
            f"节奏：{s.get('pacing') or 'medium'}",
        ]
        return "\n".join(lines)

    @staticmethod
    def _build_character_section(data: PromptBuildInput) -> str:
        """Character details with personality and motivation for richer writing."""
        chars = data.outline_bundle.get("relatedCharacters") or []
        if not chars:
            return "【角色信息】\n- 无登场角色"
        lines = ["【角色信息】"]
        for char in chars[:10]:
            name = char.get("name", "?")
            role = char.get("roleType", "未知")
            parts = [f"- {name}（{role}）"]
            if char.get("personalityCore"):
                parts.append(f"性格：{char['personalityCore']}")
            if char.get("motivation"):
                parts.append(f"动机：{char['motivation']}")
            if char.get("speechStyle"):
                parts.append(f"语言风格：{char['speechStyle']}")
            lines.append("｜".join(parts))
        return "\n".join(lines)

    @staticmethod
    def _build_chapter_section(data: PromptBuildInput) -> str:
        """Current chapter specifics."""
        ch = data.chapter
        target_wc = data.target_word_count or ch.get("expectedWordCount") or 3500
        lines = [
            "【章节信息】",
            f"章节号：第{ch.get('chapterNo')}章",
            f"标题：{ch.get('title') or '未命名'}",
            f"目标：{ch.get('objective') or '无'}",
            f"冲突：{ch.get('conflict') or '无'}",
            f"大纲：{ch.get('outline') or '无'}",
            f"目标字数：{target_wc}",
        ]
        if ch.get("revealPoints"):
            lines.append(f"揭示点：{ch['revealPoints']}")
        if ch.get("foreshadowPlan"):
            lines.append(f"伏笔计划：{ch['foreshadowPlan']}")
        return "\n".join(lines)

    @staticmethod
    def _build_foreshadow_section(data: PromptBuildInput) -> str:
        """Planned foreshadows from the guided wizard that should be woven into this chapter."""
        foreshadows = data.planned_foreshadows
        if not foreshadows:
            return "【本章伏笔计划】\n- 无特定伏笔要求"
        lines = ["【本章伏笔计划】"]
        for fs in foreshadows:
            role = fs.get("role", "active")
            title = fs.get("title", "?")
            detail = fs.get("detail", "")
            if role == "plant":
                technique = fs.get("technique", "暗示")
                lines.append(f"- [埋设] {title} — {detail}（手法：{technique}）")
            elif role == "reveal":
                payoff = fs.get("payoff", "揭晓")
                lines.append(f"- [揭开] {title} — {payoff}")
            else:
                lines.append(f"- [延续] {title} — {detail}")
        return "\n".join(lines)

    def _build_previous_chapters_section(self, data: PromptBuildInput) -> str:
        """Previous chapters' full text for narrative continuity.
        Applies total character budget to avoid overflowing context window."""
        chapters = data.previous_chapters
        if not chapters:
            return "【前文回顾】\n本章为首章或前文尚未生成。"

        lines = ["【前文回顾（前几章正文）】"]
        total_chars = 0
        included = 0

        for ch in chapters:
            content = ch.get("content", "")
            # Stop if adding this chapter would exceed total budget
            if total_chars + len(content) > _MAX_PREV_CONTEXT_TOTAL and included > 0:
                lines.append(f"（后续 {len(chapters) - included} 章因篇幅省略，请参考记忆召回摘要）")
                break
            chapter_no = ch.get("chapterNo", "?")
            title = ch.get("title", "未命名")
            lines.append(f"\n=== 第{chapter_no}章「{title}」===")
            lines.append(content)
            total_chars += len(content)
            included += 1

        return "\n".join(lines)

    @staticmethod
    def _build_facts_section(data: PromptBuildInput) -> str:
        """Hard facts that the LLM must respect."""
        if not data.hard_facts:
            return "【硬事实】\n- 无"
        lines = ["【硬事实】"]
        lines.extend(f"- {fact}" for fact in data.hard_facts)
        return "\n".join(lines)

    @staticmethod
    def _build_lorebook_section(data: PromptBuildInput) -> str:
        """Lorebook hits from semantic search."""
        if not data.lorebook_hits:
            return "【Lorebook 命中】\n- 无"
        lines = ["【Lorebook 命中】"]
        lines.extend(f"- {hit.title}: {hit.content}" for hit in data.lorebook_hits)
        return "\n".join(lines)

    @staticmethod
    def _build_memory_section(data: PromptBuildInput) -> str:
        """Memory recall hits from previous chapters' extracted facts."""
        if not data.memory_hits:
            return "【记忆召回】\n- 无"
        lines = ["【记忆召回】"]
        lines.extend(f"- {hit.title}: {hit.content}" for hit in data.memory_hits)
        return "\n".join(lines)
