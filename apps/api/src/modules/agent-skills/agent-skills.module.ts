import { Module } from '@nestjs/common';
import { SkillRegistryService } from './skill-registry.service';

@Module({ providers: [SkillRegistryService], exports: [SkillRegistryService] })
export class AgentSkillsModule {}