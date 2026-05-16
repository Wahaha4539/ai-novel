import { Prisma } from '@prisma/client';

type ForeshadowTrackClient = {
  foreshadowTrack: {
    deleteMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
  };
};

type ProjectForeshadowSource = 'project_outline';
type VolumeForeshadowSource = 'volume_outline';
type ChapterForeshadowSource = 'chapter_outline';
export type ForeshadowScope = 'book' | 'cross_volume' | 'volume' | 'cross_chapter' | 'chapter';

interface ProjectForeshadowSyncInput {
  projectId: string;
  outline?: unknown;
  foreshadowTracks: unknown;
  source?: ProjectForeshadowSource;
}

interface VolumeForeshadowSyncInput {
  projectId: string;
  volumeId?: string | null;
  volumeNo: number;
  chapterCount: number;
  narrativePlan: unknown;
  source?: VolumeForeshadowSource;
}

interface ChapterForeshadowSyncInput {
  projectId: string;
  chapters: Array<{
    id: string;
    chapterNo: number;
    volumeNo?: number | null;
    craftBrief?: unknown;
  }>;
  source?: ChapterForeshadowSource;
}

interface ForeshadowSyncResult {
  deletedCount: number;
  createdCount: number;
}

const FORESHADOW_SETUP_RANGE_KEYS = ['appearRange', 'setupRange'] as const;
const FORESHADOW_RECOVER_RANGE_KEYS = ['recoverRange', 'recoveryRange', 'payoffRange'] as const;
const FORESHADOW_RECOVERY_METHOD_KEYS = ['recoveryMethod', 'payoffMethod'] as const;
const FORESHADOW_SCOPES = new Set<ForeshadowScope>(['book', 'cross_volume', 'volume', 'cross_chapter', 'chapter']);
const FORESHADOW_SCOPE_ALIASES: Record<string, ForeshadowScope> = {
  arc: 'book',
  global: 'book',
  whole_book: 'book',
  full_book: 'book',
  cross_arc: 'cross_volume',
  volume_arc: 'volume',
  chapter_arc: 'cross_chapter',
  local: 'chapter',
};

export async function replaceProjectOutlineForeshadowTracks(
  client: ForeshadowTrackClient,
  input: ProjectForeshadowSyncInput,
): Promise<ForeshadowSyncResult> {
  const source = input.source ?? 'project_outline';
  const deleted = await client.foreshadowTrack.deleteMany({
    where: { projectId: input.projectId, source },
  });
  const data = buildProjectOutlineForeshadowTracks(input, source);
  const created = data.length ? await client.foreshadowTrack.createMany({ data }) : { count: 0 };
  return { deletedCount: deleted.count, createdCount: created.count };
}

export async function replaceVolumeOutlineForeshadowTracks(
  client: ForeshadowTrackClient,
  input: VolumeForeshadowSyncInput,
): Promise<ForeshadowSyncResult> {
  const source = input.source ?? 'volume_outline';
  const deleted = await client.foreshadowTrack.deleteMany({
    where: {
      projectId: input.projectId,
      source,
      metadata: { path: ['sourceTrace', 'volumeNo'], equals: input.volumeNo },
    },
  });
  const data = buildVolumeOutlineForeshadowTracks(input, source);
  const created = data.length ? await client.foreshadowTrack.createMany({ data }) : { count: 0 };
  return { deletedCount: deleted.count, createdCount: created.count };
}

export async function replaceChapterOutlineForeshadowTracks(
  client: ForeshadowTrackClient,
  input: ChapterForeshadowSyncInput,
): Promise<ForeshadowSyncResult> {
  const source = input.source ?? 'chapter_outline';
  const chapterIds = input.chapters.map((chapter) => chapter.id);
  const deleted = chapterIds.length
    ? await client.foreshadowTrack.deleteMany({
        where: { projectId: input.projectId, source, chapterId: { in: chapterIds } },
      })
    : { count: 0 };
  const data = dedupeTracks(input.chapters.flatMap((chapter) => buildChapterOutlineForeshadowTracks(input.projectId, chapter, source)));
  const created = data.length ? await client.foreshadowTrack.createMany({ data }) : { count: 0 };
  return { deletedCount: deleted.count, createdCount: created.count };
}

function buildProjectOutlineForeshadowTracks(
  input: ProjectForeshadowSyncInput,
  source: ProjectForeshadowSource,
): Prisma.ForeshadowTrackCreateManyInput[] {
  const items = Array.isArray(input.foreshadowTracks) ? input.foreshadowTracks : [];
  const tracks: Prisma.ForeshadowTrackCreateManyInput[] = [];
  const outlineText = scalarText(input.outline);

  for (const [index, item] of items.entries()) {
    const record = asRecord(item);
    const title = compactText(scalarText(record.title) || scalarText(record.name), 255);
    if (!title) continue;

    const firstSeenChapterNo = positiveInt(record.firstSeenChapterNo) ?? positiveInt(record.plantChapterNo);
    const lastSeenChapterNo = positiveInt(record.lastSeenChapterNo) ?? positiveInt(record.revealChapterNo);
    const payoff = scalarText(record.payoff);
    const detail = compactText(
      scalarText(record.detail)
        || scalarText(record.description)
        || [scalarText(record.plantStage), scalarText(record.revealStage), payoff].filter(Boolean).join('; '),
      4000,
    );

    tracks.push({
      projectId: input.projectId,
      title,
      detail: detail || title,
      status: 'planned',
      scope: normalizeForeshadowScope(record.scope, 'book'),
      source,
      chapterNo: firstSeenChapterNo,
      firstSeenChapterNo,
      lastSeenChapterNo,
      metadata: jsonObject({
        sourceKind: source,
        sourceTrace: {
          sourceType: source,
          projectId: input.projectId,
          itemIndex: index,
        },
        technique: scalarText(record.technique),
        plantStage: scalarText(record.plantStage),
        revealStage: scalarText(record.revealStage),
        plantChapter: scalarText(record.plantChapter),
        revealChapter: scalarText(record.revealChapter),
        involvedCharacters: scalarText(record.involvedCharacters),
        payoff,
        outlineLength: outlineText.length || undefined,
        rawPlan: record,
      }),
    });
  }

  return dedupeTracks(tracks);
}

function buildVolumeOutlineForeshadowTracks(
  input: VolumeForeshadowSyncInput,
  source: VolumeForeshadowSource,
): Prisma.ForeshadowTrackCreateManyInput[] {
  const narrativePlan = asRecord(input.narrativePlan);
  const planItems = Array.isArray(narrativePlan.foreshadowPlan) ? narrativePlan.foreshadowPlan : [];
  const tracks: Prisma.ForeshadowTrackCreateManyInput[] = [];

  for (const [index, item] of planItems.entries()) {
    const record = asRecord(item);
    const itemText = scalarText(item);
    const title = compactText(scalarText(record.name) || scalarText(record.title) || itemText, 255);
    if (!title) continue;

    const setupRangeKey = firstPresentKey(record, FORESHADOW_SETUP_RANGE_KEYS);
    const recoverRangeKey = firstPresentKey(record, FORESHADOW_RECOVER_RANGE_KEYS);
    const recoveryMethodKey = firstPresentKey(record, FORESHADOW_RECOVERY_METHOD_KEYS);
    const setupRange = readChapterRange(setupRangeKey ? record[setupRangeKey] : undefined);
    const recoverRange = readChapterRange(recoverRangeKey ? record[recoverRangeKey] : undefined);
    const recoveryMethod = recoveryMethodKey ? scalarText(record[recoveryMethodKey]) : '';
    const scope = normalizeForeshadowScope(record.scope, 'volume');
    const detail = compactText(
      scalarText(record.detail)
        || scalarText(record.description)
        || [formatRange('setup', setupRange), formatRange('recover', recoverRange), recoveryMethod ? `method: ${recoveryMethod}` : '', itemText && itemText !== title ? itemText : ''].filter(Boolean).join('; '),
      4000,
    );

    tracks.push({
      projectId: input.projectId,
      title,
      detail: detail || title,
      status: 'planned',
      scope,
      source,
      chapterNo: setupRange.start,
      firstSeenChapterNo: setupRange.start,
      lastSeenChapterNo: recoverRange.end ?? recoverRange.start ?? setupRange.end ?? setupRange.start,
      metadata: jsonObject({
        sourceKind: source,
        sourceTrace: {
          sourceType: source,
          projectId: input.projectId,
          volumeId: input.volumeId ?? null,
          volumeNo: input.volumeNo,
          chapterCount: input.chapterCount,
          itemIndex: index,
        },
        setupRange: setupRange.raw,
        recoverRange: recoverRange.raw,
        recoveryMethod,
        rawPlan: itemText || record,
      }),
    });
  }

  return dedupeTracks(tracks);
}

function buildChapterOutlineForeshadowTracks(
  projectId: string,
  chapter: ChapterForeshadowSyncInput['chapters'][number],
  source: ChapterForeshadowSource,
): Prisma.ForeshadowTrackCreateManyInput[] {
  const craftBrief = asRecord(chapter.craftBrief);
  const clues = Array.isArray(craftBrief.concreteClues) ? craftBrief.concreteClues : [];
  const tracks: Prisma.ForeshadowTrackCreateManyInput[] = [];

  for (const [index, item] of clues.entries()) {
    const clue = asRecord(item);
    const title = compactText(scalarText(clue.name), 255);
    if (!title) continue;
    const sensoryDetail = scalarText(clue.sensoryDetail);
    const laterUse = scalarText(clue.laterUse);
    const scope = normalizeForeshadowScope(clue.scope, 'cross_chapter');
    const detail = compactText([sensoryDetail, laterUse ? `later use: ${laterUse}` : ''].filter(Boolean).join('; ') || title, 4000);

    tracks.push({
      projectId,
      chapterId: chapter.id,
      chapterNo: chapter.chapterNo,
      title,
      detail,
      status: 'planned',
      scope,
      source,
      firstSeenChapterNo: chapter.chapterNo,
      lastSeenChapterNo: chapter.chapterNo,
      metadata: jsonObject({
        sourceKind: source,
        sourceTrace: {
          sourceType: source,
          projectId,
          chapterId: chapter.id,
          chapterNo: chapter.chapterNo,
          volumeNo: chapter.volumeNo ?? null,
          itemIndex: index,
        },
        sensoryDetail,
        laterUse,
      }),
    });
  }

  return dedupeTracks(tracks);
}

export function normalizeForeshadowScope(value: unknown, fallback: ForeshadowScope): ForeshadowScope {
  const scope = scalarText(value).toLowerCase();
  if (FORESHADOW_SCOPES.has(scope as ForeshadowScope)) return scope as ForeshadowScope;
  return FORESHADOW_SCOPE_ALIASES[scope] ?? fallback;
}

function dedupeTracks(tracks: Prisma.ForeshadowTrackCreateManyInput[]): Prisma.ForeshadowTrackCreateManyInput[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = [track.source, track.chapterId ?? '', track.title, track.firstSeenChapterNo ?? '', track.lastSeenChapterNo ?? ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readChapterRange(value: unknown): { start?: number; end?: number; raw?: unknown } {
  const record = asRecord(value);
  if (Object.keys(record).length) {
    const start = positiveInt(record.start);
    const end = positiveInt(record.end) ?? start;
    return { start, end, raw: record };
  }

  const number = positiveInt(value);
  if (number) return { start: number, end: number, raw: value };

  const text = scalarText(value);
  return text ? { raw: text } : {};
}

function formatRange(label: string, range: { start?: number; end?: number }): string {
  if (!range.start) return '';
  return range.end && range.end !== range.start ? `${label}: chapter ${range.start}-${range.end}` : `${label}: chapter ${range.start}`;
}

function firstPresentKey(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return keys.find((key) => record[key] !== undefined && record[key] !== null);
}

function positiveInt(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function compactText(value: string, limit: number): string {
  const text = value.trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonObject(value: Record<string, unknown>): Prisma.InputJsonValue {
  return stripUndefined(value) as Prisma.InputJsonValue;
}

function stripUndefined(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(stripUndefined).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, stripUndefined(item)] as const)
    .filter(([, item]) => item !== undefined);
  return Object.fromEntries(entries);
}
