import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { GenerationModule } from '../generation/generation.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { QualityReportsModule } from '../quality-reports/quality-reports.module';
import { ValidationModule } from '../validation/validation.module';
import { AiQualityReviewTool } from './tools/ai-quality-review.tool';
import { AlignChapterTimelinePreviewTool } from './tools/align-chapter-timeline-preview.tool';
import { AnalyzeSourceTextTool } from './tools/analyze-source-text.tool';
import { AutoRepairChapterTool } from './tools/auto-repair-chapter.tool';
import { BuildImportBriefTool } from './tools/build-import-brief.tool';
import { BuildImportPreviewTool } from './tools/build-import-preview.tool';
import { CharacterConsistencyCheckTool } from './tools/character-consistency-check.tool';
import { CollectChapterContextTool } from './tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from './tools/collect-task-context.tool';
import { CrossTargetConsistencyCheckTool } from './tools/cross-target-consistency-check.tool';
import { GenerateContinuityPreviewTool, PersistContinuityChangesTool, ValidateContinuityChangesTool } from './tools/continuity-changes.tool';
import { EchoReportTool } from './tools/echo-report.tool';
import { ExtractChapterFactsTool } from './tools/extract-chapter-facts.tool';
import { FactValidationTool } from './tools/fact-validation.tool';
import { FactsModule } from '../facts/facts.module';
import { GenerateTimelinePreviewTool } from './tools/generate-timeline-preview.tool';
import { GenerateGuidedStepPreviewTool } from './tools/generate-guided-step-preview.tool';
import { GenerateChapterCraftBriefPreviewTool, PersistChapterCraftBriefTool, ValidateChapterCraftBriefTool } from './tools/chapter-craft-brief-tools.tool';
import { SegmentChapterOutlineBatchesTool } from './tools/chapter-outline-batch-tools.tool';
import { GenerateChapterOutlinePreviewTool, MergeChapterOutlinePreviewsTool } from './tools/chapter-outline-preview-tools.tool';
import { GenerateImportCharactersPreviewTool } from './tools/generate-import-characters-preview.tool';
import { GenerateImportOutlinePreviewTool } from './tools/generate-import-outline-preview.tool';
import { GenerateImportProjectProfilePreviewTool } from './tools/generate-import-project-profile-preview.tool';
import { GenerateImportWorldbuildingPreviewTool } from './tools/generate-import-worldbuilding-preview.tool';
import { GenerateImportWritingRulesPreviewTool } from './tools/generate-import-writing-rules-preview.tool';
import { GenerateOutlinePreviewTool } from './tools/generate-outline-preview.tool';
import { GenerateStoryBiblePreviewTool } from './tools/generate-story-bible-preview.tool';
import { GenerateStoryUnitsPreviewTool, PersistStoryUnitsTool } from './tools/generate-story-units-preview.tool';
import { GenerateVolumeOutlinePreviewTool } from './tools/generate-volume-outline-preview.tool';
import { GenerateWorldbuildingPreviewTool } from './tools/generate-worldbuilding-preview.tool';
import { GuidedModule } from '../guided/guided.module';
import { InspectProjectContextTool } from './tools/inspect-project-context.tool';
import { MergeImportPreviewsTool } from './tools/merge-import-previews.tool';
import { PersistVolumeCharacterCandidatesTool } from './tools/persist-volume-character-candidates.tool';
import { PersistOutlineTool } from './tools/persist-outline.tool';
import { PersistVolumeOutlineTool } from './tools/persist-volume-outline.tool';
import { PersistGuidedStepResultTool } from './tools/persist-guided-step-result.tool';
import { PersistProjectAssetsTool } from './tools/persist-project-assets.tool';
import { PersistStoryBibleTool } from './tools/persist-story-bible.tool';
import { PersistTimelineEventsTool } from './tools/persist-timeline-events.tool';
import { PersistWorldbuildingTool } from './tools/persist-worldbuilding.tool';
import { PlotConsistencyCheckTool } from './tools/plot-consistency-check.tool';
import { PolishChapterTool } from './tools/polish-chapter.tool';
import { PostProcessChapterTool } from './tools/postprocess-chapter.tool';
import { ReadSourceDocumentTool } from './tools/read-source-document.tool';
import { ReportResultTool } from './tools/report-result.tool';
import { RebuildMemoryTool } from './tools/rebuild-memory.tool';
import { ReviewMemoryTool } from './tools/review-memory.tool';
import { ResolveChapterTool } from './tools/resolve-chapter.tool';
import { ResolveCharacterTool } from './tools/resolve-character.tool';
import { RewriteChapterTool } from './tools/rewrite-chapter.tool';
import { GenerateSceneCardsPreviewTool, ListSceneCardsTool, PersistSceneCardsTool, UpdateSceneCardTool, ValidateSceneCardsTool } from './tools/scene-card-tools.tool';
import { ValidateImportedAssetsTool } from './tools/validate-imported-assets.tool';
import { ValidateGuidedStepPreviewTool } from './tools/validate-guided-step-preview.tool';
import { ValidateOutlineTool } from './tools/validate-outline.tool';
import { ValidateStoryBibleTool } from './tools/validate-story-bible.tool';
import { ValidateTimelinePreviewTool } from './tools/validate-timeline-preview.tool';
import { ValidateWorldbuildingTool } from './tools/validate-worldbuilding.tool';
import { WriteChapterTool } from './tools/write-chapter.tool';
import { WriteChapterSeriesTool } from './tools/write-chapter-series.tool';
import { ToolRegistryService } from './tool-registry.service';
import { RelationshipGraphService } from './relationship-graph.service';

@Module({
  imports: [PrismaModule, LlmModule, GenerationModule, ValidationModule, MemoryModule, FactsModule, GuidedModule, QualityReportsModule],
  providers: [ToolRegistryService, RelationshipGraphService, EchoReportTool, ResolveChapterTool, ResolveCharacterTool, CharacterConsistencyCheckTool, PlotConsistencyCheckTool, CollectChapterContextTool, CollectTaskContextTool, GenerateContinuityPreviewTool, ValidateContinuityChangesTool, PersistContinuityChangesTool, GenerateTimelinePreviewTool, AlignChapterTimelinePreviewTool, ValidateTimelinePreviewTool, PersistTimelineEventsTool, WriteChapterTool, RewriteChapterTool, WriteChapterSeriesTool, PostProcessChapterTool, PolishChapterTool, FactValidationTool, AutoRepairChapterTool, AiQualityReviewTool, ExtractChapterFactsTool, RebuildMemoryTool, ReviewMemoryTool, InspectProjectContextTool, GenerateGuidedStepPreviewTool, ValidateGuidedStepPreviewTool, PersistGuidedStepResultTool, GenerateVolumeOutlinePreviewTool, GenerateStoryUnitsPreviewTool, PersistStoryUnitsTool, GenerateOutlinePreviewTool, SegmentChapterOutlineBatchesTool, GenerateChapterOutlinePreviewTool, MergeChapterOutlinePreviewsTool, GenerateWorldbuildingPreviewTool, GenerateStoryBiblePreviewTool, ValidateOutlineTool, ValidateWorldbuildingTool, ValidateStoryBibleTool, PersistWorldbuildingTool, PersistStoryBibleTool, PersistOutlineTool, PersistVolumeOutlineTool, PersistVolumeCharacterCandidatesTool, GenerateChapterCraftBriefPreviewTool, ValidateChapterCraftBriefTool, PersistChapterCraftBriefTool, ListSceneCardsTool, GenerateSceneCardsPreviewTool, ValidateSceneCardsTool, PersistSceneCardsTool, UpdateSceneCardTool, ReadSourceDocumentTool, AnalyzeSourceTextTool, BuildImportBriefTool, BuildImportPreviewTool, GenerateImportProjectProfilePreviewTool, GenerateImportOutlinePreviewTool, GenerateImportCharactersPreviewTool, GenerateImportWorldbuildingPreviewTool, GenerateImportWritingRulesPreviewTool, MergeImportPreviewsTool, CrossTargetConsistencyCheckTool, ValidateImportedAssetsTool, PersistProjectAssetsTool, ReportResultTool],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
