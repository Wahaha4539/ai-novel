from fastapi import APIRouter

from app.core.logging import get_logger, log_event
from app.models.schemas import (
    GenerateChapterJobRequest,
    GenerateChapterJobResult,
    MemoryRebuildRequest,
    MemoryRebuildResult,
    PolishChapterRequest,
    PolishChapterResult,
)
from app.pipelines.generate_chapter import GenerateChapterPipeline
from app.pipelines.polish_chapter import PolishChapterPipeline
from app.pipelines.rebuild_memory import RebuildMemoryPipeline
from app.repositories.llm_provider_repo import LlmProviderRepository

router = APIRouter()
pipeline = GenerateChapterPipeline()
polish_pipeline = PolishChapterPipeline()
memory_rebuild_pipeline = RebuildMemoryPipeline()
logger = get_logger(__name__)


@router.post("/internal/jobs/generate-chapter", response_model=GenerateChapterJobResult)
def generate_chapter_job(payload: GenerateChapterJobRequest) -> GenerateChapterJobResult:
    log_context = {
        "requestId": payload.request_id,
        "jobId": payload.job_id,
        "projectId": payload.project_id,
        "chapterId": payload.chapter_id,
    }
    log_event(logger, "generation.request.received", **log_context)

    try:
        result = pipeline.run(payload)
        log_event(
            logger,
            "generation.request.completed",
            **log_context,
            draftId=result.draft_id or None,
            actualWordCount=result.actual_word_count,
        )
        return result
    except Exception as exc:
        log_event(logger, "generation.request.failed", level="error", **log_context, error=str(exc))
        raise


@router.post("/internal/jobs/polish-chapter", response_model=PolishChapterResult)
def polish_chapter_job(payload: PolishChapterRequest) -> PolishChapterResult:
    """Polish an existing chapter draft using LLM-powered rewriting."""
    log_context = {
        "projectId": payload.project_id,
        "chapterId": payload.chapter_id,
    }
    log_event(logger, "polish.request.received", **log_context)

    try:
        result = polish_pipeline.run(
            project_id=payload.project_id,
            chapter_id=payload.chapter_id,
            user_instruction=payload.user_instruction,
        )
        log_event(
            logger,
            "polish.request.completed",
            **log_context,
            draftId=result["draftId"],
            polishedWordCount=result["polishedWordCount"],
        )
        return PolishChapterResult(**result)
    except Exception as exc:
        log_event(logger, "polish.request.failed", level="error", **log_context, error=str(exc))
        raise


@router.post("/internal/memory/rebuild", response_model=MemoryRebuildResult)
def rebuild_memory(payload: MemoryRebuildRequest) -> MemoryRebuildResult:
    log_context = {
        "projectId": payload.project_id,
        "chapterId": payload.chapter_id,
        "dryRun": payload.dry_run,
    }
    log_event(logger, "memory.rebuild.request.received", **log_context)

    try:
        result = memory_rebuild_pipeline.run(payload)
        log_event(
            logger,
            "memory.rebuild.request.completed",
            **log_context,
            processedChapterCount=result.processed_chapter_count,
        )
        return result
    except Exception as exc:
        log_event(logger, "memory.rebuild.request.failed", level="error", **log_context, error=str(exc))
        raise


@router.post("/internal/llm-config/reload")
def reload_llm_config() -> dict[str, int | bool]:
    """Force worker to reload DB-backed LLM config after API-side config changes."""
    LlmProviderRepository.load_cache()
    status = LlmProviderRepository.cache_status()
    log_event(logger, "llm.config.reloaded", **status)
    return status


