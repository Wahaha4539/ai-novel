from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class RetrievalHit:
    source_type: str
    source_id: str
    title: str
    content: str
    score: float
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class PromptBuildInput:
    """All context needed to build a chapter-writing prompt."""
    project: dict[str, Any]
    chapter: dict[str, Any]
    style_profile: dict[str, Any]
    hard_facts: list[str]
    lorebook_hits: list[RetrievalHit]
    memory_hits: list[RetrievalHit]
    outline_bundle: dict[str, Any]
    user_instruction: str | None = None
    target_word_count: int | None = None
    # New context sources populated by the enriched pipeline
    volume_info: dict[str, Any] | None = None
    planned_foreshadows: list[dict[str, Any]] = field(default_factory=list)
    previous_chapters: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class BuiltPrompt:
    system: str
    user: str
    debug: dict[str, Any]
