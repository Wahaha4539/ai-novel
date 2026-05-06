export type ImportAssetType = 'projectProfile' | 'outline' | 'characters' | 'worldbuilding' | 'writingRules';

export const IMPORT_ASSET_TYPES: ImportAssetType[] = ['projectProfile', 'outline', 'characters', 'worldbuilding', 'writingRules'];
const DEFAULT_IMPORT_ASSET_TYPES = IMPORT_ASSET_TYPES;

export interface ImportPreviewOutput {
  requestedAssetTypes?: ImportAssetType[];
  projectProfile: { title?: string; genre?: string; theme?: string; tone?: string; logline?: string; synopsis?: string; outline?: string };
  characters: Array<{ name: string; roleType?: string; personalityCore?: string; motivation?: string; backstory?: string }>;
  lorebookEntries: Array<{ title: string; entryType: string; content: string; summary?: string; tags?: string[] }>;
  writingRules: Array<{ title: string; ruleType: string; content: string; severity?: 'info' | 'warning' | 'error'; appliesFromChapterNo?: number; appliesToChapterNo?: number; entityType?: string; entityRef?: string; status?: string }>;
  volumes: Array<{ volumeNo: number; title: string; synopsis?: string; objective?: string; chapterCount?: number }>;
  chapters: Array<{ chapterNo: number; volumeNo?: number; title: string; objective?: string; conflict?: string; hook?: string; outline?: string; expectedWordCount?: number }>;
  risks: string[];
}

export function normalizeImportAssetTypes(value?: unknown, instruction = ''): ImportAssetType[] {
  const explicit = normalizeExplicitAssetTypes(value);
  if (explicit.length) return explicit;
  const inferred = inferImportAssetTypes(instruction);
  return inferred.length ? inferred : [...DEFAULT_IMPORT_ASSET_TYPES];
}

export function filterImportPreviewByAssetTypes(preview: ImportPreviewOutput): ImportPreviewOutput {
  const requestedAssetTypes = normalizeImportAssetTypes(preview.requestedAssetTypes);
  const requested = new Set(requestedAssetTypes);
  return {
    ...preview,
    requestedAssetTypes,
    projectProfile: {
      title: requested.has('projectProfile') ? preview.projectProfile?.title : undefined,
      genre: requested.has('projectProfile') ? preview.projectProfile?.genre : undefined,
      theme: requested.has('projectProfile') ? preview.projectProfile?.theme : undefined,
      tone: requested.has('projectProfile') ? preview.projectProfile?.tone : undefined,
      logline: requested.has('projectProfile') ? preview.projectProfile?.logline : undefined,
      synopsis: requested.has('projectProfile') ? preview.projectProfile?.synopsis : undefined,
      outline: requested.has('outline') ? preview.projectProfile?.outline : undefined,
    },
    characters: requested.has('characters') ? preview.characters ?? [] : [],
    lorebookEntries: requested.has('worldbuilding') ? preview.lorebookEntries ?? [] : [],
    writingRules: requested.has('writingRules') ? preview.writingRules ?? [] : [],
    volumes: requested.has('outline') ? preview.volumes ?? [] : [],
    chapters: requested.has('outline') ? preview.chapters ?? [] : [],
    risks: preview.risks ?? [],
  };
}

function normalizeExplicitAssetTypes(value: unknown): ImportAssetType[] {
  const rawItems = Array.isArray(value) ? value : value === undefined || value === null ? [] : String(value).split(/[,\s，、]+/);
  const normalized = rawItems
    .map((item) => assetTypeFromToken(String(item)))
    .filter((item): item is ImportAssetType => Boolean(item));
  return [...new Set(normalized)];
}

function inferImportAssetTypes(instruction: string): ImportAssetType[] {
  const text = instruction.toLowerCase();
  if (!text.trim()) return [];
  const inferred: ImportAssetType[] = [];
  if (/(项目资料|项目档案|项目信息|作品资料|作品简介|书名|标题|题材|主题|基调|简介|梗概|logline|synopsis|profile)/i.test(text)) inferred.push('projectProfile');
  if (/(剧情大纲|故事大纲|章节大纲|大纲|卷纲|分卷|卷\s*[\d一二三四五六七八九十]+|章节规划|章节|outline|plot)/i.test(text)) inferred.push('outline');
  if (/(角色|人物|人设|主角|配角|反派|character)/i.test(text)) inferred.push('characters');
  if (/(世界观|世界设定|背景设定|设定库|世界规则|地点|势力|组织|宗门|能力体系|历史|lore|worldbuilding|setting)/i.test(text)) inferred.push('worldbuilding');
  if (/(写作规则|写作规范|创作规则|禁写|禁忌|风格约束|视角|人称|口吻|文风|rule|style|pov)/i.test(text)) inferred.push('writingRules');
  if (!inferred.length && /(全套|全部|完整|一整套|初始化|导入|拆解|整理成项目|生成项目|import)/i.test(text)) return [...DEFAULT_IMPORT_ASSET_TYPES];
  return [...new Set(inferred)];
}

function assetTypeFromToken(token: string): ImportAssetType | undefined {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['projectprofile', 'project_profile', 'profile', 'project', 'metadata', '项目资料', '项目信息', '作品资料'].includes(normalized)) return 'projectProfile';
  if (['outline', 'plot', 'plotoutline', 'storyoutline', '剧情大纲', '故事大纲', '大纲', '章节', '卷章'].includes(normalized)) return 'outline';
  if (['character', 'characters', 'roles', '角色', '人物', '人设'].includes(normalized)) return 'characters';
  if (['worldbuilding', 'world', 'lorebook', 'lorebookentries', 'lore', 'settings', 'setting', '世界观', '世界设定', '设定'].includes(normalized)) return 'worldbuilding';
  if (['writingrules', 'writing_rules', 'rules', 'rule', 'style', '写作规则', '写作规范', '规则'].includes(normalized)) return 'writingRules';
  return undefined;
}
