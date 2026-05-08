import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';

interface PersistOutlineInput {
  preview?: OutlinePreviewOutput;
}

/**
 * 大纲持久化工具：用户审批后将预览写入 Volume 和 Chapter。
 * 为避免覆盖已写正文，本工具只创建缺失章节并更新未起草章节的大纲字段。
 */
@Injectable()
export class PersistOutlineTool implements BaseTool<PersistOutlineInput, Record<string, unknown>> {
  name = 'persist_outline';
  description = '审批后将大纲预览写入卷和章节，只更新未起草章节，避免覆盖已确认正文。';
  inputSchema = { type: 'object' as const, required: ['preview'], additionalProperties: false, properties: { preview: { type: 'object' as const, required: ['volume', 'chapters'], properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const } } } } };
  outputSchema = {
    type: 'object' as const,
    required: ['volumeId', 'createdCount', 'updatedCount', 'skippedCount', 'chapterCount'],
    properties: {
      volumeId: { type: 'string' as const, minLength: 1 },
      createdCount: { type: 'number' as const, minimum: 0 },
      updatedCount: { type: 'number' as const, minimum: 0 },
      skippedCount: { type: 'number' as const, minimum: 0 },
      chapterCount: { type: 'number' as const, minimum: 0 },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['upsert_volume', 'create_or_update_planned_chapters'];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: PersistOutlineInput, context: ToolContext) {
    if (!args.preview?.chapters?.length) throw new BadRequestException('persist_outline 需要 outline preview');
    const preview = args.preview;
    this.assertSafePreview(preview);

    const result = await this.prisma.$transaction(async (tx) => {
      const narrativePlan = this.asInputJsonObject(preview.volume.narrativePlan);
      const volumeData = {
        title: preview.volume.title,
        synopsis: preview.volume.synopsis,
        objective: preview.volume.objective,
        chapterCount: preview.volume.chapterCount,
        ...(narrativePlan ? { narrativePlan } : {}),
      };
      const volume = await tx.volume.upsert({
        where: { projectId_volumeNo: { projectId: context.projectId, volumeNo: preview.volume.volumeNo } },
        update: volumeData,
        create: { projectId: context.projectId, volumeNo: preview.volume.volumeNo, ...volumeData },
      });

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      for (const chapter of preview.chapters) {
        const existing = await tx.chapter.findUnique({ where: { projectId_chapterNo: { projectId: context.projectId, chapterNo: chapter.chapterNo } } });
        const craftBrief = this.asInputJsonObject(chapter.craftBrief);
        const data = {
          volumeId: volume.id,
          title: chapter.title,
          objective: chapter.objective,
          conflict: chapter.conflict,
          revealPoints: chapter.hook,
          outline: chapter.outline,
          expectedWordCount: chapter.expectedWordCount,
          ...(craftBrief ? { craftBrief } : {}),
        };
        if (!existing) {
          await tx.chapter.create({ data: { projectId: context.projectId, chapterNo: chapter.chapterNo, ...data } });
          createdCount += 1;
        } else if (existing.status === 'planned') {
          await tx.chapter.update({ where: { id: existing.id }, data });
          updatedCount += 1;
        } else {
          // 已起草/已审阅章节不自动覆盖，避免 Agent 破坏用户确认过的正文和事实。
          skippedCount += 1;
        }
      }
      return { volumeId: volume.id, createdCount, updatedCount, skippedCount };
    });

    return { ...result, chapterCount: preview.chapters.length, risks: preview.risks };
  }

  /** 写入前做一次确定性保护，防止绕过 validate_outline 的重复编号预览进入持久化。 */
  private assertSafePreview(preview: OutlinePreviewOutput) {
    const chapterNos = preview.chapters.map((chapter) => Number(chapter.chapterNo));
    if (!Number.isFinite(Number(preview.volume.volumeNo)) || Number(preview.volume.volumeNo) <= 0) throw new BadRequestException('卷号必须是正数');
    if (chapterNos.some((chapterNo) => !Number.isFinite(chapterNo) || chapterNo <= 0)) throw new BadRequestException('章节编号必须是正数');
    const duplicated = chapterNos.filter((chapterNo, index) => chapterNos.indexOf(chapterNo) !== index);
    if (duplicated.length) throw new BadRequestException(`章节编号重复，已阻止写入：${[...new Set(duplicated)].join(', ')}`);
  }

  private asInputJsonObject(value: unknown): Prisma.InputJsonObject | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length ? record as Prisma.InputJsonObject : undefined;
  }
}
