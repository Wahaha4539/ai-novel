"""
ValidationEngine — Pre-check and post-generation validation for chapters.

Two stages:
  1. precheck_chapter: Rule-based sanity checks BEFORE generation (no LLM).
  2. validate_generated_text: Rule-based + LLM semantic checks AFTER generation.

The LLM post-validation catches issues that pure rules cannot detect:
  - Character voice consistency (does dialogue match the character?)
  - POV violations (did the narration slip into a different perspective?)
  - Logic/continuity errors (contradictions within the chapter)
  - Pacing issues (info-dump segments, rushed climaxes)
"""

import json

from app.core.logging import get_logger, log_event
from app.models.dto import BuiltPrompt
from app.models.enums import ValidationSeverity
from app.models.schemas import ValidationIssue
from app.services.llm_gateway import LlmGateway

logger = get_logger(__name__)

_MAX_TEXT_CHARS = 8000


class ValidationEngine:
    """Validates chapter content both before and after generation."""

    def __init__(self) -> None:
        self.llm = LlmGateway()

    # ── Pre-generation rule checks (no LLM) ──────────────

    def precheck_chapter(self, context: dict, hard_facts: list[str]) -> list[ValidationIssue]:
        """
        Rule-based sanity check before triggering LLM generation.
        Catches missing required fields that would cause bad output.
        """
        issues: list[ValidationIssue] = []
        if not context.get("objective"):
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.ERROR,
                    issueType="chapter_objective_missing",
                    message="当前章节缺少 objective，无法稳定生成正文。",
                    suggestion="先补充章节目标，再触发生成。",
                )
            )
        if not hard_facts:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="hard_fact_missing",
                    message="当前未注入明确硬事实，生成结果更容易漂移。",
                    suggestion="补充角色状态、地点规则或最近章节摘要。",
                )
            )
        return issues

    # ── Post-generation validation (rules + LLM) ─────────

    def validate_generated_text(
        self,
        text: str,
        chapter: dict,
        characters: list[dict] | None = None,
        character_states: list[dict] | None = None,
        story_events: list[dict] | None = None,
        foreshadows: list[dict] | None = None,
        previous_chapters: list[dict] | None = None,
    ) -> list[ValidationIssue]:
        """
        Validate generated text with rules + LLM semantic analysis.

        Args:
            text: Generated chapter text.
            chapter: Chapter metadata.
            characters: Registered character profiles.
            character_states: Accumulated state snapshots from prior chapters.
            story_events: Accumulated story events from prior chapters.
            foreshadows: Active foreshadow tracks.
            previous_chapters: Raw previous chapter drafts (fallback context).
        """
        issues: list[ValidationIssue] = []
        issues.extend(self._rule_check_length(text, chapter))
        issues.extend(self._rule_check_ai_flavor(text))
        llm_issues = self._llm_semantic_check(
            text, chapter,
            characters=characters or [],
            character_states=character_states or [],
            story_events=story_events or [],
            foreshadows=foreshadows or [],
            previous_chapters=previous_chapters or [],
        )
        issues.extend(llm_issues)
        return issues

    # ── Rule-based sub-checks ────────────────────────────

    @staticmethod
    def _rule_check_length(text: str, chapter: dict) -> list[ValidationIssue]:
        """Check if generated text meets minimum length requirements."""
        issues = []
        if len(text) < 300:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="chapter_too_short",
                    message="生成正文长度偏短，可能不足以支撑完整章节节奏。",
                    suggestion="提高字数目标，或补充更详细的章节大纲。",
                )
            )
        expected = chapter.get("expectedWordCount", 3500)
        if len(text) < expected * 0.4:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="chapter_severely_under_target",
                    message=f"正文字数({len(text)})远低于目标({expected})的40%。",
                    suggestion="检查 prompt 是否过于模糊，或增加 max_tokens。",
                )
            )
        return issues

    @staticmethod
    def _rule_check_ai_flavor(text: str) -> list[ValidationIssue]:
        """Detect common AI-generated language patterns."""
        issues = []
        # High-frequency AI cliché phrases
        ai_markers = [
            "不禁", "显得格外", "仿佛在诉说", "空气中弥漫着",
            "心中涌起", "一股莫名的", "心头一紧", "脑海中浮现",
        ]
        found = [m for m in ai_markers if m in text]
        if len(found) >= 3:
            issues.append(
                ValidationIssue(
                    severity=ValidationSeverity.WARNING,
                    issueType="ai_flavor_detected",
                    message=f"检测到多个AI味用词（{', '.join(found[:5])}），建议润色。",
                    suggestion="使用「章节润色」功能消除AI生成痕迹。",
                )
            )
        return issues

    # ── LLM semantic validation ──────────────────────────

    def _llm_semantic_check(
        self,
        text: str,
        chapter: dict,
        characters: list[dict],
        character_states: list[dict],
        story_events: list[dict],
        foreshadows: list[dict],
        previous_chapters: list[dict],
    ) -> list[ValidationIssue]:
        """
        Send text + full narrative context to LLM for deep semantic validation.
        Uses accumulated character states, story events, and foreshadows
        across the entire novel — not just the last few chapters.
        """
        chapter_no = chapter.get("chapterNo", "?")
        chapter_title = chapter.get("title", "")
        objective = chapter.get("objective", "")
        conflict = chapter.get("conflict", "")

        system = (
            "你是一名专业的长篇小说质量审校编辑。你将收到：\n"
            "1. 当前章节正文\n"
            "2. 截至本章前的【角色状态线】（每个角色在各章的状态变化记录）\n"
            "3. 截至本章前的【已发生事件】（关键剧情事件时间线）\n"
            "4. 当前活跃的【伏笔】\n"
            "5. 前几章的正文片段\n\n"
            "你的任务是对比这些上下文，找出当前章节中 **具体的、可定位的** 逻辑问题。\n\n"
            "审校维度（按优先级从高到低）：\n\n"
            "【A. 角色状态连续性（最重要）】\n"
            "- 角色的身体状态是否衔接（受伤/疲劳/生病等状态不能凭空消失）\n"
            "- 角色的心理状态是否连贯（情绪转变需要动机）\n"
            "- 角色的认知状态是否一致（已知/未知信息不能矛盾）\n"
            "- 角色的社会关系是否延续（信任/敌对不能无故翻转）\n\n"
            "【B. 事件时间线连续性】\n"
            "- 已发生的事件不能被遗忘或矛盾\n"
            "- 时间顺序不能错乱（白天/黑夜、日期）\n"
            "- 空间连续性（角色移动需要交代）\n\n"
            "【C. 伏笔一致性】\n"
            "- 本章是否与已埋设的伏笔矛盾\n"
            "- 应该在本章回收的伏笔是否被处理\n\n"
            "【D. 章节内部逻辑 + 视角 + 节奏】\n"
            "- 本章内自相矛盾、视角滑动、info-dump、广播式对话\n\n"
            "输出要求：\n"
            "- 只输出 JSON 数组\n"
            "- severity: \"error\"（硬伤）/ \"warning\"（建议）/ \"info\"（可选）\n"
            "- issueType: continuity_break / character_state_mismatch / "
            "timeline_conflict / spatial_error / knowledge_conflict / "
            "foreshadow_conflict / pov_slip / causality_gap / pacing_issue\n"
            "- message 必须引用具体位置和前文记录\n"
            "- 质量良好则输出 []\n"
            "- 最多 8 个问题，优先报告跨章逻辑问题\n"
        )

        # ── Build user prompt with structured narrative context ──
        user = f"章节：第{chapter_no}章「{chapter_title}」\n"
        if objective:
            user += f"章节目标：{objective}\n"
        if conflict:
            user += f"核心冲突：{conflict}\n"

        # Character profiles
        if characters:
            user += "\n【登场角色】\n"
            for c in characters[:8]:
                # CharacterRepository 返回 roleType/personalityCore 等驼峰字段；
                # 校验提示词需要完整角色画像，避免审校模型因上下文缺失误判角色行为。
                details = []
                if c.get("roleType"):
                    details.append(f"定位：{c['roleType']}")
                if c.get("personalityCore"):
                    details.append(f"性格：{c['personalityCore']}")
                if c.get("motivation"):
                    details.append(f"动机：{c['motivation']}")
                if c.get("speechStyle"):
                    details.append(f"语言风格：{c['speechStyle']}")
                user += f"  - {c['name']}：{'；'.join(details) or '暂无详细设定'}\n"

        # Accumulated character state timeline
        if character_states:
            user += "\n【角色状态线（截至本章前）】\n"
            for s in character_states:
                user += (f"  第{s['chapterNo']}章 {s['characterName']}："
                         f"[{s['stateType']}] {s['stateValue']}"
                         f"{' — ' + s['summary'] if s.get('summary') else ''}\n")

        # Accumulated story events
        if story_events:
            user += "\n【已发生事件（截至本章前）】\n"
            for e in story_events:
                participants = '、'.join(e.get('participants', []))
                user += (f"  第{e['chapterNo']}章 [{e['eventType']}] {e['title']}："
                         f"{e['description']}"
                         f"{' （' + participants + '）' if participants else ''}\n")

        # Active foreshadows
        if foreshadows:
            user += "\n【活跃伏笔】\n"
            for f in foreshadows:
                user += f"  - {f['title']}：{f.get('detail', '')}\n"

        # Previous chapter text (last 2, truncated)
        if previous_chapters:
            user += "\n【前文片段（最近2章）】\n"
            for prev in previous_chapters[-2:]:
                pn = prev.get('chapterNo', '?')
                user += f"--- 第{pn}章 ---\n{prev.get('content', '')[:1500]}\n---\n\n"

        user += (
            f"\n【当前章节正文（待审校）】\n"
            f"{text[:_MAX_TEXT_CHARS]}\n\n"
            "请审校以上正文，重点对比角色状态线和事件记录，输出发现的问题："
        )

        prompt = BuiltPrompt(
            system=system,
            user=user,
            debug={"service": "validation_engine.semantic", "chapterNo": chapter_no},
        )

        try:
            raw = self.llm.generate(prompt, target_word_count=500)
            return self._parse_llm_issues(raw, chapter_no)
        except Exception as exc:
            log_event(logger, "validation.semantic.failed", chapterNo=chapter_no, error=str(exc))
            return []

    @staticmethod
    def _parse_llm_issues(raw: str, chapter_no: int | str) -> list[ValidationIssue]:
        """Parse the LLM's JSON response into ValidationIssue objects."""
        text = raw.strip()
        # Strip markdown fences
        if text.startswith("```"):
            first_nl = text.index("\n") if "\n" in text else 3
            text = text[first_nl + 1:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end <= start:
            return []

        try:
            items = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            log_event(logger, "validation.semantic.parse_failed", chapterNo=chapter_no)
            return []

        # Map LLM severity strings to our enum
        severity_map = {
            "error": ValidationSeverity.ERROR,
            "warning": ValidationSeverity.WARNING,
            "info": ValidationSeverity.INFO,
        }

        result = []
        for item in items:
            if not isinstance(item, dict):
                continue
            sev_str = str(item.get("severity", "info")).lower()
            result.append(
                ValidationIssue(
                    severity=severity_map.get(sev_str, ValidationSeverity.INFO),
                    issueType=item.get("issueType", "semantic_issue"),
                    message=item.get("message", ""),
                    suggestion=item.get("suggestion", ""),
                )
            )
        log_event(logger, "validation.semantic.ok", chapterNo=chapter_no, issueCount=len(result))
        return result
