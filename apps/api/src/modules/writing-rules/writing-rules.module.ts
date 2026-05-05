import { Module } from '@nestjs/common';
import { WritingRulesController } from './writing-rules.controller';
import { WritingRulesService } from './writing-rules.service';

@Module({
  controllers: [WritingRulesController],
  providers: [WritingRulesService],
})
export class WritingRulesModule {}
