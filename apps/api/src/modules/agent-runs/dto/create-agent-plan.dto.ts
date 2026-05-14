import { IsArray, IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export interface GuidedAgentPlanContextDto {
  currentStep?: string;
  currentStepLabel?: string;
  currentStepData?: Record<string, unknown>;
  completedSteps?: string[];
  documentDraft?: Record<string, unknown>;
}

export type ImportAssetTypeDto = 'projectProfile' | 'outline' | 'characters' | 'worldbuilding' | 'writingRules';
export type ImportPreviewModeDto = 'auto' | 'quick' | 'deep';

export interface CreateAgentPlanContextDto {
  currentProjectId?: string;
  currentVolumeId?: string;
  currentVolumeTitle?: string;
  currentChapterId?: string;
  currentChapterTitle?: string;
  currentChapterIndex?: number;
  currentDraftId?: string;
  currentDraftVersion?: number;
  selectedText?: string;
  selectedRange?: { start: number; end: number };
  selectedParagraphRange?: { start: number; end: number; count?: number };
  selectionIntent?: string;
  sourcePage?: string;
  requestedAssetTypes?: ImportAssetTypeDto[];
  importPreviewMode?: ImportPreviewModeDto;
  guided?: GuidedAgentPlanContextDto;
  [key: string]: unknown;
}

export type AgentCreativeDocumentExtensionDto = 'md' | 'txt' | 'docx' | 'pdf';

export interface AgentCreativeDocumentAttachmentDto {
  id: string;
  kind: 'creative_document';
  provider: 'tmpfile.link';
  fileName: string;
  extension: AgentCreativeDocumentExtensionDto;
  mimeType?: string;
  size: number;
  url: string;
  uploadedAt?: string;
  expiresAt?: string;
  uploadMeta?: Record<string, unknown>;
}

export class CreateAgentPlanDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @MinLength(2)
  message!: string;

  @IsOptional()
  @IsObject()
  context?: CreateAgentPlanContextDto;

  @IsOptional()
  @IsArray()
  attachments?: AgentCreativeDocumentAttachmentDto[];

  /**
   * 调用方生成的幂等键；同一项目内重复提交同一个键时复用已有 AgentRun，
   * 避免前端超时重试导致重复规划和重复消耗 LLM 配额。
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  clientRequestId?: string;
}

export class ReplanAgentRunDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  message?: string;

  @IsOptional()
  @IsObject()
  worldbuildingSelection?: {
    selectedTitles?: string[];
  };

  @IsOptional()
  @IsObject()
  importTargetRegeneration?: {
    assetType?: ImportAssetTypeDto;
  };
}

export class AgentClarificationChoiceDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  label?: string;

  /** 候选实体的结构化 payload；仅作为用户显式选择的上下文写入，不直接触发工具执行。 */
  @IsOptional()
  payload?: unknown;
}

export class SubmitAgentClarificationChoiceDto {
  @IsObject()
  choice!: AgentClarificationChoiceDto;

  @IsOptional()
  @IsString()
  @MinLength(2)
  message?: string;
}
