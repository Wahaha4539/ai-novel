import { Module } from '@nestjs/common';
import { ChapterPatternsController } from './chapter-patterns.controller';
import { ChapterPatternsService } from './chapter-patterns.service';

@Module({
  controllers: [ChapterPatternsController],
  providers: [ChapterPatternsService],
})
export class ChapterPatternsModule {}
