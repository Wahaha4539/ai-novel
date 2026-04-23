import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePromptTemplateDto } from './dto/create-prompt-template.dto';
import { UpdatePromptTemplateDto } from './dto/update-prompt-template.dto';

@Injectable()
export class PromptTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** List global templates, optionally filtered by stepKey */
  async listGlobal(stepKey?: string) {
    return this.prisma.promptTemplate.findMany({
      where: {
        projectId: null,
        ...(stepKey && { stepKey }),
      },
      orderBy: [{ stepKey: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  /**
   * List merged templates for a project: global templates as base,
   * project-level templates override by (stepKey + name).
   */
  async listForProject(projectId: string, stepKey?: string) {
    const whereBase = stepKey ? { stepKey } : {};

    const [globalTemplates, projectTemplates] = await Promise.all([
      this.prisma.promptTemplate.findMany({
        where: { projectId: null, ...whereBase },
        orderBy: [{ stepKey: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.promptTemplate.findMany({
        where: { projectId, ...whereBase },
        orderBy: [{ stepKey: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
      }),
    ]);

    // Project templates override global by (stepKey, name)
    const projectKeys = new Set(
      projectTemplates.map((t) => `${t.stepKey}::${t.name}`),
    );

    const merged = [
      ...globalTemplates.filter((t) => !projectKeys.has(`${t.stepKey}::${t.name}`)),
      ...projectTemplates,
    ];

    merged.sort((a, b) => {
      const stepCmp = a.stepKey.localeCompare(b.stepKey);
      if (stepCmp !== 0) return stepCmp;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return merged;
  }

  async create(dto: CreatePromptTemplateDto) {
    // If this template is set as default, unset other defaults for the same scope
    if (dto.isDefault) {
      await this.prisma.promptTemplate.updateMany({
        where: {
          projectId: dto.projectId ?? null,
          stepKey: dto.stepKey,
          isDefault: true,
        },
        data: { isDefault: false },
      });
    }

    return this.prisma.promptTemplate.create({
      data: {
        projectId: dto.projectId ?? null,
        stepKey: dto.stepKey,
        name: dto.name,
        description: dto.description,
        systemPrompt: dto.systemPrompt,
        userTemplate: dto.userTemplate,
        version: dto.version ?? 1,
        isDefault: dto.isDefault ?? false,
        tags: dto.tags ?? [],
        effectPreview: dto.effectPreview,
      },
    });
  }

  async update(id: string, dto: UpdatePromptTemplateDto) {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException(`提示词模板不存在：${id}`);
    }

    // If setting as default, unset other defaults for the same scope
    if (dto.isDefault === true) {
      await this.prisma.promptTemplate.updateMany({
        where: {
          projectId: template.projectId,
          stepKey: template.stepKey,
          isDefault: true,
          id: { not: id },
        },
        data: { isDefault: false },
      });
    }

    return this.prisma.promptTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.systemPrompt !== undefined && { systemPrompt: dto.systemPrompt }),
        ...(dto.userTemplate !== undefined && { userTemplate: dto.userTemplate }),
        ...(dto.version !== undefined && { version: dto.version }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.tags !== undefined && { tags: dto.tags }),
        ...(dto.effectPreview !== undefined && { effectPreview: dto.effectPreview }),
      },
    });
  }

  async setDefault(id: string) {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException(`提示词模板不存在：${id}`);
    }

    // Unset all other defaults for the same (projectId, stepKey)
    await this.prisma.promptTemplate.updateMany({
      where: {
        projectId: template.projectId,
        stepKey: template.stepKey,
        isDefault: true,
        id: { not: id },
      },
      data: { isDefault: false },
    });

    return this.prisma.promptTemplate.update({
      where: { id },
      data: { isDefault: true },
    });
  }

  async remove(id: string) {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException(`提示词模板不存在：${id}`);
    }

    await this.prisma.promptTemplate.delete({ where: { id } });
    return { deleted: true, id };
  }
}
