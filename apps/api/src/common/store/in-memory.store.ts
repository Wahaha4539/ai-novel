import { Injectable } from '@nestjs/common';
import {
  ChapterRecord,
  CharacterRecord,
  GenerationJobRecord,
  LorebookRecord,
  MemoryChunkRecord,
  ProjectRecord,
  ValidationIssueRecord,
} from './domain.types';

@Injectable()
export class InMemoryStore {
  readonly projects = new Map<string, ProjectRecord>();
  readonly chapters = new Map<string, ChapterRecord>();
  readonly characters = new Map<string, CharacterRecord>();
  readonly lorebookEntries = new Map<string, LorebookRecord>();
  readonly validationIssues = new Map<string, ValidationIssueRecord>();
  readonly memoryChunks = new Map<string, MemoryChunkRecord>();
  readonly jobs = new Map<string, GenerationJobRecord>();
}
