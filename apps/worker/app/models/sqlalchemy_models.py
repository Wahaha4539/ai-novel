from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum as SqlEnum, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        "createdAt",
        DateTime(timezone=True),
        server_default=func.now(),
    )
    # Prisma @updatedAt 不会创建 DB DEFAULT，必须用应用层 default
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt",
        DateTime(timezone=True),
        default=func.now(),
        onupdate=func.now(),
    )


class ProjectModel(TimestampMixin, Base):
    """Core project entity — maps to Prisma 'Project' table.
    genre/theme/tone use Text to match Prisma @db.Text columns.
    outline and logline are populated by the guided wizard."""
    __tablename__ = "Project"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID | None] = mapped_column("ownerId", UUID(as_uuid=True), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    # Text columns — guided wizard writes rich content here
    genre: Mapped[str | None] = mapped_column(Text, nullable=True)
    theme: Mapped[str | None] = mapped_column(Text, nullable=True)
    tone: Mapped[str | None] = mapped_column(Text, nullable=True)
    logline: Mapped[str | None] = mapped_column(Text, nullable=True)
    synopsis: Mapped[str | None] = mapped_column(Text, nullable=True)
    outline: Mapped[str | None] = mapped_column(Text, nullable=True)
    target_word_count: Mapped[int | None] = mapped_column("targetWordCount", Integer, nullable=True)
    status: Mapped[str] = mapped_column(
        SqlEnum("draft", "active", "archived", name="ProjectStatus", create_type=False),
        default="draft",
    )

    chapters: Mapped[list[ChapterModel]] = relationship(back_populates="project")
    characters: Mapped[list[CharacterModel]] = relationship(back_populates="project")
    lorebook_entries: Mapped[list[LorebookEntryModel]] = relationship(back_populates="project")
    volumes: Mapped[list[VolumeModel]] = relationship(back_populates="project")
    style_profiles: Mapped[list[StyleProfileModel]] = relationship(back_populates="project")
    generation_jobs: Mapped[list[GenerationJobModel]] = relationship(back_populates="project")


class CharacterModel(TimestampMixin, Base):
    """Character entity — scope/source added for guided wizard support.
    scope: 'global' | 'volume_N' | 'chapter' — controls visibility per volume.
    source: 'manual' | 'guided' | 'guided_chapter' — tracks creation origin."""
    __tablename__ = "Character"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    name: Mapped[str] = mapped_column(String(100))
    role_type: Mapped[str | None] = mapped_column("roleType", String(50), nullable=True)
    personality_core: Mapped[str | None] = mapped_column("personalityCore", Text, nullable=True)
    motivation: Mapped[str | None] = mapped_column(Text, nullable=True)
    speech_style: Mapped[str | None] = mapped_column("speechStyle", Text, nullable=True)
    backstory: Mapped[str | None] = mapped_column(Text, nullable=True)
    growth_arc: Mapped[str | None] = mapped_column("growthArc", Text, nullable=True)
    is_dead: Mapped[bool] = mapped_column("isDead", Boolean, default=False)
    # Guided wizard fields: scope controls per-volume visibility
    scope: Mapped[str | None] = mapped_column(String(20), nullable=True)
    source: Mapped[str] = mapped_column(String(30), default="manual")
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)

    project: Mapped[ProjectModel] = relationship(back_populates="characters")


class LorebookEntryModel(TimestampMixin, Base):
    __tablename__ = "LorebookEntry"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    title: Mapped[str] = mapped_column(String(255))
    entry_type: Mapped[str] = mapped_column("entryType", String(50))
    content: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    priority: Mapped[int] = mapped_column(Integer, default=50)

    project: Mapped[ProjectModel] = relationship(back_populates="lorebook_entries")


class ChapterModel(TimestampMixin, Base):
    __tablename__ = "Chapter"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    volume_id: Mapped[uuid.UUID | None] = mapped_column("volumeId", UUID(as_uuid=True), nullable=True)
    chapter_no: Mapped[int] = mapped_column("chapterNo", Integer)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    objective: Mapped[str | None] = mapped_column(Text, nullable=True)
    conflict: Mapped[str | None] = mapped_column(Text, nullable=True)
    reveal_points: Mapped[str | None] = mapped_column("revealPoints", Text, nullable=True)
    foreshadow_plan: Mapped[str | None] = mapped_column("foreshadowPlan", Text, nullable=True)
    outline: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        SqlEnum("planned", "drafted", "reviewed", name="ChapterStatus", create_type=False),
        default="planned",
    )
    expected_word_count: Mapped[int | None] = mapped_column("expectedWordCount", Integer, nullable=True)
    actual_word_count: Mapped[int | None] = mapped_column("actualWordCount", Integer, nullable=True)
    timeline_seq: Mapped[int | None] = mapped_column("timelineSeq", Integer, nullable=True)

    project: Mapped[ProjectModel] = relationship(back_populates="chapters")
    drafts: Mapped[list[ChapterDraftModel]] = relationship(back_populates="chapter")


class ChapterDraftModel(Base):
    __tablename__ = "ChapterDraft"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chapter_id: Mapped[uuid.UUID] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="CASCADE"),
    )
    version_no: Mapped[int] = mapped_column("versionNo", Integer)
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(50), default="ai")
    model_info: Mapped[dict] = mapped_column("modelInfo", JSON, default=dict)
    generation_context: Mapped[dict] = mapped_column("generationContext", JSON, default=dict)
    is_current: Mapped[bool] = mapped_column("isCurrent", Boolean, default=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column("createdBy", UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime(timezone=True), server_default=func.now())

    chapter: Mapped[ChapterModel] = relationship(back_populates="drafts")


class MemoryChunkModel(Base):
    __tablename__ = "MemoryChunk"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    source_type: Mapped[str] = mapped_column("sourceType", String(50))
    source_id: Mapped[uuid.UUID] = mapped_column("sourceId", UUID(as_uuid=True))
    memory_type: Mapped[str] = mapped_column("memoryType", String(50))
    content: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    source_trace: Mapped[dict] = mapped_column("sourceTrace", JSON, default=dict)
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    importance_score: Mapped[int] = mapped_column("importanceScore", Integer, default=50)
    freshness_score: Mapped[int] = mapped_column("freshnessScore", Integer, default=50)
    recency_score: Mapped[int] = mapped_column("recencyScore", Integer, default=50)
    status: Mapped[str] = mapped_column(String(50), default="auto")
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        "updatedAt",
        DateTime(timezone=True),
        default=func.now(),
        onupdate=func.now(),
    )


class StoryEventModel(TimestampMixin, Base):
    __tablename__ = "StoryEvent"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    chapter_id: Mapped[uuid.UUID] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="CASCADE"),
    )
    chapter_no: Mapped[int | None] = mapped_column("chapterNo", Integer, nullable=True)
    source_draft_id: Mapped[uuid.UUID | None] = mapped_column("sourceDraftId", UUID(as_uuid=True), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    event_type: Mapped[str] = mapped_column("eventType", String(50))
    description: Mapped[str] = mapped_column(Text)
    participants: Mapped[list[str]] = mapped_column(JSON, default=list)
    timeline_seq: Mapped[int | None] = mapped_column("timelineSeq", Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="detected")
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)


class CharacterStateSnapshotModel(TimestampMixin, Base):
    __tablename__ = "CharacterStateSnapshot"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    chapter_id: Mapped[uuid.UUID] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="CASCADE"),
    )
    chapter_no: Mapped[int | None] = mapped_column("chapterNo", Integer, nullable=True)
    source_draft_id: Mapped[uuid.UUID | None] = mapped_column("sourceDraftId", UUID(as_uuid=True), nullable=True)
    character_id: Mapped[uuid.UUID | None] = mapped_column("characterId", UUID(as_uuid=True), nullable=True)
    character_name: Mapped[str] = mapped_column("characterName", String(100))
    state_type: Mapped[str] = mapped_column("stateType", String(50))
    state_value: Mapped[str] = mapped_column("stateValue", Text)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="auto")
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)


class ForeshadowTrackModel(TimestampMixin, Base):
    """Foreshadow tracking — scope/source distinguish guided-planned vs auto-extracted.
    scope: 'arc' | 'volume' | 'chapter' — breadth of the foreshadow.
    source: 'guided' | 'auto_extracted' | 'manual' — creation origin.
    metadata JSON contains: technique, plantChapter, revealChapter, involvedCharacters, payoff."""
    __tablename__ = "ForeshadowTrack"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    # chapterId is nullable — guided foreshadows may not be tied to a specific chapter
    chapter_id: Mapped[uuid.UUID | None] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="CASCADE"),
        nullable=True,
    )
    chapter_no: Mapped[int | None] = mapped_column("chapterNo", Integer, nullable=True)
    source_draft_id: Mapped[uuid.UUID | None] = mapped_column("sourceDraftId", UUID(as_uuid=True), nullable=True)
    title: Mapped[str] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="planned")
    # Guided wizard fields
    scope: Mapped[str] = mapped_column(String(20), default="chapter")
    source: Mapped[str] = mapped_column(String(30), default="manual")
    first_seen_chapter_no: Mapped[int | None] = mapped_column("firstSeenChapterNo", Integer, nullable=True)
    last_seen_chapter_no: Mapped[int | None] = mapped_column("lastSeenChapterNo", Integer, nullable=True)
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)


class ValidationIssueModel(Base):
    __tablename__ = "ValidationIssue"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    chapter_id: Mapped[uuid.UUID | None] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="SET NULL"),
        nullable=True,
    )
    issue_type: Mapped[str] = mapped_column("issueType", String(100))
    severity: Mapped[str] = mapped_column(
        SqlEnum("error", "warning", "info", name="ValidationSeverity", create_type=False)
    )
    entity_type: Mapped[str | None] = mapped_column("entityType", String(50), nullable=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column("entityId", UUID(as_uuid=True), nullable=True)
    message: Mapped[str] = mapped_column(Text)
    evidence: Mapped[list[dict]] = mapped_column(JSON, default=list)
    suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="open")
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column("resolvedAt", DateTime(timezone=True), nullable=True)


class GenerationJobModel(Base):
    __tablename__ = "GenerationJob"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    chapter_id: Mapped[uuid.UUID | None] = mapped_column(
        "chapterId",
        UUID(as_uuid=True),
        ForeignKey("Chapter.id", ondelete="SET NULL"),
        nullable=True,
    )
    job_type: Mapped[str] = mapped_column("jobType", String(50))
    target_type: Mapped[str] = mapped_column("targetType", String(50))
    target_id: Mapped[uuid.UUID] = mapped_column("targetId", UUID(as_uuid=True))
    status: Mapped[str] = mapped_column(
        SqlEnum("queued", "running", "completed", "failed", name="JobStatus", create_type=False),
        default="queued",
    )
    request_payload: Mapped[dict] = mapped_column("requestPayload", JSON, default=dict)
    response_payload: Mapped[dict] = mapped_column("responsePayload", JSON, default=dict)
    retrieval_payload: Mapped[dict] = mapped_column("retrievalPayload", JSON, default=dict)
    prompt_snapshot: Mapped[str | None] = mapped_column("promptSnapshot", Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column("errorMessage", Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column("startedAt", DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column("finishedAt", DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column("createdAt", DateTime(timezone=True), server_default=func.now())

    project: Mapped[ProjectModel] = relationship(back_populates="generation_jobs")


class VolumeModel(TimestampMixin, Base):
    """Volume entity — populated by guided wizard's 'guided_volume' step.
    Contains narrative arc info (synopsis, objective) for each volume."""
    __tablename__ = "Volume"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    volume_no: Mapped[int] = mapped_column("volumeNo", Integer)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    synopsis: Mapped[str | None] = mapped_column(Text, nullable=True)
    objective: Mapped[str | None] = mapped_column(Text, nullable=True)
    chapter_count: Mapped[int | None] = mapped_column("chapterCount", Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="planned")

    project: Mapped[ProjectModel] = relationship(back_populates="volumes")


class StyleProfileModel(TimestampMixin, Base):
    """Writing style profile — populated by guided wizard's 'guided_style' step.
    Controls POV, tense, prose style, and pacing for chapter generation."""
    __tablename__ = "StyleProfile"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
    )
    name: Mapped[str] = mapped_column(String(100))
    pov: Mapped[str | None] = mapped_column(Text, nullable=True)
    tense: Mapped[str | None] = mapped_column(Text, nullable=True)
    prose_style: Mapped[str | None] = mapped_column("proseStyle", Text, nullable=True)
    pacing: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Numeric sliders (not critical for prompt building, but mapped for completeness)
    dialogue_density: Mapped[int] = mapped_column("dialogueDensity", Integer, default=50)
    narration_density: Mapped[int] = mapped_column("narrationDensity", Integer, default=50)
    description_density: Mapped[int] = mapped_column("descriptionDensity", Integer, default=50)
    darkness_level: Mapped[int] = mapped_column("darknessLevel", Integer, default=50)
    humor_level: Mapped[int] = mapped_column("humorLevel", Integer, default=10)
    emotional_intensity: Mapped[int] = mapped_column("emotionalIntensity", Integer, default=50)

    project: Mapped[ProjectModel] = relationship(back_populates="style_profiles")


class PromptTemplateModel(TimestampMixin, Base):
    """Prompt template — stores system/user prompts for different pipeline steps.
    stepKey: 'write_chapter' | 'polish_chapter' | 'outline' | guided steps.
    projectId is NULL for global defaults, set for project-specific overrides."""
    __tablename__ = "PromptTemplate"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        "projectId",
        UUID(as_uuid=True),
        ForeignKey("Project.id", ondelete="CASCADE"),
        nullable=True,
    )
    step_key: Mapped[str] = mapped_column("stepKey", String(50))
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    system_prompt: Mapped[str] = mapped_column("systemPrompt", Text)
    user_template: Mapped[str] = mapped_column("userTemplate", Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_default: Mapped[bool] = mapped_column("isDefault", Boolean, default=False)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    effect_preview: Mapped[str | None] = mapped_column("effectPreview", Text, nullable=True)


class LlmProviderModel(TimestampMixin, Base):
    """LLM provider configuration — stores OpenAI-Compatible connection details.
    isDefault: when True, this provider is used for steps without explicit routing."""
    __tablename__ = "LlmProvider"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100))
    provider_type: Mapped[str] = mapped_column("providerType", String(50), default="openai_compatible")
    base_url: Mapped[str] = mapped_column("baseUrl", String(500))
    api_key: Mapped[str] = mapped_column("apiKey", Text)
    default_model: Mapped[str] = mapped_column("defaultModel", String(200))
    extra_config: Mapped[dict] = mapped_column("extraConfig", JSON, default=dict)
    is_default: Mapped[bool] = mapped_column("isDefault", Boolean, default=False)
    is_active: Mapped[bool] = mapped_column("isActive", Boolean, default=True)

    routings: Mapped[list[LlmRoutingModel]] = relationship(back_populates="provider")


class LlmRoutingModel(TimestampMixin, Base):
    """Step → Provider routing. appStep is one of: guided, generate, polish."""
    __tablename__ = "LlmRouting"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    app_step: Mapped[str] = mapped_column("appStep", String(50), unique=True)
    provider_id: Mapped[uuid.UUID] = mapped_column(
        "providerId",
        UUID(as_uuid=True),
        ForeignKey("LlmProvider.id", ondelete="CASCADE"),
    )
    model_override: Mapped[str | None] = mapped_column("modelOverride", String(200), nullable=True)
    params_override: Mapped[dict] = mapped_column("paramsOverride", JSON, default=dict)

    provider: Mapped[LlmProviderModel] = relationship(back_populates="routings")

