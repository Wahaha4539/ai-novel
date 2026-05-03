import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { ChaptersService } from '../chapters/chapters.service';
import { FactExtractorService } from '../facts/fact-extractor.service';
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
      const polish = await this.polishChapterService.run(chapter.projectId, chapterId, AUTO_POLISH_INSTRUCTION, postprocess.draftId);
      const finalDraftId = polish.draftId;
      const facts = await this.factExtractorService.extractChapterFacts(chapter.projectId, chapterId, finalDraftId);
      const validation = dto.validateAfterWrite === false ? { skipped: true } : await this.validationService.runFactRules(chapter.projectId, chapterId);
      const memory = await this.memoryRebuildService.rebuildChapter(chapter.projectId, chapterId, finalDraftId);
      const memoryReview = await this.memoryReviewService.reviewPending(chapter.projectId, chapterId);

      const responsePayload = { draft, postprocess, polish, facts, validation, memory, memoryReview };
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
    const validation = await this.validationService.runFactRules(chapter.projectId, chapterId);
    const memory = await this.memoryRebuildService.rebuildChapter(chapter.projectId, chapterId, result.draftId);
    const memoryReview = await this.memoryReviewService.reviewPending(chapter.projectId, chapterId);

    this.logger.log('polish.job.completed', {
      chapterId,
      projectId: chapter.projectId,
      polishedWordCount: result.polishedWordCount,
    });

    return { ...result, facts, validation, memory, memoryReview };
  }
}
