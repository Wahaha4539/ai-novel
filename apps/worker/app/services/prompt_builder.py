from pathlib import Path

from app.models.dto import BuiltPrompt, PromptBuildInput


class PromptBuilder:
    def __init__(self) -> None:
        repo_root = Path(__file__).resolve().parents[4]
        self.template_root = repo_root / "packages" / "prompt-templates"

    def _read_template(self, relative_path: str) -> str:
        return (self.template_root / relative_path).read_text(encoding="utf-8")

    def build_chapter_prompt(self, input_data: PromptBuildInput) -> BuiltPrompt:
        system_prompt = self._read_template("chapter/system.md")
        user_template = self._read_template("chapter/write_chapter.md")

        lorebook_section = "\n".join(
            f"- {hit.title}: {hit.content}" for hit in input_data.lorebook_hits
        ) or "- 无"
        memory_section = "\n".join(
            f"- {hit.title}: {hit.content}" for hit in input_data.memory_hits
        ) or "- 无"

        user_prompt = f"""{user_template}

【项目】
标题：{input_data.project.get('title')}
类型：{input_data.project.get('genre')}
基调：{input_data.project.get('tone')}

【章节】
标题：{input_data.chapter.get('title')}
目标：{input_data.chapter.get('objective')}
冲突：{input_data.chapter.get('conflict')}
大纲：{input_data.chapter.get('outline')}
目标字数：{input_data.target_word_count or input_data.chapter.get('expectedWordCount')}

【硬事实】
{chr(10).join(f'- {fact}' for fact in input_data.hard_facts)}

【Lorebook 命中】
{lorebook_section}

【记忆召回】
{memory_section}

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
                "truncated": False,
            },
        )
