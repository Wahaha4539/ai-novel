import { Module } from '@nestjs/common';
import { GenerationProfileController } from './generation-profile.controller';
import { GenerationProfileService } from './generation-profile.service';

@Module({
  controllers: [GenerationProfileController],
  providers: [GenerationProfileService],
  exports: [GenerationProfileService],
})
export class GenerationProfileModule {}
