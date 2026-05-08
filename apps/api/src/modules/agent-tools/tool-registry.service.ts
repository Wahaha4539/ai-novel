import { Injectable, OnModuleInit } from '@nestjs/common';
import { BaseTool } from './base-tool';
import { ToolManifestForPlanner } from './tool-manifest.types';
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
import { GenerateTimelinePreviewTool } from './tools/generate-timeline-preview.tool';
import { GenerateGuidedStepPreviewTool } from './tools/generate-guided-step-preview.tool';
import { GenerateChapterCraftBriefPreviewTool, PersistChapterCraftBriefTool, ValidateChapterCraftBriefTool } from './tools/chapter-craft-brief-tools.tool';
import { GenerateChapterOutlinePreviewTool, MergeChapterOutlinePreviewsTool } from './tools/chapter-outline-preview-tools.tool';
import { GenerateImportCharactersPreviewTool } from './tools/generate-import-characters-preview.tool';
import { GenerateImportOutlinePreviewTool } from './tools/generate-import-outline-preview.tool';
import { GenerateImportProjectProfilePreviewTool } from './tools/generate-import-project-profile-preview.tool';
import { GenerateImportWorldbuildingPreviewTool } from './tools/generate-import-worldbuilding-preview.tool';
import { GenerateImportWritingRulesPreviewTool } from './tools/generate-import-writing-rules-preview.tool';
import { GenerateOutlinePreviewTool } from './tools/generate-outline-preview.tool';
import { GenerateStoryBiblePreviewTool } from './tools/generate-story-bible-preview.tool';
import { GenerateVolumeOutlinePreviewTool } from './tools/generate-volume-outline-preview.tool';
import { GenerateWorldbuildingPreviewTool } from './tools/generate-worldbuilding-preview.tool';
import { InspectProjectContextTool } from './tools/inspect-project-context.tool';
import { MergeImportPreviewsTool } from './tools/merge-import-previews.tool';
import { PersistGuidedStepResultTool } from './tools/persist-guided-step-result.tool';
import { PersistOutlineTool } from './tools/persist-outline.tool';
import { PersistVolumeOutlineTool } from './tools/persist-volume-outline.tool';
import { PersistVolumeCharacterCandidatesTool } from './tools/persist-volume-character-candidates.tool';
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
import { ValidateGuidedStepPreviewTool } from './tools/validate-guided-step-preview.tool';
import { ValidateImportedAssetsTool } from './tools/validate-imported-assets.tool';
import { ValidateOutlineTool } from './tools/validate-outline.tool';
import { ValidateStoryBibleTool } from './tools/validate-story-bible.tool';
import { ValidateTimelinePreviewTool } from './tools/validate-timeline-preview.tool';
import { ValidateWorldbuildingTool } from './tools/validate-worldbuilding.tool';
import { WriteChapterTool } from './tools/write-chapter.tool';
import { WriteChapterSeriesTool } from './tools/write-chapter-series.tool';

/**
 * Agent 工具白名单注册表。所有可执行 Tool 都必须在这里注册，
 * Executor 只按名称从注册表取工具，防止 LLM 编造任意能力。
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly tools = new Map<string, BaseTool>();

  constructor(
    private readonly echoReportTool: EchoReportTool,
    private readonly resolveChapterTool: ResolveChapterTool,
    private readonly resolveCharacterTool: ResolveCharacterTool,
    private readonly characterConsistencyCheckTool: CharacterConsistencyCheckTool,
    private readonly plotConsistencyCheckTool: PlotConsistencyCheckTool,
    private readonly collectChapterContextTool: CollectChapterContextTool,
    private readonly collectTaskContextTool: CollectTaskContextTool,
    private readonly generateContinuityPreviewTool: GenerateContinuityPreviewTool,
    private readonly validateContinuityChangesTool: ValidateContinuityChangesTool,
    private readonly persistContinuityChangesTool: PersistContinuityChangesTool,
    private readonly generateTimelinePreviewTool: GenerateTimelinePreviewTool,
    private readonly alignChapterTimelinePreviewTool: AlignChapterTimelinePreviewTool,
    private readonly validateTimelinePreviewTool: ValidateTimelinePreviewTool,
    private readonly persistTimelineEventsTool: PersistTimelineEventsTool,
    private readonly writeChapterTool: WriteChapterTool,
    private readonly rewriteChapterTool: RewriteChapterTool,
    private readonly writeChapterSeriesTool: WriteChapterSeriesTool,
    private readonly postProcessChapterTool: PostProcessChapterTool,
    private readonly polishChapterTool: PolishChapterTool,
    private readonly factValidationTool: FactValidationTool,
    private readonly autoRepairChapterTool: AutoRepairChapterTool,
    private readonly aiQualityReviewTool: AiQualityReviewTool,
    private readonly extractChapterFactsTool: ExtractChapterFactsTool,
    private readonly rebuildMemoryTool: RebuildMemoryTool,
    private readonly reviewMemoryTool: ReviewMemoryTool,
    private readonly inspectProjectContextTool: InspectProjectContextTool,
    private readonly generateGuidedStepPreviewTool: GenerateGuidedStepPreviewTool,
    private readonly validateGuidedStepPreviewTool: ValidateGuidedStepPreviewTool,
    private readonly persistGuidedStepResultTool: PersistGuidedStepResultTool,
    private readonly generateVolumeOutlinePreviewTool: GenerateVolumeOutlinePreviewTool,
    private readonly generateOutlinePreviewTool: GenerateOutlinePreviewTool,
    private readonly generateChapterOutlinePreviewTool: GenerateChapterOutlinePreviewTool,
    private readonly mergeChapterOutlinePreviewsTool: MergeChapterOutlinePreviewsTool,
    private readonly generateWorldbuildingPreviewTool: GenerateWorldbuildingPreviewTool,
    private readonly generateStoryBiblePreviewTool: GenerateStoryBiblePreviewTool,
    private readonly validateOutlineTool: ValidateOutlineTool,
    private readonly validateWorldbuildingTool: ValidateWorldbuildingTool,
    private readonly validateStoryBibleTool: ValidateStoryBibleTool,
    private readonly persistWorldbuildingTool: PersistWorldbuildingTool,
    private readonly persistStoryBibleTool: PersistStoryBibleTool,
    private readonly persistOutlineTool: PersistOutlineTool,
    private readonly persistVolumeOutlineTool: PersistVolumeOutlineTool,
    private readonly persistVolumeCharacterCandidatesTool: PersistVolumeCharacterCandidatesTool,
    private readonly generateChapterCraftBriefPreviewTool: GenerateChapterCraftBriefPreviewTool,
    private readonly validateChapterCraftBriefTool: ValidateChapterCraftBriefTool,
    private readonly persistChapterCraftBriefTool: PersistChapterCraftBriefTool,
    private readonly listSceneCardsTool: ListSceneCardsTool,
    private readonly generateSceneCardsPreviewTool: GenerateSceneCardsPreviewTool,
    private readonly validateSceneCardsTool: ValidateSceneCardsTool,
    private readonly persistSceneCardsTool: PersistSceneCardsTool,
    private readonly updateSceneCardTool: UpdateSceneCardTool,
    private readonly readSourceDocumentTool: ReadSourceDocumentTool,
    private readonly analyzeSourceTextTool: AnalyzeSourceTextTool,
    private readonly buildImportBriefTool: BuildImportBriefTool,
    private readonly buildImportPreviewTool: BuildImportPreviewTool,
    private readonly generateImportProjectProfilePreviewTool: GenerateImportProjectProfilePreviewTool,
    private readonly generateImportOutlinePreviewTool: GenerateImportOutlinePreviewTool,
    private readonly generateImportCharactersPreviewTool: GenerateImportCharactersPreviewTool,
    private readonly generateImportWorldbuildingPreviewTool: GenerateImportWorldbuildingPreviewTool,
    private readonly generateImportWritingRulesPreviewTool: GenerateImportWritingRulesPreviewTool,
    private readonly mergeImportPreviewsTool: MergeImportPreviewsTool,
    private readonly crossTargetConsistencyCheckTool: CrossTargetConsistencyCheckTool,
    private readonly validateImportedAssetsTool: ValidateImportedAssetsTool,
    private readonly persistProjectAssetsTool: PersistProjectAssetsTool,
    private readonly reportResultTool: ReportResultTool,
  ) {}

  onModuleInit() {
    this.register(this.resolveChapterTool);
    this.register(this.resolveCharacterTool);
    this.register(this.characterConsistencyCheckTool);
    this.register(this.plotConsistencyCheckTool);
    this.register(this.collectChapterContextTool);
    this.register(this.collectTaskContextTool);
    this.register(this.generateContinuityPreviewTool);
    this.register(this.validateContinuityChangesTool);
    this.register(this.persistContinuityChangesTool);
    this.register(this.generateTimelinePreviewTool);
    this.register(this.alignChapterTimelinePreviewTool);
    this.register(this.validateTimelinePreviewTool);
    this.register(this.persistTimelineEventsTool);
    this.register(this.writeChapterTool);
    this.register(this.rewriteChapterTool);
    this.register(this.writeChapterSeriesTool);
    this.register(this.postProcessChapterTool);
    this.register(this.polishChapterTool);
    this.register(this.factValidationTool);
    this.register(this.autoRepairChapterTool);
    this.register(this.aiQualityReviewTool);
    this.register(this.extractChapterFactsTool);
    this.register(this.rebuildMemoryTool);
    this.register(this.reviewMemoryTool);
    this.register(this.inspectProjectContextTool);
    this.register(this.generateGuidedStepPreviewTool);
    this.register(this.validateGuidedStepPreviewTool);
    this.register(this.persistGuidedStepResultTool);
    this.register(this.generateVolumeOutlinePreviewTool);
    this.register(this.generateOutlinePreviewTool);
    this.register(this.generateChapterOutlinePreviewTool);
    this.register(this.mergeChapterOutlinePreviewsTool);
    this.register(this.generateWorldbuildingPreviewTool);
    this.register(this.generateStoryBiblePreviewTool);
    this.register(this.validateOutlineTool);
    this.register(this.validateWorldbuildingTool);
    this.register(this.validateStoryBibleTool);
    this.register(this.persistWorldbuildingTool);
    this.register(this.persistStoryBibleTool);
    this.register(this.persistOutlineTool);
    this.register(this.persistVolumeOutlineTool);
    this.register(this.persistVolumeCharacterCandidatesTool);
    this.register(this.generateChapterCraftBriefPreviewTool);
    this.register(this.validateChapterCraftBriefTool);
    this.register(this.persistChapterCraftBriefTool);
    this.register(this.listSceneCardsTool);
    this.register(this.generateSceneCardsPreviewTool);
    this.register(this.validateSceneCardsTool);
    this.register(this.persistSceneCardsTool);
    this.register(this.updateSceneCardTool);
    this.register(this.readSourceDocumentTool);
    this.register(this.analyzeSourceTextTool);
    this.register(this.buildImportBriefTool);
    this.register(this.buildImportPreviewTool);
    this.register(this.generateImportProjectProfilePreviewTool);
    this.register(this.generateImportOutlinePreviewTool);
    this.register(this.generateImportCharactersPreviewTool);
    this.register(this.generateImportWorldbuildingPreviewTool);
    this.register(this.generateImportWritingRulesPreviewTool);
    this.register(this.mergeImportPreviewsTool);
    this.register(this.crossTargetConsistencyCheckTool);
    this.register(this.validateImportedAssetsTool);
    this.register(this.persistProjectAssetsTool);
    this.register(this.reportResultTool);
    this.register(this.echoReportTool);
  }

  register(tool: BaseTool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  list(): BaseTool[] {
    return [...this.tools.values()];
  }

  /**
   * 返回压缩后的 LLM 友好工具手册。Planner 只需要语义说明和风险边界，
   * 不暴露运行时实现细节，避免 Prompt 过长或诱导模型编造内部能力。
   */
  listManifestsForPlanner(toolNames?: string[]): ToolManifestForPlanner[] {
    return this.listToolsForPlanner(toolNames).map((tool) => {
      const manifest = tool.manifest;
      return {
        name: manifest?.name ?? tool.name,
        displayName: manifest?.displayName ?? tool.name,
        description: manifest?.description ?? tool.description,
        whenToUse: manifest?.whenToUse ?? [],
        whenNotToUse: manifest?.whenNotToUse ?? [],
        inputSchema: manifest?.inputSchema ?? tool.inputSchema,
        outputSchema: manifest?.outputSchema ?? tool.outputSchema,
        parameterHints: manifest?.parameterHints,
        examples: manifest?.examples?.slice(0, 2),
        failureHints: manifest?.failureHints,
        allowedModes: manifest?.allowedModes ?? tool.allowedModes,
        riskLevel: manifest?.riskLevel ?? tool.riskLevel,
        requiresApproval: manifest?.requiresApproval ?? tool.requiresApproval,
        sideEffects: manifest?.sideEffects ?? tool.sideEffects,
        idPolicy: manifest?.idPolicy,
      };
    });
  }

  private listToolsForPlanner(toolNames?: string[]): BaseTool[] {
    if (!toolNames?.length) return this.list();
    return [...new Set(toolNames)].map((toolName) => {
      const tool = this.get(toolName);
      if (!tool) throw new Error(`Planner requested unregistered tool manifest: ${toolName}`);
      return tool;
    });
  }
}
