import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { GenerationModule } from '../generation/generation.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { ValidationModule } from '../validation/validation.module';
import { AnalyzeSourceTextTool } from './tools/analyze-source-text.tool';
import { AutoRepairChapterTool } from './tools/auto-repair-chapter.tool';
import { BuildImportPreviewTool } from './tools/build-import-preview.tool';
import { CharacterConsistencyCheckTool } from './tools/character-consistency-check.tool';
import { CollectChapterContextTool } from './tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from './tools/collect-task-context.tool';
import { EchoReportTool } from './tools/echo-report.tool';
import { ExtractChapterFactsTool } from './tools/extract-chapter-facts.tool';
import { FactValidationTool } from './tools/fact-validation.tool';
import { FactsModule } from '../facts/facts.module';
import { GenerateGuidedStepPreviewTool } from './tools/generate-guided-step-preview.tool';
import { GenerateOutlinePreviewTool } from './tools/generate-outline-preview.tool';
import { GenerateWorldbuildingPreviewTool } from './tools/generate-worldbuilding-preview.tool';
import { InspectProjectContextTool } from './tools/inspect-project-context.tool';
import { PersistOutlineTool } from './tools/persist-outline.tool';
import { PersistProjectAssetsTool } from './tools/persist-project-assets.tool';
import { PersistWorldbuildingTool } from './tools/persist-worldbuilding.tool';
import { PlotConsistencyCheckTool } from './tools/plot-consistency-check.tool';
import { PolishChapterTool } from './tools/polish-chapter.tool';
import { PostProcessChapterTool } from './tools/postprocess-chapter.tool';
import { ReportResultTool } from './tools/report-result.tool';
import { RebuildMemoryTool } from './tools/rebuild-memory.tool';
import { ReviewMemoryTool } from './tools/review-memory.tool';
import { ResolveChapterTool } from './tools/resolve-chapter.tool';
import { ResolveCharacterTool } from './tools/resolve-character.tool';
import { ValidateImportedAssetsTool } from './tools/validate-imported-assets.tool';
import { ValidateOutlineTool } from './tools/validate-outline.tool';
import { ValidateWorldbuildingTool } from './tools/validate-worldbuilding.tool';
import { WriteChapterTool } from './tools/write-chapter.tool';
import { WriteChapterSeriesTool } from './tools/write-chapter-series.tool';
import { ToolRegistryService } from './tool-registry.service';
import { RelationshipGraphService } from './relationship-graph.service';

@Module({
  imports: [PrismaModule, LlmModule, GenerationModule, ValidationModule, MemoryModule, FactsModule],
  providers: [ToolRegistryService, RelationshipGraphService, EchoReportTool, ResolveChapterTool, ResolveCharacterTool, CharacterConsistencyCheckTool, PlotConsistencyCheckTool, CollectChapterContextTool, CollectTaskContextTool, WriteChapterTool, WriteChapterSeriesTool, PostProcessChapterTool, PolishChapterTool, FactValidationTool, AutoRepairChapterTool, ExtractChapterFactsTool, RebuildMemoryTool, ReviewMemoryTool, InspectProjectContextTool, GenerateGuidedStepPreviewTool, GenerateOutlinePreviewTool, GenerateWorldbuildingPreviewTool, ValidateOutlineTool, ValidateWorldbuildingTool, PersistWorldbuildingTool, PersistOutlineTool, AnalyzeSourceTextTool, BuildImportPreviewTool, ValidateImportedAssetsTool, PersistProjectAssetsTool, ReportResultTool],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
