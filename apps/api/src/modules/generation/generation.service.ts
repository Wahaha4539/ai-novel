import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { AlignChapterTimelinePreviewTool } from '../agent-tools/tools/align-chapter-timeline-preview.tool';
import { PersistTimelineEventsTool } from '../agent-tools/tools/persist-timeline-events.tool';
import type { GenerateTimelinePreviewOutput, PersistTimelineEventsOutput, ValidateTimelinePreviewOutput } from '../agent-tools/tools/timeline-preview.types';
import { ValidateTimelinePreviewTool } from '../agent-tools/tools/validate-timeline-preview.tool';
import { ChaptersService } from '../chapters/chapters.service';
import { FactExtractorService } from '../facts/fact-extractor.service';
import type { FactExtractionResult } from '../facts/fact-extractor.service';
import type { GenerationProfileSnapshot } from '../generation-profile/generation-profile.defaults';
import { JobsService } from '../jobs/jobs.service';
import { MemoryRebuildService } from '../memory/memory-rebuild.service';
import { MemoryReviewService } from '../memory/memory-review.service';
import { ValidationService } from '../validation/validation.service';
import { GenerateChapterDto } from './dto/generate-chapter.dto';
import { PolishChapterDto } from './dto/polish-chapter.dto';
import { GenerateChapterService } from './generate-chapter.service';
import { PolishChapterService } from './polish-chapter.service';
import { PostProcessChapterService } from './postprocess-chapter.service';

const AUTO_POLISH_INSTRUCTION = '请在不改变剧情事实、人物关系、时间线和章节主线结果的前提下，润色当前章节正文：提升句子流畅度、画面感、节奏和衔接，修正明显语病与重复表达。直接输出润色后的完整章节正文，不要添加说明。';

interface ChapterTimelineAlignmentResult {
  skipped: boolean;
  reason?: string;
  autoWritePolicy?: 'preview_only' | 'validated_auto_write';
  preview?: GenerateTimelinePreviewOutput;
  validation?: ValidateTimelinePreviewOutput;
  persist?: PersistTimelineEventsOutput;
}

@Injectable()
export class GenerationService {
  private readonly logger = new StructuredLogger(GenerationService.name);

  constructor(
    private readonly chaptersService: ChaptersService,
    private readonly jobsService: JobsService,
    private readonly generateChapterService: GenerateChapterService,
    private readonly postProcessChapterService: PostProcessChapterService,
    private readonly polishChapterService: PolishChapterService,
    private readonly factExtractorService: FactExtractorService,
    private readonly memoryRebuildService: MemoryRebuildService,
    private readonly memoryReviewService: MemoryReviewService,
    private readonly validationService: ValidationService,
    private readonly alignChapterTimelinePreviewTool: AlignChapterTimelinePreviewTool,
    private readonly validateTimelinePreviewTool: ValidateTimelinePreviewTool,
    private readonly persistTimelineEventsTool: PersistTimelineEventsTool,
  ) {}

  async generateChapter(chapterId: string, dto: GenerateChapterDto) {
    const chapter = await this.chaptersService.getById(chapterId);
    const requestId = randomUUID();
    const job = await this.jobsService.create({
      projectId: chapter.projectId,
      jobType: 'write_chapter',
      targetType: 'chapter',
      targetId: chapterId,
      requestPayload: {
        ...dto,
        _requestId: requestId,
        _executedIn: 'api_sync_generation_service',
        _startedAt: new Date().toISOString(),
      },
    });

    const logContext = {
      requestId,
      jobId: job.id,
      projectId: chapter.projectId,
      chapterId,
    };

    try {
      await this.jobsService.markRunning(job.id, 'executed synchronously inside apps/api GenerateChapterService');
      this.logger.log('generation.job.running', logContext);

      const draft = await this.generateChapterService.run(chapter.projectId, chapterId, {
        mode: dto.mode,
        instruction: dto.instruction,
        wordCount: dto.wordCount,
        includeLorebook: dto.includeLorebook,
        includeMemory: dto.includeMemory,
        validateBeforeWrite: dto.validateBeforeWrite,
        outlineQualityGate: dto.outlineQualityGate,
        requestId,
        jobId: job.id,
      });
      const postprocess = await this.postProcessChapterService.run(chapter.projectId, chapterId, draft.draftId);
      // “完整生成流程”的最终正文应是润色稿；事实抽取、校验和记忆重建都必须基于最终稿，
      // 否则 UI 会只有草稿版本，右侧事实层也可能记录未润色的中间文本。
      const targetWordCount = draft.qualityGate?.metrics?.targetWordCount ?? dto.wordCount ?? chapter.expectedWordCount ?? 3500;
      const polishInstruction = `${AUTO_POLISH_INSTRUCTION}\n本章目标字数为 ${targetWordCount} 字；润色后正文必须保持在 ${Math.round(targetWordCount * 0.85)}-${Math.round(targetWordCount * 1.3)} 字之间，不得把合格初稿压缩成短稿。`;
      const polish = await this.polishChapterService.run(chapter.projectId, chapterId, polishInstruction, postprocess.draftId, {
        targetWordCount,
      });
      const finalDraftId = polish.draftId;
      const facts = await this.factExtractorService.extractChapterFacts(chapter.projectId, chapterId, finalDraftId);
      const generationProfile = await this.generateChapterService.loadGenerationProfileSnapshot(chapter.projectId);
      const timelineAlignment = await this.maybeAlignChapterTimeline({
        projectId: chapter.projectId,
        chapterId,
        draftId: finalDraftId,
        generationProfile,
        facts,
        requestId,
        jobId: job.id,
        source: 'generate_chapter',
      });
      const validation = dto.validateAfterWrite === false ? { skipped: true } : await this.validationService.runFactRules(chapter.projectId, chapterId);
      const memory = await this.memoryRebuildService.rebuildChapter(chapter.projectId, chapterId, finalDraftId);
      const memoryReview = await this.memoryReviewService.reviewPending(chapter.projectId, chapterId);

      const responsePayload = { draft, postprocess, polish, facts, timelineAlignment, validation, memory, memoryReview };
      await this.jobsService.markCompleted(job.id, responsePayload, draft.retrievalPayload);
      this.logger.log('generation.job.completed', { ...logContext, draftId: finalDraftId, originalDraftId: draft.draftId, polishedWordCount: polish.polishedWordCount });
      return this.jobsService.getById(job.id);
    } catch (error) {
      await this.jobsService.markFailed(job.id, error instanceof Error ? error.message : 'unknown_generation_error');
      this.logger.error('generation.job.failed', error, logContext);
      return this.jobsService.getById(job.id);
    }
  }

  /**
   * 触发章节润色。Agent-Centric 架构下直接调用 API 内 PolishChapterService，
   * 并同步执行事实抽取、校验、记忆重建与复核，保持旧前端“一键润色后可继续校验”的体验。
   */
  async polishChapter(chapterId: string, dto: PolishChapterDto) {
    const chapter = await this.chaptersService.getById(chapterId);
    this.logger.log('polish.job.running', { chapterId, projectId: chapter.projectId });

    const result = await this.polishChapterService.run(chapter.projectId, chapterId, dto.userInstruction);
    const facts = await this.factExtractorService.extractChapterFacts(chapter.projectId, chapterId, result.draftId);
    const generationProfile = await this.generateChapterService.loadGenerationProfileSnapshot(chapter.projectId);
    const timelineAlignment = await this.maybeAlignChapterTimeline({
      projectId: chapter.projectId,
      chapterId,
      draftId: result.draftId,
      generationProfile,
      facts,
      source: 'polish_chapter',
    });
    const validation = await this.validationService.runFactRules(chapter.projectId, chapterId);
    const memory = await this.memoryRebuildService.rebuildChapter(chapter.projectId, chapterId, result.draftId);
    const memoryReview = await this.memoryReviewService.reviewPending(chapter.projectId, chapterId);

    this.logger.log('polish.job.completed', {
      chapterId,
      projectId: chapter.projectId,
      polishedWordCount: result.polishedWordCount,
    });

    return { ...result, facts, timelineAlignment, validation, memory, memoryReview };
  }

  private async maybeAlignChapterTimeline(input: {
    projectId: string;
    chapterId: string;
    draftId: string;
    generationProfile: GenerationProfileSnapshot;
    facts: FactExtractionResult;
    requestId?: string;
    jobId?: string;
    source: 'generate_chapter' | 'polish_chapter';
  }): Promise<ChapterTimelineAlignmentResult> {
    if (!input.generationProfile.autoUpdateTimeline) {
      return { skipped: true, reason: 'autoUpdateTimeline_disabled' };
    }
    const autoWritePolicy = this.resolveTimelineAutoWritePolicy(input.generationProfile);

    const context = {
      agentRunId: input.jobId ?? input.requestId ?? `chapter_generation:${input.draftId}`,
      projectId: input.projectId,
      chapterId: input.chapterId,
      mode: 'plan' as const,
      approved: false,
      outputs: {},
      policy: {},
    };
    const preview = await this.alignChapterTimelinePreviewTool.run(
      {
        chapterId: input.chapterId,
        draftId: input.draftId,
        maxCandidates: 8,
        instruction: 'Align the extracted current-chapter StoryEvent evidence with planned and active TimelineEvent rows. Return preview candidates only.',
        context: {
          source: input.source,
          factsSummary: input.facts.summary,
          createdEvents: input.facts.createdEvents,
          draftId: input.draftId,
        },
      },
      context,
    );
    const validation = await this.validateTimelinePreviewTool.run({ preview }, context);
    if (!validation.valid) {
      const messages = validation.issues.map((issue) => issue.message).filter(Boolean);
      throw new Error(`timeline alignment validation failed: ${messages.join('; ') || 'no accepted timeline candidates'}`);
    }
    if (autoWritePolicy === 'preview_only') {
      return { skipped: false, autoWritePolicy, preview, validation };
    }
    if (validation.issueCount > 0) {
      throw new Error('timeline alignment auto write requires zero validation issues; review the timeline preview manually.');
    }

    const persist = await this.persistTimelineEventsTool.run(
      { preview, validation },
      {
        ...context,
        mode: 'act' as const,
        outputs: { 1: preview, 2: validation },
        stepTools: { 1: 'align_chapter_timeline_preview', 2: 'validate_timeline_preview' },
        policy: {
          timelineAutoWrite: {
            source: 'generation_profile',
            strategy: autoWritePolicy,
            projectId: input.projectId,
          },
        },
      },
    );
    return { skipped: false, autoWritePolicy, preview, validation, persist };
  }

  private resolveTimelineAutoWritePolicy(generationProfile: GenerationProfileSnapshot): 'preview_only' | 'validated_auto_write' {
    const value = generationProfile.metadata.timelineAutoWritePolicy;
    if (value === undefined || value === null || value === 'preview_only') return 'preview_only';
    if (value === 'validated_auto_write') return 'validated_auto_write';
    throw new Error('GenerationProfile metadata.timelineAutoWritePolicy must be preview_only or validated_auto_write.');
  }
}
