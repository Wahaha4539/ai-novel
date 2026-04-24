import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ValidationService } from './validation.service';

@Controller()
export class ValidationController {
  constructor(private readonly validationService: ValidationService) {}

  @Get('projects/:projectId/validation-issues')
  listByProject(@Param('projectId') projectId: string, @Query('chapterId') chapterId?: string) {
    return this.validationService.listByProject(projectId, chapterId);
  }

  @Post('validation-issues/:issueId/resolve')
  resolveIssue(@Param('issueId') issueId: string) {
    return this.validationService.resolveIssue(issueId);
  }

  @Post('projects/:projectId/validation/run')
  runFactRules(@Param('projectId') projectId: string, @Query('chapterId') chapterId?: string) {
    return this.validationService.runFactRules(projectId, chapterId);
  }

  @Get('chapters/:chapterId/validation-issues')
  listByChapter(@Param('chapterId') chapterId: string) {
    return this.validationService.listByChapter(chapterId);
  }
}
