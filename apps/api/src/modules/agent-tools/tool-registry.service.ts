import { Injectable, OnModuleInit } from '@nestjs/common';
import { BaseTool } from './base-tool';
import { AnalyzeSourceTextTool } from './tools/analyze-source-text.tool';
import { AutoRepairChapterTool } from './tools/auto-repair-chapter.tool';
import { BuildImportPreviewTool } from './tools/build-import-preview.tool';
import { CollectChapterContextTool } from './tools/collect-chapter-context.tool';
import { EchoReportTool } from './tools/echo-report.tool';
import { ExtractChapterFactsTool } from './tools/extract-chapter-facts.tool';
import { FactValidationTool } from './tools/fact-validation.tool';
import { GenerateOutlinePreviewTool } from './tools/generate-outline-preview.tool';
import { InspectProjectContextTool } from './tools/inspect-project-context.tool';
import { PersistOutlineTool } from './tools/persist-outline.tool';
import { PersistProjectAssetsTool } from './tools/persist-project-assets.tool';
import { PolishChapterTool } from './tools/polish-chapter.tool';
import { PostProcessChapterTool } from './tools/postprocess-chapter.tool';
import { ReportResultTool } from './tools/report-result.tool';
import { RebuildMemoryTool } from './tools/rebuild-memory.tool';
import { ReviewMemoryTool } from './tools/review-memory.tool';
import { ResolveChapterTool } from './tools/resolve-chapter.tool';
import { ValidateImportedAssetsTool } from './tools/validate-imported-assets.tool';
import { ValidateOutlineTool } from './tools/validate-outline.tool';
import { WriteChapterTool } from './tools/write-chapter.tool';

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
    private readonly collectChapterContextTool: CollectChapterContextTool,
    private readonly writeChapterTool: WriteChapterTool,
    private readonly postProcessChapterTool: PostProcessChapterTool,
    private readonly polishChapterTool: PolishChapterTool,
    private readonly factValidationTool: FactValidationTool,
    private readonly autoRepairChapterTool: AutoRepairChapterTool,
    private readonly extractChapterFactsTool: ExtractChapterFactsTool,
    private readonly rebuildMemoryTool: RebuildMemoryTool,
    private readonly reviewMemoryTool: ReviewMemoryTool,
    private readonly inspectProjectContextTool: InspectProjectContextTool,
    private readonly generateOutlinePreviewTool: GenerateOutlinePreviewTool,
    private readonly validateOutlineTool: ValidateOutlineTool,
    private readonly persistOutlineTool: PersistOutlineTool,
    private readonly analyzeSourceTextTool: AnalyzeSourceTextTool,
    private readonly buildImportPreviewTool: BuildImportPreviewTool,
    private readonly validateImportedAssetsTool: ValidateImportedAssetsTool,
    private readonly persistProjectAssetsTool: PersistProjectAssetsTool,
    private readonly reportResultTool: ReportResultTool,
  ) {}

  onModuleInit() {
    this.register(this.resolveChapterTool);
    this.register(this.collectChapterContextTool);
    this.register(this.writeChapterTool);
    this.register(this.postProcessChapterTool);
    this.register(this.polishChapterTool);
    this.register(this.factValidationTool);
    this.register(this.autoRepairChapterTool);
    this.register(this.extractChapterFactsTool);
    this.register(this.rebuildMemoryTool);
    this.register(this.reviewMemoryTool);
    this.register(this.inspectProjectContextTool);
    this.register(this.generateOutlinePreviewTool);
    this.register(this.validateOutlineTool);
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
}