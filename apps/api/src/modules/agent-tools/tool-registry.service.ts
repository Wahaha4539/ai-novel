import { Injectable, OnModuleInit } from '@nestjs/common';
import { BaseTool } from './base-tool';
import { ToolManifestForPlanner } from './tool-manifest.types';
import { AnalyzeSourceTextTool } from './tools/analyze-source-text.tool';
import { AutoRepairChapterTool } from './tools/auto-repair-chapter.tool';
import { BuildImportPreviewTool } from './tools/build-import-preview.tool';
import { CharacterConsistencyCheckTool } from './tools/character-consistency-check.tool';
import { CollectChapterContextTool } from './tools/collect-chapter-context.tool';
import { CollectTaskContextTool } from './tools/collect-task-context.tool';
import { EchoReportTool } from './tools/echo-report.tool';
import { ExtractChapterFactsTool } from './tools/extract-chapter-facts.tool';
import { FactValidationTool } from './tools/fact-validation.tool';
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
    private readonly writeChapterTool: WriteChapterTool,
    private readonly writeChapterSeriesTool: WriteChapterSeriesTool,
    private readonly postProcessChapterTool: PostProcessChapterTool,
    private readonly polishChapterTool: PolishChapterTool,
    private readonly factValidationTool: FactValidationTool,
    private readonly autoRepairChapterTool: AutoRepairChapterTool,
    private readonly extractChapterFactsTool: ExtractChapterFactsTool,
    private readonly rebuildMemoryTool: RebuildMemoryTool,
    private readonly reviewMemoryTool: ReviewMemoryTool,
    private readonly inspectProjectContextTool: InspectProjectContextTool,
    private readonly generateOutlinePreviewTool: GenerateOutlinePreviewTool,
    private readonly generateWorldbuildingPreviewTool: GenerateWorldbuildingPreviewTool,
    private readonly validateOutlineTool: ValidateOutlineTool,
    private readonly validateWorldbuildingTool: ValidateWorldbuildingTool,
    private readonly persistWorldbuildingTool: PersistWorldbuildingTool,
    private readonly persistOutlineTool: PersistOutlineTool,
    private readonly analyzeSourceTextTool: AnalyzeSourceTextTool,
    private readonly buildImportPreviewTool: BuildImportPreviewTool,
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
    this.register(this.writeChapterTool);
    this.register(this.writeChapterSeriesTool);
    this.register(this.postProcessChapterTool);
    this.register(this.polishChapterTool);
    this.register(this.factValidationTool);
    this.register(this.autoRepairChapterTool);
    this.register(this.extractChapterFactsTool);
    this.register(this.rebuildMemoryTool);
    this.register(this.reviewMemoryTool);
    this.register(this.inspectProjectContextTool);
    this.register(this.generateOutlinePreviewTool);
    this.register(this.generateWorldbuildingPreviewTool);
    this.register(this.validateOutlineTool);
    this.register(this.validateWorldbuildingTool);
    this.register(this.persistWorldbuildingTool);
    this.register(this.persistOutlineTool);
    this.register(this.analyzeSourceTextTool);
    this.register(this.buildImportPreviewTool);
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
  listManifestsForPlanner(): ToolManifestForPlanner[] {
    return this.list().map((tool) => {
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
}