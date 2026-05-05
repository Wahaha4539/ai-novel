import { Module } from '@nestjs/common';
import { TimelineEventsController } from './timeline-events.controller';
import { TimelineEventsService } from './timeline-events.service';

@Module({
  controllers: [TimelineEventsController],
  providers: [TimelineEventsService],
})
export class TimelineEventsModule {}
