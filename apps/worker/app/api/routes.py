from fastapi import APIRouter

from app.core.logging import get_logger, log_event
from app.models.schemas import GenerateChapterJobRequest, GenerateChapterJobResult
from app.pipelines.generate_chapter import GenerateChapterPipeline

router = APIRouter()
pipeline = GenerateChapterPipeline()
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
