"""
PolishChapterPipeline — Refines existing chapter drafts via LLM.

Takes a chapter's current draft text, sends it through the LLM with
carefully designed anti-AI-flavor prompts, and saves the polished
result as a new draft version. The original draft is preserved.

Key principles of the polish prompt:
  1. Zero tolerance for AI clichés (banned phrase list)
  2. Show-don't-tell enforcement
  3. Sensory detail augmentation
  4. Dialogue naturalization
  5. Pacing and rhythm tuning
  6. Continuity preservation (no plot changes allowed)
"""

from app.core.config import get_settings
from app.core.logging import get_logger, log_event
from app.models.dto import BuiltPrompt
from app.repositories.chapter_repo import ChapterRepository
from app.repositories.character_repo import CharacterRepository
from app.repositories.draft_repo import DraftRepository
from app.repositories.prompt_template_repo import PromptTemplateRepository
from app.repositories.volume_repo import VolumeRepository
from app.services.llm_gateway import LlmGateway

logger = get_logger(__name__)


# ── Polish system prompt — enforces deep anti-AI rewriting ──

_POLISH_SYSTEM_PROMPT = """你是一位资深的小说文本编辑，拥有敏锐的语感和对"AI味"的零容忍。你将收到已生成的正文，你的任务是进行精细润色——让它读起来像成熟作家手写的成稿，而非任何形式的机器生成物。

<HARD_RULES>
不可触碰的红线：
- 不得改变剧情事实、人物关系、时间线或关键事件结果
- 不得新增角色的台词/行为/心理（只能改写已有的表达方式）
- 不得添加任何解释、点评或写作说明
- 不得删除核心情节点、开头钩子或结尾悬念
- 不得凭空补充设定、人物或背景信息
- 不得改变叙事视角
- 润色后的字数应与原文大致相当（±15%）
</HARD_RULES>

<POLISH_METHOD>
润色执行顺序（按优先级从高到低）：

1. 去 AI 味（核心任务）
词汇层猎杀——发现即替换：
- 绝对删除：「不禁」「显得格外」「仿佛在诉说」「空气中弥漫着」「心中涌起」「一股莫名的」「心头一紧」「脑海中浮现」「眉头微蹙」「嘴角微微上扬」「眼中闪过一丝」
- 全文限用1次：「全场震惊」「倒吸一口凉气」「冷笑」「瞳孔骤缩」「众人哗然」「浑身一震」「眼神一凝」「冷哼」「嗤笑」
- 空泛形容替换：「非常/极其/无比/异常 + 形容词」→ 删除修饰词或改为具体细节
- 禁止套话：「他知道，接下来的路还很长」「这一切，才刚刚开始」「夜，很静」

情绪传递重写：
- 禁止直接宣告情绪状态（如「他很愤怒」「她感到悲伤」）
- 替代手段：生理反应 / 行为细节 / 环境投射 / 选择性注意
- 每个角色表达同一种情绪的方式应该不同（基于角色性格）

结构层打散：
- 消除连续相同句式（特别是「他……他……他……」的排比堆砌）
- 段首不连续使用「他/她/而/然而/此时/这时」
- 删除总结腔和「光明尾巴」（如：「也许，这就是成长的代价」）
- 打散排比堆砌

2. 展示替代讲述（Show, Don't Tell）
- 情绪外化：把直接宣告改为动作、微表情、器物反应或生理反应
- 保持原文情绪强度，只改变传达方式

3. 感官补足
- 每个场景至少 2 种感官描写（不能只有视觉）
- 优先补充声音、触感、温度、气味
- 去掉感知动词（如「他看到」「她听到」→ 直接呈现对象）

4. 对话打磨
- 消除「信息广播式对话」（角色为了读者而说不自然的话）
- 对话间穿插微动作（0.5~1句的行为描写）
- 保留角色特有的语言习惯和口头禅
- 确保每句对话都能区分说话人

5. 节奏微调
- 动作段落：以短句为主，制造紧迫感
- 情绪段落：长短句交替，营造呼吸感
- 保住开头钩子和结尾悬念，必要时加强

6. 一致性修复
- 人物称呼前后一致
- 时间线无矛盾
- 情绪连续（不能上一段还在伤心，下一段毫无过渡就开心了）
- 物品/伤势连续
</POLISH_METHOD>

<OUTPUT_CONTRACT>
直接输出润色后的正文，不要添加标题、章节号、说明或任何包裹标签。
</OUTPUT_CONTRACT>"""


class PolishChapterPipeline:
    """Pipeline for polishing an existing chapter draft via LLM."""

    def __init__(self) -> None:
        self.settings = get_settings()
        self.chapter_repo = ChapterRepository()
        self.character_repo = CharacterRepository()
        self.draft_repo = DraftRepository()
        self.volume_repo = VolumeRepository()
        self.prompt_template_repo = PromptTemplateRepository()
        self.llm = LlmGateway()

    def run(self, project_id: str, chapter_id: str, user_instruction: str | None = None) -> dict:
        """
        Polish the current draft of a chapter.

        Args:
            project_id: Project UUID string.
            chapter_id: Chapter UUID string.
            user_instruction: Optional user-provided focus instructions.

        Returns:
            Dict with keys: draftId, originalWordCount, polishedWordCount, text.
        """
        log_context = {"projectId": project_id, "chapterId": chapter_id}
        log_event(logger, "polish.pipeline.started", **log_context)

        # ── Load chapter metadata and current draft ──
        chapter_snapshot = self.chapter_repo.get_snapshot(
            chapter_id=chapter_id, project_id=project_id
        )
        chapter_no = chapter_snapshot.get("chapterNo", "?")
        chapter_title = chapter_snapshot.get("title", "")

        # Get the current draft content
        drafts = self.draft_repo.list_current_project_drafts(project_id, chapter_id)
        if not drafts:
            raise ValueError(f"章节 {chapter_id} 没有可润色的草稿，请先生成正文。")
        current_draft = drafts[0]["draft"]
        original_text = current_draft.get("content", "")
        if not original_text or len(original_text) < 50:
            raise ValueError("草稿内容过短，无法进行有效润色。")

        # ── Load character info for context ──
        volume_info = self.volume_repo.get_by_chapter(project_id, chapter_id)
        volume_no = volume_info.get("volumeNo") if volume_info else None
        characters = self.character_repo.list_related(project_id, volume_no=volume_no)
        character_block = ""
        if characters:
            char_lines = []
            for ch in characters[:8]:
                char_lines.append(f"- {ch['name']}：{ch.get('role', '')}，{ch.get('personality', '')}")
            character_block = "\n【角色信息】\n" + "\n".join(char_lines)

        # ── Build user prompt ──
        user_prompt = f"请对以下章节正文进行润色：\n\n"
        user_prompt += f"【章节】第{chapter_no}章「{chapter_title}」\n"
        if character_block:
            user_prompt += character_block + "\n"
        if user_instruction:
            user_prompt += f"\n【用户指令】\n{user_instruction}\n"
        user_prompt += f"\n【原文】\n{original_text}"

        # ── Resolve system prompt from DB or fallback ──
        db_template = self.prompt_template_repo.get_default("polish_chapter", project_id)
        system_prompt = db_template["systemPrompt"] if db_template else _POLISH_SYSTEM_PROMPT

        prompt = BuiltPrompt(
            system=system_prompt,
            user=user_prompt,
            debug={
                "service": "polish",
                "chapterNo": chapter_no,
                "promptSource": "db" if db_template else "hardcoded",
            },
        )

        log_event(logger, "polish.llm.requesting", **log_context,
                  originalWordCount=len(original_text))

        # ── Call LLM with higher token budget for polish ──
        polished_text = self.llm.generate(
            prompt, target_word_count=len(original_text)
        )

        # Strip any accidental wrapper tags the LLM might add
        polished_text = self._strip_wrapper_tags(polished_text)

        # ── Save as a new draft version ──
        draft = self.draft_repo.create_chapter_draft(
            chapter_id=chapter_id,
            content=polished_text,
            model_info={
                "provider": "openai-compatible",
                "model": self.settings.llm_model,
                "baseUrl": self.settings.llm_base_url,
                "mode": "polish",
            },
            generation_context={
                "type": "polish",
                "originalDraftId": current_draft.get("id"),
                "userInstruction": user_instruction,
            },
        )

        log_event(logger, "polish.pipeline.completed", **log_context,
                  originalWordCount=len(original_text),
                  polishedWordCount=len(polished_text),
                  draftId=draft["id"])

        return {
            "draftId": draft["id"],
            "originalWordCount": len(original_text),
            "polishedWordCount": len(polished_text),
            "text": polished_text,
        }

    @staticmethod
    def _strip_wrapper_tags(text: str) -> str:
        """Remove common LLM wrapper tags like <rewrite>...</rewrite>."""
        text = text.strip()
        # Handle <rewrite> tags
        if text.startswith("<rewrite>"):
            text = text[len("<rewrite>"):]
        if text.endswith("</rewrite>"):
            text = text[:-len("</rewrite>")]
        # Handle markdown code fences
        if text.startswith("```"):
            first_nl = text.index("\n") if "\n" in text else 3
            text = text[first_nl + 1:]
        if text.endswith("```"):
            text = text[:-3]
        return text.strip()
