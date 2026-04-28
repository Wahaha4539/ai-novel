import { BadRequestException, Injectable } from '@nestjs/common';
import { FactExtractionResult, FactExtractorService } from '../../facts/fact-extractor.service';
import { BaseTool, ToolContext } from '../base-tool';

interface ExtractChapterFactsInput {
  chapterId?: string;
  draftId?: string;
}

/**
 * 章节事实抽取工具：从章节草稿沉淀剧情事件、角色状态、伏笔和摘要。
 * 该工具写入事实层表，必须在 Act 阶段经过用户审批后执行。
 */
@Injectable()
export class ExtractChapterFactsTool implements BaseTool<ExtractChapterFactsInput, FactExtractionResult> {
  name = 'extract_chapter_facts';
  description = '从章节草稿抽取剧情事件、角色状态、伏笔和章节摘要，并写入事实层表。';
  inputSchema = { type: 'object' as const, required: ['chapterId', 'draftId'], additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['chapterId', 'draftId', 'summary', 'createdEvents', 'createdCharacterStates', 'createdForeshadows', 'createdMemoryChunks', 'pendingReviewMemoryChunks'], properties: { chapterId: { type: 'string' as const, minLength: 1 }, draftId: { type: 'string' as const, minLength: 1 }, summary: { type: 'string' as const }, createdEvents: { type: 'number' as const, minimum: 0 }, createdCharacterStates: { type: 'number' as const, minimum: 0 }, createdForeshadows: { type: 'number' as const, minimum: 0 }, createdMemoryChunks: { type: 'number' as const, minimum: 0 }, pendingReviewMemoryChunks: { type: 'number' as const, minimum: 0 }, events: { type: 'array' as const }, characterStates: { type: 'array' as const }, foreshadows: { type: 'array' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['replace_auto_story_events', 'replace_auto_character_states', 'replace_auto_foreshadows', 'replace_auto_memory_chunks'];

  constructor(private readonly factExtractor: FactExtractorService) {}

  run(args: ExtractChapterFactsInput, context: ToolContext): Promise<FactExtractionResult> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('extract_chapter_facts 需要 chapterId');
    return this.factExtractor.extractChapterFacts(context.projectId, chapterId, args.draftId);
  }
}