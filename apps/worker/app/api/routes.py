from fastapi import APIRouter

from app.core.logging import get_logger, log_event
from app.models.schemas import (
    GenerateChapterJobRequest,
    GenerateChapterJobResult,
    MemoryRebuildRequest,
    MemoryRebuildResult,
)
from app.pipelines.generate_chapter import GenerateChapterPipeline
from app.pipelines.rebuild_memory import RebuildMemoryPipeline

router = APIRouter()
pipeline = GenerateChapterPipeline()
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
