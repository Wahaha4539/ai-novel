import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface ResolveCharacterInput {
  characterId?: string;
  characterRef?: string;
}

interface ResolveCharacterOutput {
  characterId: string;
  name: string;
  aliases: string[];
  role: string | null;
  confidence: number;
  alternatives: Array<{ characterId: string; name: string; aliases: string[]; role: string | null; confidence: number }>;
  needsUserChoice: boolean;
}

/**
 * 角色解析工具：把“男主/女主/反派/别名/姓名”等自然语言角色引用解析为真实 characterId。
 * 工具只读项目内角色表；低置信度或多候选时返回 needsUserChoice，避免误写入。
 */
@Injectable()
export class ResolveCharacterTool implements BaseTool<ResolveCharacterInput, ResolveCharacterOutput> {
  name = 'resolve_character';
  description = '根据角色 ID、姓名、别名或“男主/女主/反派”等引用解析项目内角色。';
  inputSchema = { type: 'object' as const, additionalProperties: false, properties: { characterId: { type: 'string' as const, minLength: 1 }, characterRef: { type: 'string' as const, minLength: 1 } } };
  outputSchema = { type: 'object' as const, required: ['characterId', 'name', 'aliases', 'confidence', 'alternatives', 'needsUserChoice'], properties: { characterId: { type: 'string' as const, minLength: 1 }, name: { type: 'string' as const, minLength: 1 }, aliases: { type: 'array' as const }, role: { type: ['string', 'null'] as const }, confidence: { type: 'number' as const, minimum: 0, maximum: 1 }, alternatives: { type: 'array' as const }, needsUserChoice: { type: 'boolean' as const } } };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '解析角色引用',
    description: '把“男主”“女主”“反派”“师姐”或角色别名解析为真实 characterId。',
    whenToUse: ['用户要求检查人设、角色一致性或角色相关修改', '目标工具需要 characterId 但用户使用自然语言角色引用'],
    whenNotToUse: ['任务不涉及角色实体', '上下文已明确 characterId 且没有歧义'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: { characterRef: { source: 'user_message', description: '用户原话中的角色引用，例如“男主”“小林”“师姐”。' } },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['characterId'], allowedSources: ['resolve_character.output.characterId'] },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ResolveCharacterInput, context: ToolContext): Promise<ResolveCharacterOutput> {
    if (args.characterId) {
      const character = await this.prisma.character.findFirst({ where: { id: args.characterId, projectId: context.projectId } });
      if (!character) throw new NotFoundException(`角色不存在或不属于当前项目：${args.characterId}`);
      return this.toOutput(character, 1, []);
    }

    const ref = args.characterRef?.trim();
    if (!ref) throw new BadRequestException('resolve_character 需要 characterId 或 characterRef');

    const characters = await this.prisma.character.findMany({ where: { projectId: context.projectId }, orderBy: { createdAt: 'asc' }, take: 80 });
    const scored = characters
      .map((character) => ({ character, confidence: this.scoreCharacter(character, ref) }))
      .filter((item) => item.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);
    if (!scored.length) throw new NotFoundException(`未找到匹配角色：${ref}`);

    const [best, second] = scored;
    const alternatives = scored.slice(1, 5).map((item) => this.toAlternative(item.character, item.confidence));
    const needsUserChoice = best.confidence < 0.85 || (second ? best.confidence - second.confidence < 0.12 : false);
    return this.toOutput(best.character, best.confidence, alternatives, needsUserChoice);
  }

  private scoreCharacter(character: { name: string; alias: unknown; roleType: string | null }, ref: string) {
    const aliases = this.stringArray(character.alias);
    if (character.name === ref || aliases.includes(ref)) return 1;
    const roleMap: Record<string, string[]> = {
      男主: ['protagonist', 'male_lead', 'hero', 'main'],
      主角: ['protagonist', 'main'],
      女主: ['female_lead', 'heroine'],
      反派: ['antagonist', 'villain'],
    };
    const role = (character.roleType ?? '').toLowerCase();
    if (roleMap[ref]?.some((keyword) => role.includes(keyword))) return 0.94;
    if (character.name.includes(ref) || aliases.some((alias) => alias.includes(ref))) return 0.74;
    return 0;
  }

  private toOutput(character: { id: string; name: string; alias: unknown; roleType: string | null }, confidence: number, alternatives: ResolveCharacterOutput['alternatives'], needsUserChoice = false): ResolveCharacterOutput {
    return { characterId: character.id, name: character.name, aliases: this.stringArray(character.alias), role: character.roleType, confidence, alternatives, needsUserChoice };
  }

  private toAlternative(character: { id: string; name: string; alias: unknown; roleType: string | null }, confidence: number) {
    return { characterId: character.id, name: character.name, aliases: this.stringArray(character.alias), role: character.roleType, confidence };
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  }
}