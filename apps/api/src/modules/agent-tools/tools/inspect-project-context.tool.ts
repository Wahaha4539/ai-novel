import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface InspectProjectContextOutput {
  project: { id: string; title: string; genre: string | null; theme: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  volumes: Array<{ id: string; volumeNo: number; title: string | null; synopsis: string | null; objective: string | null; chapterCount: number | null }>;
  existingChapters: Array<{ chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }>;
  characters: Array<{ name: string; roleType: string | null; motivation: string | null }>;
  lorebookEntries: Array<{ title: string; entryType: string; summary: string | null }>;
}

/**
 * 项目上下文巡检工具：为大纲设计读取项目、卷、已有章节、角色和设定。
 * 该工具只读数据库，不产生正式业务写入。
 */
@Injectable()
export class InspectProjectContextTool implements BaseTool<Record<string, never>, InspectProjectContextOutput> {
  name = 'inspect_project_context';
  description = '读取大纲设计所需的项目、卷、已有章节、角色和世界观上下文。';
  inputSchema = { type: 'object' as const };
  outputSchema = {
    type: 'object' as const,
    required: ['project', 'volumes', 'existingChapters', 'characters', 'lorebookEntries'],
    properties: { project: { type: 'object' as const }, volumes: { type: 'array' as const }, existingChapters: { type: 'array' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '巡检项目上下文',
    description: '只读读取项目、卷、章节、角色和世界观摘要，为大纲设计、世界观扩展和导入预览提供全局背景。',
    whenToUse: ['用户要求拆大纲、扩展世界观或导入项目资料前', '需要了解现有卷、章节、角色和设定边界', 'generate_worldbuilding_preview 或 generate_outline_preview 之前需要项目摘要'],
    whenNotToUse: ['只需要解析某个章节/角色 ID 时，应使用 resolver', '需要读取当前章节完整草稿时，应使用 collect_chapter_context 或 collect_task_context'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {},
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(_args: Record<string, never>, context: ToolContext): Promise<InspectProjectContextOutput> {
    const project = await this.prisma.project.findUnique({ where: { id: context.projectId } });
    if (!project) throw new NotFoundException(`项目不存在：${context.projectId}`);

    const [volumes, chapters, characters, lorebookEntries] = await Promise.all([
      this.prisma.volume.findMany({ where: { projectId: context.projectId }, orderBy: { volumeNo: 'asc' }, take: 12 }),
      this.prisma.chapter.findMany({ where: { projectId: context.projectId }, orderBy: { chapterNo: 'asc' }, take: 200 }),
      this.prisma.character.findMany({ where: { projectId: context.projectId }, orderBy: { createdAt: 'asc' }, take: 30 }),
      this.prisma.lorebookEntry.findMany({ where: { projectId: context.projectId, status: 'active' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 30 }),
    ]);

    return {
      project: { id: project.id, title: project.title, genre: project.genre, theme: project.theme, tone: project.tone, synopsis: project.synopsis, outline: project.outline },
      volumes: volumes.map((item) => ({ id: item.id, volumeNo: item.volumeNo, title: item.title, synopsis: item.synopsis, objective: item.objective, chapterCount: item.chapterCount })),
      existingChapters: chapters.map((item) => ({ chapterNo: item.chapterNo, title: item.title, objective: item.objective, conflict: item.conflict, outline: item.outline })),
      characters: characters.map((item) => ({ name: item.name, roleType: item.roleType, motivation: item.motivation })),
      lorebookEntries: lorebookEntries.map((item) => ({ title: item.title, entryType: item.entryType, summary: item.summary })),
    };
  }
}