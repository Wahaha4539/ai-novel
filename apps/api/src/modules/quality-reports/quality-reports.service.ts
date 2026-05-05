import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQualityReportDto } from './dto/create-quality-report.dto';
import { ListQualityReportsQueryDto, QUALITY_REPORT_SOURCE_TYPES, QUALITY_REPORT_VERDICTS } from './dto/list-quality-reports-query.dto';
import { UpdateQualityReportDto } from './dto/update-quality-report.dto';

type QualityReportRefs = {
  chapterId?: string | null;
  draftId?: string | null;
  agentRunId?: string | null;
};

@Injectable()
export class QualityReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateQualityReportDto) {
    await this.assertProjectExists(projectId);
    const refs = await this.resolveRefs(projectId, dto);

    const report = await this.prisma.qualityReport.create({
      data: {
        projectId,
        chapterId: refs.chapterId,
        draftId: refs.draftId,
        agentRunId: refs.agentRunId,
        sourceType: this.normalizeSourceType(dto.sourceType),
        sourceId: this.normalizeNullableId(dto.sourceId),
        reportType: this.normalizeReportType(dto.reportType),
        scores: this.normalizeJsonObject(dto.scores, 'scores') as Prisma.InputJsonValue,
        issues: this.normalizeJsonArray(dto.issues, 'issues') as Prisma.InputJsonValue,
        verdict: this.normalizeVerdict(dto.verdict),
        summary: this.normalizeNullableText(dto.summary),
        metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue,
      },
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return report;
  }

  async list(projectId: string, query: ListQualityReportsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    const refs = await this.resolveRefs(projectId, query);
    return this.prisma.qualityReport.findMany({
      where: {
        projectId,
        ...(refs.chapterId ? { chapterId: refs.chapterId } : {}),
        ...(refs.draftId ? { draftId: refs.draftId } : {}),
        ...(refs.agentRunId ? { agentRunId: refs.agentRunId } : {}),
        ...(query.sourceType ? { sourceType: this.normalizeSourceType(query.sourceType) } : {}),
        ...(query.reportType ? { reportType: this.normalizeReportType(query.reportType) } : {}),
        ...(query.verdict ? { verdict: this.normalizeVerdict(query.verdict) } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
  }

  async update(projectId: string, reportId: string, dto: UpdateQualityReportDto) {
    const existing = await this.prisma.qualityReport.findFirst({
      where: { id: reportId, projectId },
      select: { id: true, chapterId: true, draftId: true, agentRunId: true },
    });
    if (!existing) {
      throw new NotFoundException(`QualityReport not found: ${reportId}`);
    }

    const refs = await this.resolveRefs(projectId, {
      chapterId: dto.chapterId === undefined ? existing.chapterId : dto.chapterId,
      draftId: dto.draftId === undefined ? existing.draftId : dto.draftId,
      agentRunId: dto.agentRunId === undefined ? existing.agentRunId : dto.agentRunId,
    });

    const data = {
      ...(dto.chapterId !== undefined || dto.draftId !== undefined ? { chapterId: refs.chapterId } : {}),
      ...(dto.draftId !== undefined ? { draftId: refs.draftId } : {}),
      ...(dto.agentRunId !== undefined ? { agentRunId: refs.agentRunId } : {}),
      ...(dto.sourceType !== undefined && { sourceType: this.normalizeSourceType(dto.sourceType) }),
      ...(dto.sourceId !== undefined && { sourceId: this.normalizeNullableId(dto.sourceId) }),
      ...(dto.reportType !== undefined && { reportType: this.normalizeReportType(dto.reportType) }),
      ...(dto.scores !== undefined && { scores: this.normalizeJsonObject(dto.scores, 'scores') as Prisma.InputJsonValue }),
      ...(dto.issues !== undefined && { issues: this.normalizeJsonArray(dto.issues, 'issues') as Prisma.InputJsonValue }),
      ...(dto.verdict !== undefined && { verdict: this.normalizeVerdict(dto.verdict) }),
      ...(dto.summary !== undefined && { summary: this.normalizeNullableText(dto.summary) }),
      ...(dto.metadata !== undefined && { metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue }),
    };

    await this.prisma.qualityReport.updateMany({
      where: { id: reportId, projectId },
      data,
    });

    const updated = await this.prisma.qualityReport.findFirst({ where: { id: reportId, projectId } });
    if (!updated) {
      throw new NotFoundException(`QualityReport not found: ${reportId}`);
    }

    await this.cacheService.deleteProjectRecallResults(projectId);
    return updated;
  }

  async remove(projectId: string, reportId: string) {
    const existing = await this.prisma.qualityReport.findFirst({
      where: { id: reportId, projectId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`QualityReport not found: ${reportId}`);
    }

    await this.prisma.qualityReport.deleteMany({ where: { id: reportId, projectId } });
    await this.cacheService.deleteProjectRecallResults(projectId);
    return { deleted: true, id: reportId };
  }

  private async resolveRefs(projectId: string, refs: QualityReportRefs): Promise<Required<QualityReportRefs>> {
    const draftId = this.normalizeNullableId(refs.draftId);
    let chapterId = this.normalizeNullableId(refs.chapterId);
    const agentRunId = this.normalizeNullableId(refs.agentRunId);

    if (draftId) {
      const draft = await this.prisma.chapterDraft.findFirst({
        where: { id: draftId, chapter: { projectId } },
        select: { id: true, chapterId: true },
      });
      if (!draft) {
        throw new BadRequestException(`Draft not found in project: ${draftId}`);
      }
      if (chapterId && chapterId !== draft.chapterId) {
        throw new BadRequestException('draftId does not belong to chapterId.');
      }
      chapterId = draft.chapterId;
    }

    if (chapterId) {
      const chapter = await this.prisma.chapter.findFirst({ where: { id: chapterId, projectId }, select: { id: true } });
      if (!chapter) {
        throw new BadRequestException(`Chapter not found in project: ${chapterId}`);
      }
    }

    if (agentRunId) {
      const run = await this.prisma.agentRun.findFirst({ where: { id: agentRunId, projectId }, select: { id: true } });
      if (!run) {
        throw new BadRequestException(`AgentRun not found in project: ${agentRunId}`);
      }
    }

    return { chapterId: chapterId ?? null, draftId: draftId ?? null, agentRunId: agentRunId ?? null };
  }

  private normalizeSourceType(value: string): string {
    if (!(QUALITY_REPORT_SOURCE_TYPES as readonly string[]).includes(value)) {
      throw new BadRequestException(`sourceType must be one of: ${QUALITY_REPORT_SOURCE_TYPES.join(', ')}`);
    }
    return value;
  }

  private normalizeVerdict(value: string): string {
    if (!(QUALITY_REPORT_VERDICTS as readonly string[]).includes(value)) {
      throw new BadRequestException(`verdict must be one of: ${QUALITY_REPORT_VERDICTS.join(', ')}`);
    }
    return value;
  }

  private normalizeReportType(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) {
      throw new BadRequestException('reportType must be a non-empty string up to 80 characters.');
    }
    return trimmed;
  }

  private normalizeNullableId(value: string | null | undefined): string | null {
    if (value === undefined || value === null || value === '') return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)) {
      throw new BadRequestException('id fields must be UUID strings.');
    }
    return trimmed;
  }

  private normalizeNullableText(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private normalizeJsonObject(value: unknown, field: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
  }

  private normalizeJsonArray(value: unknown, field: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a JSON array.`);
    }
    return value;
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }
}
