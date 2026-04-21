import { Global, Module } from '@nestjs/common';
import { NovelCacheService } from './novel-cache.service';

@Global()
@Module({
  providers: [NovelCacheService],
  exports: [NovelCacheService],
})
export class CacheModule {}