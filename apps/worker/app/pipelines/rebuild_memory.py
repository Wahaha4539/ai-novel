from app.core.logging import get_logger, log_event
from app.models.schemas import MemoryRebuildRequest, MemoryRebuildResult
from app.repositories.character_repo import CharacterRepository
from app.repositories.character_state_repo import CharacterStateRepository
from app.repositories.draft_repo import DraftRepository
from app.repositories.foreshadow_repo import ForeshadowRepository
from app.repositories.memory_repo import MemoryRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.story_event_repo import StoryEventRepository
from app.services.cache_service import CacheService
from app.services.fact_extractor import FactExtractor
from app.services.memory_writer import MemoryWriter
from app.services.summary_service import SummaryService

logger = get_logger(__name__)


def _empty_fact_counter() -> dict[str, int]:
    return {
        "memoryChunks": 0,
        "storyEvents": 0,
        "characterStateSnapshots": 0,
        "foreshadowTracks": 0,
    }


def _build_diff_summary(deleted: dict[str, int], created: dict[str, int]) -> dict[str, dict[str, int]]:
    return {
        key: {
            "deleted": int(deleted.get(key, 0)),
            "created": int(created.get(key, 0)),
            "delta": int(created.get(key, 0)) - int(deleted.get(key, 0)),
        }
        for key in deleted.keys()
    }


class RebuildMemoryPipeline:
    def __init__(self) -> None:
        self.project_repo = ProjectRepository()
        self.character_repo = CharacterRepository()
        self.character_state_repo = CharacterStateRepository()
        self.draft_repo = DraftRepository()
        self.foreshadow_repo = ForeshadowRepository()
        self.memory_repo = MemoryRepository()
        self.story_event_repo = StoryEventRepository()
        self.cache_service = CacheService()
        self.fact_extractor = FactExtractor()
        self.memory_writer = MemoryWriter()
        self.summary_service = SummaryService()

    def run(self, request: MemoryRebuildRequest) -> MemoryRebuildResult:
        log_context = {
            "projectId": request.project_id,
            "chapterId": request.chapter_id,
            "dryRun": request.dry_run,
        }
        log_event(logger, "memory.rebuild.started", **log_context)

        project = self.project_repo.get(request.project_id)
        characters = self.character_repo.list_related(request.project_id)
        character_lookup = {item["name"]: item["id"] for item in characters}
        draft_rows = self.draft_repo.list_current_project_drafts(request.project_id, request.chapter_id)

        deleted = _empty_fact_counter()
        created = _empty_fact_counter()
        chapters: list[dict] = []
        failed_chapters: list[dict] = []

        for row in draft_rows:
            chapter = row["chapter"]
            draft = row["draft"]
            chapter_log_context = {
                **log_context,
                "currentChapterId": chapter["id"],
                "currentChapterNo": chapter.get("chapterNo"),
                "draftId": draft["id"],
            }

            try:
                text = draft["content"]
                summary = self.summary_service.summarize_chapter(text, project, chapter)
                events = self.fact_extractor.extract_events(text, project, chapter)
                states = self.fact_extractor.extract_character_states(text, project, chapter)
                foreshadows = self.fact_extractor.extract_foreshadows(text, project, chapter)

                summary_memory = self.memory_writer.write_summary_memory(request.project_id, chapter, summary)
                event_memories = self.memory_writer.write_event_memories(request.project_id, chapter, events)
                state_memories = self.memory_writer.write_character_state_memories(request.project_id, chapter, states)
                foreshadow_memories = self.memory_writer.write_foreshadow_memories(request.project_id, chapter, foreshadows)

                if request.dry_run:
                    memory_write_result = {"deleted": 0, "created": [summary_memory, *event_memories, *state_memories, *foreshadow_memories]}
                    event_write_result = {"deleted": 0, "created": events}
                    state_write_result = {"deleted": 0, "created": states}
                    foreshadow_write_result = {"deleted": 0, "created": foreshadows}
                else:
                    memory_write_result = self.memory_repo.replace_for_source(
                        request.project_id,
                        "chapter",
                        chapter["id"],
                        [summary_memory, *event_memories, *state_memories, *foreshadow_memories],
                    )
                    event_write_result = self.story_event_repo.replace_for_chapter(
                        request.project_id,
                        chapter["id"],
                        chapter.get("chapterNo"),
                        draft["id"],
                        events,
                    )
                    state_write_result = self.character_state_repo.replace_for_chapter(
                        request.project_id,
                        chapter["id"],
                        chapter.get("chapterNo"),
                        draft["id"],
                        states,
                        character_lookup,
                    )
                    foreshadow_write_result = self.foreshadow_repo.replace_for_chapter(
                        request.project_id,
                        chapter["id"],
                        chapter.get("chapterNo"),
                        draft["id"],
                        foreshadows,
                    )

                chapter_deleted = {
                    "memoryChunks": int(memory_write_result["deleted"]),
                    "storyEvents": int(event_write_result["deleted"]),
                    "characterStateSnapshots": int(state_write_result["deleted"]),
                    "foreshadowTracks": int(foreshadow_write_result["deleted"]),
                }
                chapter_created = {
                    "memoryChunks": len(memory_write_result["created"]),
                    "storyEvents": len(event_write_result["created"]),
                    "characterStateSnapshots": len(state_write_result["created"]),
                    "foreshadowTracks": len(foreshadow_write_result["created"]),
                }

                for key in deleted.keys():
                    deleted[key] += chapter_deleted[key]
                    created[key] += chapter_created[key]

                chapters.append(
                    {
                        "chapterId": chapter["id"],
                        "chapterNo": chapter.get("chapterNo"),
                        "draftId": draft["id"],
                        "summary": summary,
                        "memoryCount": chapter_created["memoryChunks"],
                        "storyEventCount": chapter_created["storyEvents"],
                        "characterStateCount": chapter_created["characterStateSnapshots"],
                        "foreshadowCount": chapter_created["foreshadowTracks"],
                        "deleted": chapter_deleted,
                        "created": chapter_created,
                        "diff": _build_diff_summary(chapter_deleted, chapter_created),
                        "status": "dry_run" if request.dry_run else "rebuilt",
                    }
                )
            except Exception as exc:
                failed_chapters.append(
                    {
                        "chapterId": chapter["id"],
                        "chapterNo": chapter.get("chapterNo"),
                        "draftId": draft["id"],
                        "error": str(exc),
                    }
                )
                log_event(logger, "memory.rebuild.chapter.failed", level="error", **chapter_log_context, error=str(exc))

        if not request.dry_run:
            self.cache_service.invalidate_project_recall_results(request.project_id)

        log_event(
            logger,
            "memory.rebuild.completed",
            **log_context,
            processedChapterCount=len(chapters),
            failedChapterCount=len(failed_chapters),
            createdMemoryChunkCount=created["memoryChunks"],
            createdStoryEventCount=created["storyEvents"],
        )

        return MemoryRebuildResult(
            projectId=request.project_id,
            chapterId=request.chapter_id,
            dryRun=request.dry_run,
            processedChapterCount=len(chapters),
            failedChapterCount=len(failed_chapters),
            deleted=deleted,
            created=created,
            failedChapters=failed_chapters,
            diffSummary=_build_diff_summary(deleted, created),
            chapters=chapters,
        )