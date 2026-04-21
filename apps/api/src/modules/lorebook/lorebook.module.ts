import { Module } from '@nestjs/common';
import { LorebookController } from './lorebook.controller';
import { LorebookService } from './lorebook.service';

@Module({
  controllers: [LorebookController],
  providers: [LorebookService],
})
export class LorebookModule {}
