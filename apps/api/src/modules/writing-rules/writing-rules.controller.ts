import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateWritingRuleDto } from './dto/create-writing-rule.dto';
import { ListWritingRulesQueryDto } from './dto/list-writing-rules-query.dto';
import { UpdateWritingRuleDto } from './dto/update-writing-rule.dto';
import { WritingRulesService } from './writing-rules.service';

@Controller()
export class WritingRulesController {
  constructor(private readonly writingRulesService: WritingRulesService) {}

  @Post('projects/:projectId/writing-rules')
  create(@Param('projectId') projectId: string, @Body() dto: CreateWritingRuleDto) {
    return this.writingRulesService.create(projectId, dto);
  }

  @Get('projects/:projectId/writing-rules')
  list(@Param('projectId') projectId: string, @Query() query: ListWritingRulesQueryDto) {
    return this.writingRulesService.list(projectId, query);
  }

  @Patch('projects/:projectId/writing-rules/:ruleId')
  update(@Param('projectId') projectId: string, @Param('ruleId') ruleId: string, @Body() dto: UpdateWritingRuleDto) {
    return this.writingRulesService.update(projectId, ruleId, dto);
  }

  @Delete('projects/:projectId/writing-rules/:ruleId')
  remove(@Param('projectId') projectId: string, @Param('ruleId') ruleId: string) {
    return this.writingRulesService.remove(projectId, ruleId);
  }
}
