from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import ValidationSeverity


class GenerateChapterPayload(BaseModel):
    mode: str = "draft"
    instruction: str | None = None
    word_count: int | None = Field(default=None, alias="wordCount")
    style_profile_id: str | None = Field(default=None, alias="styleProfileId")
    model_profile_id: str | None = Field(default=None, alias="modelProfileId")
    include_lorebook: bool = Field(default=True, alias="includeLorebook")
    include_memory: bool = Field(default=True, alias="includeMemory")
    validate_before_write: bool = Field(default=True, alias="validateBeforeWrite")
    validate_after_write: bool = Field(default=True, alias="validateAfterWrite")
    stream: bool = False

    model_config = ConfigDict(populate_by_name=True, protected_namespaces=())


class GenerateChapterJobRequest(BaseModel):
    request_id: str | None = Field(default=None, alias="requestId")
    job_id: str = Field(alias="jobId")
    project_id: str = Field(alias="projectId")
    chapter_id: str = Field(alias="chapterId")
    request_payload: GenerateChapterPayload = Field(alias="requestPayload")

    model_config = ConfigDict(populate_by_name=True)


class ValidationIssue(BaseModel):
    severity: ValidationSeverity
    issue_type: str = Field(alias="issueType")
    message: str
    suggestion: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class GenerateChapterJobResult(BaseModel):
    draft_id: str = Field(alias="draftId")
    summary: str
    text: str
    actual_word_count: int = Field(alias="actualWordCount")
    retrieval_payload: dict[str, Any] = Field(default_factory=dict, alias="retrievalPayload")
    validation_issues: list[ValidationIssue] = Field(default_factory=list, alias="validationIssues")

    model_config = ConfigDict(populate_by_name=True)


class JobAcceptedResult(BaseModel):
    """Immediate acknowledgement for background worker dispatch endpoints."""
    accepted: bool = True
    job_id: str = Field(alias="jobId")

    model_config = ConfigDict(populate_by_name=True)


class MemoryRebuildRequest(BaseModel):
    project_id: str = Field(alias="projectId")
    chapter_id: str | None = Field(default=None, alias="chapterId")
    dry_run: bool = Field(default=False, alias="dryRun")

    model_config = ConfigDict(populate_by_name=True)


class MemoryRebuildResult(BaseModel):
    project_id: str = Field(alias="projectId")
    chapter_id: str | None = Field(default=None, alias="chapterId")
    dry_run: bool = Field(alias="dryRun")
    processed_chapter_count: int = Field(alias="processedChapterCount")
    failed_chapter_count: int = Field(default=0, alias="failedChapterCount")
    deleted: dict[str, int]
    created: dict[str, int]
    failed_chapters: list[dict[str, Any]] = Field(default_factory=list, alias="failedChapters")
    diff_summary: dict[str, dict[str, int]] = Field(default_factory=dict, alias="diffSummary")
    chapters: list[dict[str, Any]] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class PolishChapterRequest(BaseModel):
    """Request payload for chapter polish endpoint."""
    project_id: str = Field(alias="projectId")
    chapter_id: str = Field(alias="chapterId")
    user_instruction: str | None = Field(default=None, alias="userInstruction")

    model_config = ConfigDict(populate_by_name=True)


class PolishChapterResult(BaseModel):
    """Result from chapter polish pipeline."""
    draft_id: str = Field(alias="draftId")
    original_word_count: int = Field(alias="originalWordCount")
    polished_word_count: int = Field(alias="polishedWordCount")
    text: str

    model_config = ConfigDict(populate_by_name=True)
