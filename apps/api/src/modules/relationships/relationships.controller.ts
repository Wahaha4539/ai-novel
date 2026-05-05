import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { ListRelationshipsQueryDto } from './dto/list-relationships-query.dto';
import { UpdateRelationshipDto } from './dto/update-relationship.dto';
import { RelationshipsService } from './relationships.service';

@Controller()
export class RelationshipsController {
  constructor(private readonly relationshipsService: RelationshipsService) {}

  @Post('projects/:projectId/relationships')
  create(@Param('projectId') projectId: string, @Body() dto: CreateRelationshipDto) {
    return this.relationshipsService.create(projectId, dto);
  }

  @Get('projects/:projectId/relationships')
  list(@Param('projectId') projectId: string, @Query() query: ListRelationshipsQueryDto) {
    return this.relationshipsService.list(projectId, query);
  }

  @Patch('projects/:projectId/relationships/:relationshipId')
  update(
    @Param('projectId') projectId: string,
    @Param('relationshipId') relationshipId: string,
    @Body() dto: UpdateRelationshipDto,
  ) {
    return this.relationshipsService.update(projectId, relationshipId, dto);
  }

  @Delete('projects/:projectId/relationships/:relationshipId')
  remove(@Param('projectId') projectId: string, @Param('relationshipId') relationshipId: string) {
    return this.relationshipsService.remove(projectId, relationshipId);
  }
}
