import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MemoryService } from './memory.service';

@Controller()
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get('projects/:projectId/memory/dashboard')
  dashboard(@Param('projectId') projectId: string, @Query('chapterId') chapterId?: string) {
    return this.memoryService.getDashboard(projectId, chapterId);
  }

  @Get('projects/:projectId/story-events')
  listStoryEvents(
    @Param('projectId') projectId: string,
    @Query('chapterId') chapterId?: string,
    @Query('q') q?: string,
  ) {
    return this.memoryService.listStoryEvents(projectId, chapterId, q);
  }

  @Get('projects/:projectId/character-state-snapshots')
  listCharacterStateSnapshots(
    @Param('projectId') projectId: string,
    @Query('chapterId') chapterId?: string,
    @Query('status') status?: string,
    @Query('character') character?: string,
    @Query('q') q?: string,
  ) {
    return this.memoryService.listCharacterStateSnapshots(projectId, chapterId, status, character, q);
  }

  @Get('projects/:projectId/foreshadow-tracks')
  listForeshadowTracks(
    @Param('projectId') projectId: string,
    @Query('chapterId') chapterId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    return this.memoryService.listForeshadowTracks(projectId, chapterId, status, q);
  }

  @Get('projects/:projectId/memory/reviews')
  listReviewQueue(
    @Param('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('memoryType') memoryType?: string,
    @Query('chapterId') chapterId?: string,
    @Query('q') q?: string,
  ) {
    return this.memoryService.listReviewQueue(projectId, status, memoryType, chapterId, q);
  }

  @Get('projects/:projectId/memory/search')
  search(@Param('projectId') projectId: string, @Query('q') q?: string) {
    return this.memoryService.search(projectId, q);
  }

  @Get('projects/:projectId/memory/retrieval/evaluate')
  evaluateRetrieval(
    @Param('projectId') projectId: string,
    @Query('q') q?: string,
    @Query('expectedMemoryIds') expectedMemoryIds?: string,
  ) {
    const expected = expectedMemoryIds?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
    return this.memoryService.evaluateRetrieval(projectId, q, expected);
  }

  @Post('projects/:projectId/memory/retrieval/benchmark')
  benchmarkRetrieval(
    @Param('projectId') projectId: string,
    @Body('cases') cases?: Array<{ id?: string; query: string; expectedMemoryIds?: string[] }>,
  ) {
    return this.memoryService.benchmarkRetrieval(projectId, Array.isArray(cases) ? cases : []);
  }

  @Post('projects/:projectId/memory/reviews/:memoryId/confirm')
  confirmReview(@Param('projectId') projectId: string, @Param('memoryId') memoryId: string) {
    return this.memoryService.updateReviewStatus(projectId, memoryId, 'user_confirmed');
  }

  @Post('projects/:projectId/memory/reviews/:memoryId/reject')
  rejectReview(@Param('projectId') projectId: string, @Param('memoryId') memoryId: string) {
    return this.memoryService.updateReviewStatus(projectId, memoryId, 'rejected');
  }

  @Post('projects/:projectId/memory/reviews/ai-resolve')
  aiResolveReviews(
    @Param('projectId') projectId: string,
    @Body('chapterId') chapterId?: string,
  ) {
    return this.memoryService.aiResolveReviewQueue(projectId, chapterId);
  }

  @Post('projects/:projectId/memory/rebuild')
  rebuild(
    @Param('projectId') projectId: string,
    @Query('chapterId') chapterId?: string,
    @Query('dryRun') dryRun?: string,
  ) {
    return this.memoryService.rebuild(projectId, chapterId, dryRun === 'true' || dryRun === '1');
  }

  @Post('projects/:projectId/memory/embeddings/backfill')
  backfillEmbeddings(
    @Param('projectId') projectId: string,
    @Query('chapterId') chapterId?: string,
    @Query('dryRun') dryRun?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('force') force?: string,
  ) {
    return this.memoryService.backfillEmbeddings(projectId, chapterId, dryRun === 'true' || dryRun === '1', limit ? Number(limit) : 50, cursor, force === 'true' || force === '1');
  }
}
