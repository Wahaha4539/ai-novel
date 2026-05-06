export const STORY_BIBLE_ENTRY_TYPES = [
  'world_rule',
  'power_system',
  'faction',
  'faction_relation',
  'location',
  'item',
  'history_event',
  'religion',
  'economy',
  'technology',
  'forbidden_rule',
  'setting',
] as const;

export const LEGACY_LOREBOOK_ENTRY_TYPES = [
  'rule',
  'character',
  'relationship',
  'place',
  'organization',
  'worldRule',
  'powerSystem',
  'factionRelation',
  'historyEvent',
  'forbiddenRule',
] as const;

export const ALLOWED_LOREBOOK_ENTRY_TYPES = [...STORY_BIBLE_ENTRY_TYPES, ...LEGACY_LOREBOOK_ENTRY_TYPES] as const;

export type StoryBibleEntryType = (typeof STORY_BIBLE_ENTRY_TYPES)[number];

const ENTRY_TYPE_NORMALIZATION_MAP: Record<string, StoryBibleEntryType> = {
  worldrule: 'world_rule',
  power: 'power_system',
  powersystem: 'power_system',
  faction: 'faction',
  organization: 'faction',
  organisation: 'faction',
  factionrelation: 'faction_relation',
  relationship: 'faction_relation',
  relation: 'faction_relation',
  location: 'location',
  place: 'location',
  item: 'item',
  prop: 'item',
  history: 'history_event',
  historyevent: 'history_event',
  religion: 'religion',
  economy: 'economy',
  technology: 'technology',
  tech: 'technology',
  forbiddenrule: 'forbidden_rule',
  rule: 'forbidden_rule',
  setting: 'setting',
  character: 'setting',
};

const ENTRY_TYPE_ALIASES: Record<StoryBibleEntryType, string[]> = {
  world_rule: ['world_rule', 'worldRule'],
  power_system: ['power_system', 'powerSystem'],
  faction: ['faction', 'organization'],
  faction_relation: ['faction_relation', 'factionRelation', 'relationship'],
  location: ['location', 'place'],
  item: ['item'],
  history_event: ['history_event', 'historyEvent', 'history'],
  religion: ['religion'],
  economy: ['economy'],
  technology: ['technology'],
  forbidden_rule: ['forbidden_rule', 'forbiddenRule', 'rule'],
  setting: ['setting', 'character'],
};

export function normalizeLorebookEntryType(value: string): string {
  const normalizedKey = value.trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return ENTRY_TYPE_NORMALIZATION_MAP[normalizedKey] ?? value.trim();
}

export function expandLorebookEntryTypeAliases(value: string): string[] {
  const canonical = normalizeLorebookEntryType(value);
  return ENTRY_TYPE_ALIASES[canonical as StoryBibleEntryType] ?? [canonical];
}
