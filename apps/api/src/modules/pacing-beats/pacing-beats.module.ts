import { Module } from '@nestjs/common';
import { PacingBeatsController } from './pacing-beats.controller';
import { PacingBeatsService } from './pacing-beats.service';

@Module({
  controllers: [PacingBeatsController],
  providers: [PacingBeatsService],
})
export class PacingBeatsModule {}
