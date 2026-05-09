import type { LlmChatMessage } from '../../llm/dto/llm-chat.dto';

const IMPORT_TARGET_KEYS = ['projectProfile', 'characters', 'lorebookEntries', 'writingRules', 'volumes', 'chapters'] as const;

export interface ImportPreviewRepairPromptInput {
  toolName: string;
  targetDescription: string;
  validationError: string;
  invalidOutput: unknown;
  instruction?: string;
  sourceText?: string;
  allowedTopLevelKeys: string[];
  repairableAliases?: string[];
  requestedAssetTypes?: string[];
}

export function buildImportPreviewRepairMessages(input: ImportPreviewRepairPromptInput): LlmChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are an AI Novel import-preview JSON structure repairer. Return strict JSON only, with no Markdown or explanation.',
        'Repair only wrapping fields, enum aliases, and local non-content structure errors. Preserve source-derived content; do not invent missing assets, summaries, chapters, characters, lore, or writing rules.',
        'Do not expand the requested target scope. If the invalid output contains unrequested import targets or lacks the actual asset content, the backend will fail.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(
        {
          toolName: input.toolName,
          targetDescription: input.targetDescription,
          requestedAssetTypes: input.requestedAssetTypes ?? null,
          allowedTopLevelKeys: input.allowedTopLevelKeys,
          repairableAliases: input.repairableAliases ?? [],
          validationError: input.validationError,
          userInstruction: input.instruction ?? null,
          sourceExcerpt: input.sourceText?.slice(0, 8000) ?? null,
          invalidOutput: input.invalidOutput,
          repairContract: {
            preserveTargetScope: 'do not add projectProfile, characters, lorebookEntries, writingRules, volumes, or chapters unless that key is explicitly allowed',
            preserveContent: 'do not create new asset content to cover missing extraction; only move/rename fields that are already present in invalidOutput',
            output: 'return the complete JSON object expected by the tool',
          },
        },
        null,
        2,
      ),
    },
  ];
}

export function assertNoUnexpectedImportTargets(data: unknown, allowedTopLevelKeys: string[], toolName: string, options: { forbiddenProjectProfileFields?: string[] } = {}): void {
  const record = asRecord(data);
  const allowed = new Set(allowedTopLevelKeys);
  const unexpected = IMPORT_TARGET_KEYS.filter((key) => !allowed.has(key) && hasImportContent(record[key]));
  const profile = asRecord(record.projectProfile);
  const forbiddenProfileFields = (options.forbiddenProjectProfileFields ?? []).filter((field) => hasImportContent(profile[field]));
  if (unexpected.length || forbiddenProfileFields.length) {
    const fields = [
      ...unexpected,
      ...forbiddenProfileFields.map((field) => `projectProfile.${field}`),
    ];
    throw new Error(`${toolName} returned unrequested import targets: ${fields.join(', ')}.`);
  }
}

export function shouldRepairImportPreviewOutput(input: {
  data: unknown;
  error: unknown;
  toolName: string;
  targetKeys: string[];
  repairableAliases?: string[];
  localFieldPattern?: RegExp;
}): boolean {
  const message = errorMessage(input.error);
  if (/unrequested import targets|asset count|chapter count|returned chapters \d+\/\d+|missing target/.test(message)) return false;
  const record = asRecord(input.data);
  if (!Object.keys(record).length) return false;
  const aliases = input.repairableAliases ?? [];
  if (aliases.some((alias) => hasImportContent(record[alias]))) return true;
  if (input.targetKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key))) {
    if (/risks must be an array|must be an array|must be an object|missing required wrapper/.test(message)) return true;
    if (input.localFieldPattern?.test(message)) return true;
  }
  return false;
}

export function requiredImportArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

export function requiredImportObject(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!Object.keys(record).length) throw new Error(`${label} must be an object.`);
  return record;
}

export function requiredImportText(value: unknown, label: string, coerce: (value: unknown) => string | undefined): string {
  const text = coerce(value);
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

export function assertRisksArray(value: unknown): void {
  if (value !== undefined && !Array.isArray(value)) throw new Error('risks must be an array.');
}

function hasImportContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImportContent);
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasImportContent);
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
