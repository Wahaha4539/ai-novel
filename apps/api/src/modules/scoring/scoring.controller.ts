import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PLATFORM_SCORING_PROFILES } from './platform-scoring-profiles';
import { CreateScoringRunDto } from './dto/create-scoring-run.dto';
import { ListScoringRunsQueryDto } from './dto/list-scoring-runs-query.dto';
import { ScoringRevisionService } from './scoring-revision.service';
import { ScoringService } from './scoring.service';

@Controller()
export class ScoringController {
  constructor(
    private readonly scoringService: ScoringService,
    private readonly scoringRevisionService: ScoringRevisionService,
  ) {}

  @Get('scoring/platform-profiles')
  listProfiles() {
    return Object.values(PLATFORM_SCORING_PROFILES);
  }

  @Get('projects/:projectId/scoring/runs')
  listRuns(@Param('projectId') projectId: string, @Query() query: ListScoringRunsQueryDto) {
    return this.scoringService.listRuns(projectId, query);
  }

  @Get('projects/:projectId/scoring/assets')
  listAssets(@Param('projectId') projectId: string) {
    return this.scoringService.listAssets(projectId);
  }

  @Post('projects/:projectId/scoring/runs')
  createRun(@Param('projectId') projectId: string, @Body() dto: CreateScoringRunDto) {
    return this.scoringService.createRun(projectId, dto);
  }

  @Get('projects/:projectId/scoring/runs/:runId')
  getRun(@Param('projectId') projectId: string, @Param('runId') runId: string) {
    return this.scoringService.getRun(projectId, runId);
  }

  @Post('projects/:projectId/scoring/runs/:runId/revision')
  createRevision(@Param('projectId') projectId: string, @Param('runId') runId: string, @Body() body: unknown) {
    return this.scoringRevisionService.createRevision(projectId, runId, body);
  }
}
