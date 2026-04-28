import { Injectable } from '@nestjs/common';

export interface RelationshipGraphCharacterLike {
  name?: string | null;
}

export interface RelationshipGraphStoryEventLike {
  chapterNo?: number | null;
  title?: string | null;
  description?: string | null;
  participants?: unknown;
}

export interface RelationshipGraphCharacterStateLike {
  characterName?: string | null;
  chapterNo?: number | null;
  summary?: string | null;
}

export interface RelationshipGraphEdge {
  source: string;
  target: string | null;
  chapterNo: number | null;
  timeRange: { fromChapterNo: number; toChapterNo: number } | null;
  relationType: 'ally' | 'conflict' | 'kinship_or_affiliation' | 'co_occurrence' | 'state_evidence';
  weight: number;
  evidence: string;
  evidenceSources: Array<{ sourceType: 'story_event' | 'character_state'; title?: string | null; chapterNo: number | null }>;
  conflict: boolean;
  sourceType: 'story_event' | 'character_state';
}

/**
 * 只读关系图服务：把剧情事件参与者和角色状态快照转换为可解释关系边。
 * 输入来自当前项目已召回的上下文；服务不读取数据库、不写入关系表，便于 collect_task_context、Eval 和未来 Artifact 复用同一套确定性权重逻辑。
 */
@Injectable()
export class RelationshipGraphService {
  /** 构建轻量关系图，并保留关系类型、权重、证据来源、时间范围和冲突标记等审计字段。 */
  buildGraph(
    characters: RelationshipGraphCharacterLike[],
    storyEvents: RelationshipGraphStoryEventLike[],
    characterStates: RelationshipGraphCharacterStateLike[],
  ): RelationshipGraphEdge[] {
    const knownNames = new Set(characters.map((character) => this.text(character.name)).filter(Boolean));
    const eventEdges = storyEvents.flatMap((event) => {
      const description = this.text(event.description);
      const participants = this.extractParticipantNames(event.participants).filter((name) => !knownNames.size || knownNames.has(name));
      return this.pairNames(participants).map(([source, target]) => ({
        source,
        target,
        chapterNo: event.chapterNo ?? null,
        timeRange: this.formatTimeRange(event.chapterNo),
        relationType: this.inferRelationType(description),
        weight: this.inferRelationWeight(description),
        evidence: this.compactText(`${this.text(event.title) || '未命名事件'}：${description}`, 220),
        evidenceSources: [{ sourceType: 'story_event' as const, title: event.title ?? null, chapterNo: event.chapterNo ?? null }],
        conflict: /冲突|敌对|背叛|对峙|争执|攻击/.test(description),
        sourceType: 'story_event' as const,
      }));
    });
    const stateNodes = characterStates.reduce<RelationshipGraphEdge[]>((edges, state) => {
      const characterName = this.text(state.characterName);
      if (!characterName) return edges;
      edges.push({
        source: characterName,
        target: null,
        chapterNo: state.chapterNo ?? null,
        timeRange: this.formatTimeRange(state.chapterNo),
        relationType: 'state_evidence' as const,
        weight: 0.4,
        evidence: this.compactText(this.text(state.summary) || '角色状态更新', 180),
        evidenceSources: [{ sourceType: 'character_state' as const, chapterNo: state.chapterNo ?? null }],
        conflict: false,
        sourceType: 'character_state' as const,
      });
      return edges;
    }, []);
    return [...eventEdges, ...stateNodes].slice(0, 30);
  }

  /** 从 StoryEvent.participants 的字符串或对象数组中提取角色名，忽略无法确认的结构。 */
  extractParticipantNames(value: unknown): string[] {
    const rawItems = Array.isArray(value) ? value : [];
    return rawItems
      .map((item) => (typeof item === 'string' ? item : this.text(this.asRecord(item).name) || this.text(this.asRecord(item).characterName)))
      .filter(Boolean);
  }

  private inferRelationType(text: string): RelationshipGraphEdge['relationType'] {
    if (/合作|同盟|协助|守护|帮助/.test(text)) return 'ally';
    if (/冲突|敌对|背叛|对峙|争执|攻击/.test(text)) return 'conflict';
    if (/师姐|师兄|师父|弟子|同门|家族/.test(text)) return 'kinship_or_affiliation';
    return 'co_occurrence';
  }

  private inferRelationWeight(text: string) {
    if (/生死|背叛|决裂|击杀|救命/.test(text)) return 0.9;
    if (/冲突|敌对|对峙|守护|盟约/.test(text)) return 0.75;
    if (/相遇|同行|谈话|出现/.test(text)) return 0.5;
    return 0.6;
  }

  private formatTimeRange(chapterNo?: number | null) {
    return typeof chapterNo === 'number' ? { fromChapterNo: chapterNo, toChapterNo: chapterNo } : null;
  }

  private pairNames(names: string[]): Array<[string, string]> {
    const unique = [...new Set(names)].slice(0, 8);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) pairs.push([unique[i], unique[j]]);
    }
    return pairs;
  }

  private compactText(value: unknown, maxLength: number): string {
    const text = this.text(value).replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}