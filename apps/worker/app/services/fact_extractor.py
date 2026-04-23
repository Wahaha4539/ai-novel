"""
FactExtractor — Extracts structured narrative facts from chapter text via LLM.

Three extraction tasks in one service:
  1. Story events: key plot beats, conflicts, revelations
  2. Character states: mental/physical state changes for named characters
  3. Foreshadows: planted hooks, unresolved threads, Chekhov's guns

Each method sends the chapter text to the LLM with a JSON-schema prompt,
parses the response, and returns typed dicts for downstream persistence.
"""

import json

from app.core.logging import get_logger, log_event
from app.models.dto import BuiltPrompt
from app.services.llm_gateway import LlmGateway

logger = get_logger(__name__)

# Limit text to prevent token overflow
_MAX_TEXT_CHARS = 8000


def _safe_parse_json(raw: str) -> list[dict] | None:
    """
    Robustly parse JSON array from LLM response.
    Handles markdown code fences and stray text around the JSON.
    """
    text = raw.strip()
    # Strip markdown code fences if present
    if text.startswith("```"):
        first_newline = text.index("\n") if "\n" in text else 3
        text = text[first_newline + 1:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    # Try to find the JSON array boundaries
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return None


class FactExtractor:
    """Extracts events, character states, and foreshadows from chapter text."""

    def __init__(self) -> None:
        self.llm = LlmGateway()

    # ── Story Event Extraction ────────────────────────────

    def extract_events(self, text: str, project: dict, chapter: dict) -> list[dict]:
        """
        Extract key story events/plot beats from a chapter.

        Returns a list of dicts with keys:
          title, eventType, description, participants, timelineSeq, status
        """
        chapter_no = chapter.get("chapterNo", "?")
        chapter_title = chapter.get("title", "")

        system = (
            "你是一名专业的小说叙事分析师。你的任务是从一章小说正文中提取关键剧情事件。\n\n"
            "提取规则：\n"
            "1. 只提取推动剧情发展的关键事件，忽略日常叙述和环境描写。\n"
            "2. 每个事件必须是具体的、可验证的叙事动作（不是模糊的情绪描述）。\n"
            "3. eventType 只能是以下之一：\n"
            "   - plot_turning: 剧情转折点（揭露秘密、关系逆转、重大决定）\n"
            "   - dialogue_conflict: 对话冲突（争论、审讯、试探、交锋）\n"
            "   - action_event: 行动事件（追逐、打斗、逃跑、搜查）\n"
            "   - revelation: 信息揭露（发现线索、得知真相、获取情报）\n"
            "   - relationship_shift: 关系变化（信任/背叛、亲近/疏远）\n"
            "4. participants 列出参与此事件的角色名（至少1个）。\n"
            "5. 输出 3~6 个事件，按发生顺序排列。\n\n"
            "输出格式：仅输出 JSON 数组，不要添加任何其他文字。\n"
            "```json\n"
            "[\n"
            '  {"title": "事件标题", "eventType": "plot_turning", '
            '"description": "50字以内的具体描述", '
            '"participants": ["角色A", "角色B"], '
            '"timelineSeq": 章节序号, "status": "detected"}\n'
            "]\n```"
        )

        user = (
            f"作品：《{project.get('title', '')}》\n"
            f"章节：第{chapter_no}章「{chapter_title}」\n\n"
            f"--- 正文 ---\n{text[:_MAX_TEXT_CHARS]}\n--- 正文结束 ---\n\n"
            "请提取本章的关键剧情事件："
        )

        prompt = BuiltPrompt(system=system, user=user, debug={"service": "fact_extractor.events", "chapterNo": chapter_no})

        try:
            raw = self.llm.generate(prompt, target_word_count=500)
            parsed = _safe_parse_json(raw)
            if parsed is None:
                log_event(logger, "fact_extractor.events.parse_failed", chapterNo=chapter_no)
                return []
            # Normalize: ensure each event has required fields
            result = []
            for item in parsed:
                result.append({
                    "title": item.get("title", "未命名事件"),
                    "eventType": item.get("eventType", "plot_turning"),
                    "description": item.get("description", ""),
                    "participants": item.get("participants", []),
                    "timelineSeq": item.get("timelineSeq", chapter_no),
                    "status": "detected",
                })
            log_event(logger, "fact_extractor.events.ok", chapterNo=chapter_no, count=len(result))
            return result
        except Exception as exc:
            log_event(logger, "fact_extractor.events.failed", chapterNo=chapter_no, error=str(exc))
            return []

    # ── Character State Extraction ────────────────────────

    def extract_character_states(self, text: str, project: dict, chapter: dict) -> list[dict]:
        """
        Extract character mental/physical state changes from a chapter.

        Returns a list of dicts with keys:
          character, stateType, stateValue, summary
        """
        chapter_no = chapter.get("chapterNo", "?")
        chapter_title = chapter.get("title", "")

        system = (
            "你是一名小说角色心理分析师。你的任务是从章节正文中提取角色状态变化。\n\n"
            "提取规则：\n"
            "1. 只提取在本章中有 **显著变化** 的角色状态，不要罗列没有变化的角色。\n"
            "2. stateType 必须是以下之一：\n"
            "   - mental_state: 心理状态（情绪、态度、信念的转变）\n"
            "   - physical_state: 身体状态（受伤、疲劳、体力变化）\n"
            "   - social_state: 社会关系状态（身份暴露、获得/失去信任）\n"
            "   - knowledge_state: 认知状态（获知新信息、发现真相、产生误判）\n"
            "3. stateValue 用 10 字以内描述变化后的状态。\n"
            "4. summary 用 30 字以内补充行为证据（角色做了什么导致此状态）。\n"
            "5. character 必须使用正文中出现的角色全名。\n\n"
            "输出格式：仅输出 JSON 数组，不要添加其他文字。\n"
            "```json\n"
            "[\n"
            '  {"character": "角色名", "stateType": "mental_state", '
            '"stateValue": "状态描述", "summary": "行为证据"}\n'
            "]\n```"
        )

        user = (
            f"作品：《{project.get('title', '')}》\n"
            f"章节：第{chapter_no}章「{chapter_title}」\n\n"
            f"--- 正文 ---\n{text[:_MAX_TEXT_CHARS]}\n--- 正文结束 ---\n\n"
            "请提取本章角色的状态变化："
        )

        prompt = BuiltPrompt(system=system, user=user, debug={"service": "fact_extractor.states", "chapterNo": chapter_no})

        try:
            raw = self.llm.generate(prompt, target_word_count=400)
            parsed = _safe_parse_json(raw)
            if parsed is None:
                log_event(logger, "fact_extractor.states.parse_failed", chapterNo=chapter_no)
                return []
            result = []
            for item in parsed:
                result.append({
                    "character": item.get("character", "未知角色"),
                    "stateType": item.get("stateType", "mental_state"),
                    "stateValue": item.get("stateValue", ""),
                    "summary": item.get("summary", ""),
                })
            log_event(logger, "fact_extractor.states.ok", chapterNo=chapter_no, count=len(result))
            return result
        except Exception as exc:
            log_event(logger, "fact_extractor.states.failed", chapterNo=chapter_no, error=str(exc))
            return []

    # ── Foreshadow Extraction ─────────────────────────────

    def extract_foreshadows(self, text: str, project: dict, chapter: dict) -> list[dict]:
        """
        Extract planted foreshadows and unresolved narrative hooks.

        Returns a list of dicts with keys:
          title, detail, status
        """
        chapter_no = chapter.get("chapterNo", "?")
        chapter_title = chapter.get("title", "")

        system = (
            "你是一名小说伏笔分析专家。你的任务是从章节正文中识别已埋设的伏笔和悬念。\n\n"
            "伏笔识别规则：\n"
            "1. 伏笔是指当前章节中 **有意埋设但尚未解决** 的叙事钩子，包括：\n"
            "   - 反常行为：角色做了不符合当前身份/情境的事\n"
            "   - 信息缺口：刻意隐瞒的信息、模糊的暗示\n"
            "   - 物品/场景暗示：被特别描写但尚未发挥作用的道具或场景\n"
            "   - 预言/对话暗示：角色的话语中暗含未来事件的线索\n"
            "2. 不要把已在本章解决的矛盾算作伏笔。\n"
            "3. title 用 10 字以内总结伏笔核心。\n"
            "4. detail 用 50 字以内说明具体内容和可能的展开方向。\n"
            "5. status 固定为 \"planted\"。\n"
            "6. 输出 2~5 个伏笔。\n\n"
            "输出格式：仅输出 JSON 数组，不要添加其他文字。\n"
            "```json\n"
            "[\n"
            '  {"title": "伏笔标题", "detail": "具体描述", "status": "planted"}\n'
            "]\n```"
        )

        user = (
            f"作品：《{project.get('title', '')}》\n"
            f"章节：第{chapter_no}章「{chapter_title}」\n\n"
            f"--- 正文 ---\n{text[:_MAX_TEXT_CHARS]}\n--- 正文结束 ---\n\n"
            "请识别本章中埋设的伏笔和悬念："
        )

        prompt = BuiltPrompt(system=system, user=user, debug={"service": "fact_extractor.foreshadows", "chapterNo": chapter_no})

        try:
            raw = self.llm.generate(prompt, target_word_count=400)
            parsed = _safe_parse_json(raw)
            if parsed is None:
                log_event(logger, "fact_extractor.foreshadows.parse_failed", chapterNo=chapter_no)
                return []
            result = []
            for item in parsed:
                result.append({
                    "title": item.get("title", "未命名伏笔"),
                    "detail": item.get("detail", ""),
                    "status": "planted",
                })
            log_event(logger, "fact_extractor.foreshadows.ok", chapterNo=chapter_no, count=len(result))
            return result
        except Exception as exc:
            log_event(logger, "fact_extractor.foreshadows.failed", chapterNo=chapter_no, error=str(exc))
            return []
