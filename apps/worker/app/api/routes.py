from fastapi import APIRouter, BackgroundTasks

from app.core.logging import get_logger, log_event
from app.models.schemas import (
    GenerateChapterJobRequest,
    GenerateChapterJobResult,
    JobAcceptedResult,
    MemoryRebuildRequest,
    MemoryRebuildResult,
    PolishChapterRequest,
    PolishChapterResult,
)
from app.pipelines.generate_chapter import GenerateChapterPipeline
from app.pipelines.polish_chapter import PolishChapterPipeline
from app.pipelines.rebuild_memory import RebuildMemoryPipeline
from app.repositories.job_repo import JobRepository
from app.repositories.llm_provider_repo import LlmProviderRepository

router = APIRouter()
pipeline = GenerateChapterPipeline()
polish_pipeline = PolishChapterPipeline()
memory_rebuild_pipeline = RebuildMemoryPipeline()
job_repo = JobRepository()
logger = get_logger(__name__)


def _run_generate_chapter_background(payload: GenerateChapterJobRequest) -> None:
    """Run chapter generation after HTTP acknowledgement and persist final job state.

    This decouples the long-running LLM pipeline from the API→worker HTTP
    connection. If the client connection times out, the worker can still finish
    and the frontend will observe the final state through normal job polling.
    """
    log_context = {
        "requestId": payload.request_id,
        "jobId": payload.job_id,
        "projectId": payload.project_id,
        "chapterId": payload.chapter_id,
    }
    try:
        result = pipeline.run(payload)
        job_repo.mark_completed(
            payload.job_id,
            payload.chapter_id,
            {
                "draftId": result.draft_id,
                "summary": result.summary,
                "actualWordCount": result.actual_word_count,
            },
            result.retrieval_payload,
            result.actual_word_count,
        )
        log_event(
            logger,
            "generation.background.completed",
            **log_context,
            draftId=result.draft_id or None,
            actualWordCount=result.actual_word_count,
        )
    except Exception as exc:
        job_repo.mark_failed(payload.job_id, str(exc))
        log_event(logger, "generation.background.failed", level="error", **log_context, error=str(exc))


@router.post("/internal/jobs/generate-chapter", response_model=JobAcceptedResult, status_code=202)
def generate_chapter_job(
    payload: GenerateChapterJobRequest,
    background_tasks: BackgroundTasks,
) -> JobAcceptedResult:
    log_context = {
        "requestId": payload.request_id,
        "jobId": payload.job_id,
        "projectId": payload.project_id,
        "chapterId": payload.chapter_id,
    }
    log_event(logger, "generation.request.accepted", **log_context)
    background_tasks.add_task(_run_generate_chapter_background, payload)
    return JobAcceptedResult(jobId=payload.job_id)


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



