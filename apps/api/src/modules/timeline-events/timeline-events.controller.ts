import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateTimelineEventDto } from './dto/create-timeline-event.dto';
import { ListTimelineEventsQueryDto } from './dto/list-timeline-events-query.dto';
import { UpdateTimelineEventDto } from './dto/update-timeline-event.dto';
import { TimelineEventsService } from './timeline-events.service';

@Controller()
export class TimelineEventsController {
  constructor(private readonly timelineEventsService: TimelineEventsService) {}

  @Post('projects/:projectId/timeline-events')
  create(@Param('projectId') projectId: string, @Body() dto: CreateTimelineEventDto) {
    return this.timelineEventsService.create(projectId, dto);
  }

  @Get('projects/:projectId/timeline-events')
  list(@Param('projectId') projectId: string, @Query() query: ListTimelineEventsQueryDto) {
    return this.timelineEventsService.list(projectId, query);
  }

  @Patch('projects/:projectId/timeline-events/:eventId')
  update(@Param('projectId') projectId: string, @Param('eventId') eventId: string, @Body() dto: UpdateTimelineEventDto) {
    return this.timelineEventsService.update(projectId, eventId, dto);
  }

  @Delete('projects/:projectId/timeline-events/:eventId')
  remove(@Param('projectId') projectId: string, @Param('eventId') eventId: string) {
    return this.timelineEventsService.remove(projectId, eventId);
  }
}
