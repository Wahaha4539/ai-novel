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
      });
      const postprocess = await this.postProcessChapterService.run(chapter.projectId, chapterId, draft.draftId);
      const facts = await this.factExtractorService.extractChapterFacts(chapter.projectId, chapterId, postprocess.draftId);
      const validation = dto.validateAfterWrite === false ? { skipped: true } : await this.validationService.runFactRules(chapter.projectId, chapterId);
      const memory = await this.memoryRebuildService.rebuildChapter(chapter.projectId, chapterId, postprocess.draftId);
      const memoryReview = await this.memoryReviewService.reviewPending(chapter.projectId, chapterId);

      const responsePayload = { draft, postprocess, facts, validation, memory, memoryReview };
      await this.jobsService.markCompleted(job.id, responsePayload, draft.retrievalPayload);
      this.logger.log('generation.job.completed', { ...logContext, draftId: postprocess.draftId, actualWordCount: postprocess.actualWordCount });
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
