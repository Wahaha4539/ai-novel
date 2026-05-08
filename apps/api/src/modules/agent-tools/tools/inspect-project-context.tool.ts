import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface InspectProjectContextOutput {
  project: { id: string; title: string; genre: string | null; theme: string | null; tone: string | null; synopsis: string | null; outline: string | null };
  volumes: Array<{ id: string; volumeNo: number; title: string | null; synopsis: string | null; objective: string | null; chapterCount: number | null; narrativePlan: unknown }>;
  existingChapters: Array<{ chapterNo: number; title: string | null; objective: string | null; conflict: string | null; outline: string | null }>;
  characters: Array<{
    name: string;
    aliases: string[];
    roleType: string | null;
    motivation: string | null;
    personalityCore: string | null;
    scope: string | null;
    activeFromChapter: number | null;
    activeToChapter: number | null;
    source: string;
    relationshipAnchors: string[];
  }>;
  relationships: Array<{
    characterAName: string;
    characterBName: string;
    relationType: string;
    publicState: string | null;
    hiddenState: string | null;
    conflictPoint: string | null;
    emotionalArc: string | null;
    turnChapterNos: number[];
    finalState: string | null;
    status: string;
  }>;
  characterStates: Array<{ characterName: string; chapterNo: number | null; stateType: string; stateValue: string; summary: string | null; status: string }>;
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
    required: ['project', 'volumes', 'existingChapters', 'characters', 'relationships', 'characterStates', 'lorebookEntries'],
    properties: {
      project: { type: 'object' as const },
      volumes: { type: 'array' as const },
      existingChapters: { type: 'array' as const },
      characters: { type: 'array' as const },
      relationships: { type: 'array' as const },
      characterStates: { type: 'array' as const },
      lorebookEntries: { type: 'array' as const },
    },
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

    const [volumes, chapters, characters, relationshipEdges, characterStates, lorebookEntries] = await Promise.all([
      this.prisma.volume.findMany({ where: { projectId: context.projectId }, orderBy: { volumeNo: 'asc' }, take: 12 }),
      this.prisma.chapter.findMany({ where: { projectId: context.projectId }, orderBy: { chapterNo: 'asc' }, take: 200 }),
      this.prisma.character.findMany({ where: { projectId: context.projectId }, orderBy: { createdAt: 'asc' }, take: 60 }),
      this.prisma.relationshipEdge.findMany({ where: { projectId: context.projectId, status: 'active' }, orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }], take: 80 }),
      this.prisma.characterStateSnapshot.findMany({ where: { projectId: context.projectId }, orderBy: [{ chapterNo: 'desc' }, { updatedAt: 'desc' }], take: 80 }),
      this.prisma.lorebookEntry.findMany({ where: { projectId: context.projectId, status: 'active' }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 30 }),
    ]);
    const relationshipAnchors = this.buildRelationshipAnchors(relationshipEdges);

    return {
      project: { id: project.id, title: project.title, genre: project.genre, theme: project.theme, tone: project.tone, synopsis: project.synopsis, outline: project.outline },
      volumes: volumes.map((item) => ({ id: item.id, volumeNo: item.volumeNo, title: item.title, synopsis: item.synopsis, objective: item.objective, chapterCount: item.chapterCount, narrativePlan: item.narrativePlan })),
      existingChapters: chapters.map((item) => ({ chapterNo: item.chapterNo, title: item.title, objective: item.objective, conflict: item.conflict, outline: item.outline })),
      characters: characters.map((item) => ({
        name: item.name,
        aliases: this.stringArray(item.alias),
        roleType: item.roleType,
        motivation: item.motivation,
        personalityCore: item.personalityCore,
        scope: item.scope,
        activeFromChapter: item.activeFromChapter,
        activeToChapter: item.activeToChapter,
        source: item.source,
        relationshipAnchors: relationshipAnchors.get(item.name) ?? [],
      })),
      relationships: relationshipEdges.map((item) => ({
        characterAName: item.characterAName,
        characterBName: item.characterBName,
        relationType: item.relationType,
        publicState: item.publicState,
        hiddenState: item.hiddenState,
        conflictPoint: item.conflictPoint,
        emotionalArc: item.emotionalArc,
        turnChapterNos: this.numberArray(item.turnChapterNos),
        finalState: item.finalState,
        status: item.status,
      })),
      characterStates: characterStates.map((item) => ({
        characterName: item.characterName,
        chapterNo: item.chapterNo,
        stateType: item.stateType,
        stateValue: item.stateValue,
        summary: item.summary,
        status: item.status,
      })),
      lorebookEntries: lorebookEntries.map((item) => ({ title: item.title, entryType: item.entryType, summary: item.summary })),
    };
  }

  private buildRelationshipAnchors(edges: Array<{ characterAName: string; characterBName: string; relationType: string; publicState: string | null }>): Map<string, string[]> {
    const anchors = new Map<string, string[]>();
    for (const edge of edges) {
      this.addRelationshipAnchor(anchors, edge.characterAName, edge.characterBName, edge.relationType, edge.publicState);
      this.addRelationshipAnchor(anchors, edge.characterBName, edge.characterAName, edge.relationType, edge.publicState);
    }
    for (const [name, items] of anchors.entries()) anchors.set(name, items.slice(0, 8));
    return anchors;
  }

  private addRelationshipAnchor(anchors: Map<string, string[]>, name: string, otherName: string, relationType: string, publicState: string | null): void {
    const current = anchors.get(name) ?? [];
    current.push([otherName, relationType, publicState].filter(Boolean).join('｜'));
    anchors.set(name, current);
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  }

  private numberArray(value: unknown): number[] {
    return Array.isArray(value)
      ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item))
      : [];
  }
}
