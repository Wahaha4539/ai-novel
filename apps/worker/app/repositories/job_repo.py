import uuid
from datetime import UTC, datetime

from sqlalchemy import update

from app.db.session import SessionLocal
from app.models.sqlalchemy_models import ChapterModel, GenerationJobModel


class JobRepository:
    """Worker-side generation job persistence helpers.

    The API process owns queue claiming, while the worker process owns final job
    completion/failure updates after the long-running pipeline finishes. This
    avoids keeping the API→worker HTTP request open for the whole generation.
    """

    def mark_completed(
        self,
        job_id: str,
        chapter_id: str,
        response_payload: dict,
        retrieval_payload: dict,
        actual_word_count: int,
    ) -> None:
        """Mark a generation job completed and update chapter draft status.

        Args:
            job_id: GenerationJob UUID to update.
            chapter_id: Chapter UUID whose latest draft was produced.
            response_payload: User-facing result metadata stored on the job.
            retrieval_payload: Retrieval/debug metadata stored on the job.
            actual_word_count: Generated chapter word count persisted on Chapter.

        Side effects:
            Updates GenerationJob.status/finishedAt and Chapter.status/actualWordCount.
        """
        finished_at = datetime.now(UTC)
        with SessionLocal.begin() as session:
            session.execute(
                update(GenerationJobModel)
                .where(GenerationJobModel.id == uuid.UUID(job_id))
                .values(
                    status="completed",
                    response_payload=response_payload,
                    retrieval_payload=retrieval_payload,
                    error_message=None,
                    finished_at=finished_at,
                )
            )
            session.execute(
                update(ChapterModel)
                .where(ChapterModel.id == uuid.UUID(chapter_id))
                .values(status="drafted", actual_word_count=actual_word_count)
            )

    def mark_failed(self, job_id: str, error_message: str) -> None:
        """Mark a generation job failed after worker-side execution error.

        Args:
            job_id: GenerationJob UUID to update.
            error_message: Error text to expose through API job polling.

        Side effects:
            Updates GenerationJob.status/errorMessage/finishedAt in PostgreSQL.
        """
        with SessionLocal.begin() as session:
            session.execute(
                update(GenerationJobModel)
                .where(GenerationJobModel.id == uuid.UUID(job_id))
                .values(
                    status="failed",
                    error_message=error_message,
                    finished_at=datetime.now(UTC),
                )
            )