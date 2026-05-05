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

export const LEGACY_LOREBOOK_ENTRY_TYPES = ['rule', 'character', 'relationship', 'place', 'organization'] as const;

export const ALLOWED_LOREBOOK_ENTRY_TYPES = [...STORY_BIBLE_ENTRY_TYPES, ...LEGACY_LOREBOOK_ENTRY_TYPES] as const;

export type StoryBibleEntryType = (typeof STORY_BIBLE_ENTRY_TYPES)[number];

const LEGACY_ENTRY_TYPE_MAP: Record<string, StoryBibleEntryType> = {
  rule: 'forbidden_rule',
  relationship: 'faction_relation',
  place: 'location',
  organization: 'faction',
  character: 'setting',
};

const ENTRY_TYPE_ALIASES: Record<StoryBibleEntryType, string[]> = {
  world_rule: ['world_rule'],
  power_system: ['power_system'],
  faction: ['faction', 'organization'],
  faction_relation: ['faction_relation', 'relationship'],
  location: ['location', 'place'],
  item: ['item'],
  history_event: ['history_event', 'history'],
  religion: ['religion'],
  economy: ['economy'],
  technology: ['technology'],
  forbidden_rule: ['forbidden_rule', 'rule'],
  setting: ['setting', 'character'],
};

export function normalizeLorebookEntryType(value: string): string {
  return LEGACY_ENTRY_TYPE_MAP[value] ?? value;
}

export function expandLorebookEntryTypeAliases(value: string): string[] {
  const canonical = normalizeLorebookEntryType(value);
  return ENTRY_TYPE_ALIASES[canonical as StoryBibleEntryType] ?? [canonical];
}
