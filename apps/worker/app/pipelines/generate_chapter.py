from dataclasses import asdict

from app.core.logging import get_logger, log_event
from app.models.dto import PromptBuildInput
from app.models.enums import ValidationSeverity
from app.models.schemas import GenerateChapterJobRequest, GenerateChapterJobResult, ValidationIssue
from app.core.config import get_settings
from app.repositories.chapter_repo import ChapterRepository
from app.repositories.character_repo import CharacterRepository
from app.repositories.character_state_repo import CharacterStateRepository
from app.repositories.draft_repo import DraftRepository
from app.repositories.foreshadow_repo import ForeshadowRepository
from app.repositories.memory_repo import MemoryRepository
from app.repositories.project_repo import ProjectRepository
from app.repositories.story_event_repo import StoryEventRepository
from app.repositories.style_profile_repo import StyleProfileRepository
from app.repositories.validation_repo import ValidationRepository
from app.repositories.volume_repo import VolumeRepository
from app.services.fact_extractor import FactExtractor
from app.services.cache_service import CacheService
from app.services.llm_gateway import LlmGateway
from app.services.memory_writer import MemoryWriter
from app.services.prompt_builder import PromptBuilder
from app.services.retrieval_service import RetrievalService
from app.services.summary_service import SummaryService
from app.services.validation_engine import ValidationEngine

logger = get_logger(__name__)


class GenerateChapterPipeline:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.project_repo = ProjectRepository()
        self.chapter_repo = ChapterRepository()
        self.character_repo = CharacterRepository()
        self.character_state_repo = CharacterStateRepository()
        self.draft_repo = DraftRepository()
        self.foreshadow_repo = ForeshadowRepository()
        self.memory_repo = MemoryRepository()
        self.validation_repo = ValidationRepository()
        self.story_event_repo = StoryEventRepository()
        # New repositories for guided wizard context
        self.volume_repo = VolumeRepository()
        self.style_profile_repo = StyleProfileRepository()
        self.retrieval_service = RetrievalService()
        self.cache_service = CacheService()
        self.prompt_builder = PromptBuilder()
        self.llm_gateway = LlmGateway()
        self.summary_service = SummaryService()
        self.fact_extractor = FactExtractor()
        self.validation_engine = ValidationEngine()
        self.memory_writer = MemoryWriter()

    @staticmethod
    def _serialize_hits(hits: list) -> list[dict]:
        return [asdict(hit) for hit in hits]

    def run(self, request: GenerateChapterJobRequest) -> GenerateChapterJobResult:
        log_context = {
            "requestId": request.request_id,
            "jobId": request.job_id,
            "projectId": request.project_id,
            "chapterId": request.chapter_id,
        }
        log_event(logger, "generation.pipeline.started", **log_context)

        # --- Load project and chapter base context ---
        project = self.cache_service.get_project_snapshot(
            request.project_id,
            lambda: self.project_repo.get(request.project_id),
        )
        chapter_snapshot = self.chapter_repo.get_snapshot(
            chapter_id=request.chapter_id,
            project_id=request.project_id,
        )
        chapter = {
            **chapter_snapshot,
            "expectedWordCount": chapter_snapshot.get("expectedWordCount")
            or request.request_payload.word_count
            or 3500,
        }
        chapter_no = chapter.get("chapterNo") or 1

        # --- Load volume context (narrative arc for this volume) ---
        volume_info = self.volume_repo.get_by_chapter(request.project_id, request.chapter_id)
        volume_no = volume_info.get("volumeNo") if volume_info else None

        # --- Load style profile (user's chosen writing style) ---
        style_profile_db = self.style_profile_repo.get_default(request.project_id)
        style_profile = style_profile_db or {
            "pov": "third_limited",
            "proseStyle": "冷峻、克制",
            "pacing": "medium",
        }

        # --- Load characters filtered by volume scope ---
        related_characters = self.character_repo.list_related(
            request.project_id, volume_no=volume_no
        )

        # --- Load planned foreshadows from guided wizard ---
        planned_foreshadows = self.foreshadow_repo.list_planned_for_chapter(
            request.project_id, chapter_no
        )

        # --- Load previous chapters' full text for continuity ---
        previous_chapters = self.draft_repo.get_previous_chapter_drafts(
            request.project_id, chapter_no, limit=3, max_chars=6000
        )

        log_event(logger, "generation.pipeline.context_loaded", **log_context,
                  volumeNo=volume_no, characterCount=len(related_characters),
                  foreshadowCount=len(planned_foreshadows),
                  previousChapterCount=len(previous_chapters),
                  hasStyleProfile=style_profile_db is not None)

        # --- Build retrieval context ---
        context = {
            "queryText": request.request_payload.instruction or chapter["objective"],
            "objective": chapter["objective"],
            "conflict": chapter["conflict"],
            "characters": [item["name"] for item in related_characters],
        }
        hard_facts = []
        # Inject style-aware POV constraint
        pov_desc = style_profile.get("pov") or "第三人称限制"
        hard_facts.append(f"POV 必须维持 {pov_desc} 视角。")
        if related_characters:
            hard_facts.append(f"当前项目已登记角色：{', '.join(item['name'] for item in related_characters[:6])}。")
        if chapter.get("conflict"):
            hard_facts.append(f"本章核心冲突：{chapter['conflict']}")

        retrieval_bundle = self.retrieval_service.retrieve_bundle(
            request.project_id,
            context,
            include_lorebook=request.request_payload.include_lorebook,
            include_memory=request.request_payload.include_memory,
        )
        lorebook_hits = retrieval_bundle["lorebookHits"]
        memory_hits = retrieval_bundle["memoryHits"]
        ranked_hits = retrieval_bundle["rankedHits"]

        precheck_issues = (
            self.validation_engine.precheck_chapter(context, hard_facts)
            if request.request_payload.validate_before_write
            else []
        )
        self.validation_repo.save_many(request.project_id, request.chapter_id, precheck_issues)
        blocking_issues = [issue for issue in precheck_issues if issue.severity == ValidationSeverity.ERROR]
        if blocking_issues:
            log_event(
                logger,
                "generation.pipeline.precheck_blocked",
                **log_context,
                retrievalCount=len(ranked_hits),
                blockingIssueCount=len(blocking_issues),
            )
            return GenerateChapterJobResult(
                draftId="",
                summary="precheck_blocked",
                text="",
                actualWordCount=0,
                retrievalPayload={"hits": self._serialize_hits(ranked_hits)},
                validationIssues=blocking_issues,
            )

        # --- Build prompt with all enriched context ---
        prompt = self.prompt_builder.build_chapter_prompt(
            PromptBuildInput(
                project=project,
                chapter=chapter,
                style_profile=style_profile,
                hard_facts=hard_facts,
                lorebook_hits=lorebook_hits,
                memory_hits=ranked_hits,
                outline_bundle={
                    "chapterOutline": chapter.get("outline"),
                    "relatedCharacters": related_characters,
                },
                user_instruction=request.request_payload.instruction,
                target_word_count=request.request_payload.word_count,
                volume_info=volume_info,
                planned_foreshadows=planned_foreshadows,
                previous_chapters=previous_chapters,
            )
        )

        text = self.llm_gateway.generate(
            prompt,
            target_word_count=request.request_payload.word_count,
        )

        draft = self.draft_repo.create_chapter_draft(
            chapter_id=request.chapter_id,
            content=text,
            model_info={
                "provider": "openai-compatible",
                "model": self.settings.llm_model,
                "baseUrl": self.settings.llm_base_url,
            },
            generation_context={
                "jobId": request.job_id,
                "retrievalCount": len(ranked_hits),
                "promptDebug": prompt.debug,
            },
        )

        summary = self.summary_service.summarize_chapter(text, project, chapter)
        events = self.fact_extractor.extract_events(text, project, chapter)
        states = self.fact_extractor.extract_character_states(text, project, chapter)
        foreshadows = self.fact_extractor.extract_foreshadows(text, project, chapter)

        # --- Load accumulated narrative context for cross-chapter validation ---
        character_states_history = self.character_state_repo.list_before_chapter(
            request.project_id, chapter_no
        )
        story_events_history = self.story_event_repo.list_before_chapter(
            request.project_id, chapter_no
        )
        active_foreshadows = self.foreshadow_repo.list_planned_for_chapter(
            request.project_id, chapter_no
        )

        post_issues = (
            self.validation_engine.validate_generated_text(
                text, chapter,
                characters=related_characters,
                character_states=character_states_history,
                story_events=story_events_history,
                foreshadows=active_foreshadows,
                previous_chapters=previous_chapters,
            )
            if request.request_payload.validate_after_write
            else []
        )
        self.validation_repo.save_many(request.project_id, request.chapter_id, post_issues)

        character_lookup = {item["name"]: item["id"] for item in related_characters}
        summary_memory = self.memory_writer.write_summary_memory(request.project_id, chapter, summary)
        event_memories = self.memory_writer.write_event_memories(request.project_id, chapter, events)
        state_memories = self.memory_writer.write_character_state_memories(request.project_id, chapter, states)
        foreshadow_memories = self.memory_writer.write_foreshadow_memories(request.project_id, chapter, foreshadows)
        memory_write_result = self.memory_repo.replace_for_source(
            request.project_id,
            "chapter",
            request.chapter_id,
            [summary_memory, *event_memories, *state_memories, *foreshadow_memories],
        )
        event_write_result = self.story_event_repo.replace_for_chapter(
            request.project_id,
            request.chapter_id,
            chapter.get("chapterNo"),
            draft["id"],
            events,
        )
        state_write_result = self.character_state_repo.replace_for_chapter(
            request.project_id,
            request.chapter_id,
            chapter.get("chapterNo"),
            draft["id"],
            states,
            character_lookup,
        )
        foreshadow_write_result = self.foreshadow_repo.replace_for_chapter(
            request.project_id,
            request.chapter_id,
            chapter.get("chapterNo"),
            draft["id"],
            foreshadows,
        )
        self.cache_service.invalidate_project_recall_results(request.project_id)

        log_event(
            logger,
            "generation.pipeline.completed",
            **log_context,
            retrievalCount=len(ranked_hits),
            validationIssueCount=len(precheck_issues) + len(post_issues),
            writtenMemoryCount=len(memory_write_result["created"]),
            draftId=draft["id"],
            actualWordCount=len(text),
        )

        return GenerateChapterJobResult(
            draftId=draft["id"],
            summary=summary,
            text=text,
            actualWordCount=len(text),
            retrievalPayload={
                "hits": self._serialize_hits(ranked_hits),
                "events": events,
                "states": states,
                "foreshadows": foreshadows,
                "writtenMemories": memory_write_result["created"],
                "writtenFacts": {
                    "storyEvents": event_write_result["created"],
                    "characterStates": state_write_result["created"],
                    "foreshadows": foreshadow_write_result["created"],
                },
            },
            validationIssues=[*precheck_issues, *post_issues],
        )
