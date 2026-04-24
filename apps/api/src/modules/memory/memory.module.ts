import { Module } from '@nestjs/common';
import { GuidedModule } from '../guided/guided.module';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

@Module({
  imports: [GuidedModule],
  controllers: [MemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}
