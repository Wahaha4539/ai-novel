import React, { useMemo, useState } from 'react';
import { CharacterStateItem, ProjectSummary } from '../types/dashboard';
import { StatusBadge } from './StatusBadge';

type StateMode = 'current' | 'history' | 'death' | 'missing';

const MODE_TABS: Array<{ key: StateMode; label: string; color: string }> = [
  { key: 'current', label: '当前', color: '#38bdf8' },
  { key: 'history', label: '历史', color: '#a78bfa' },
  { key: 'death', label: '死亡', color: '#fb7185' },
  { key: 'missing', label: '失踪', color: '#f59e0b' },
];

const DEATH_KEYWORDS = ['dead', 'death', 'died', 'killed', '死亡', '身亡', '阵亡', '死去', '已死', '牺牲'];
const MISSING_KEYWORDS = ['missing', 'lost', 'disappear', 'unknown', '失踪', '下落不明', '消失', '行踪不明', '失联'];

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  characterStates: CharacterStateItem[];
  loading: boolean;
  onRefresh: () => void;
}

export function CharacterStatePanel({ selectedProject, selectedProjectId, characterStates, loading, onRefresh }: Props) {
  const [mode, setMode] = useState<StateMode>('current');
  const [selectedCharacter, setSelectedCharacter] = useState('all');

  const characterNames = useMemo(() => {
    return Array.from(new Set(characterStates.map((state) => state.characterName).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [characterStates]);

  const baseStates = useMemo(() => {
    const scoped = selectedCharacter === 'all'
      ? characterStates
      : characterStates.filter((state) => state.characterName === selectedCharacter);

    return scoped.slice().sort(sortStateDesc);
  }, [characterStates, selectedCharacter]);

  const deathStates = useMemo(() => baseStates.filter((state) => stateMatchesKeywords(state, DEATH_KEYWORDS)), [baseStates]);
  const missingStates = useMemo(() => baseStates.filter((state) => stateMatchesKeywords(state, MISSING_KEYWORDS)), [baseStates]);

  const visibleStates = useMemo(() => {
    if (mode === 'history') return baseStates;
    if (mode === 'death') return deathStates;
    if (mode === 'missing') return missingStates;

    const latestByCharacter = new Map<string, CharacterStateItem>();
    for (const state of baseStates) {
      if (!latestByCharacter.has(state.characterName)) {
        latestByCharacter.set(state.characterName, state);
      }
    }
    return Array.from(latestByCharacter.values()).sort(sortStateDesc);
  }, [baseStates, deathStates, missingStates, mode]);

  const activeTab = MODE_TABS.find((tab) => tab.key === mode) ?? MODE_TABS[0];

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: activeTab.color, boxShadow: `0 0 10px ${activeTab.color}80` }} />
          <h1 className="text-lg font-bold text-heading">角色状态</h1>
          <span className="badge" style={{ background: `${activeTab.color}18`, color: activeTab.color, border: 'none' }}>State</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          <button className="btn-secondary" onClick={onRefresh} disabled={loading || !selectedProjectId} style={{ fontSize: '0.75rem' }}>刷新</button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0" style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}>
        <div className="flex flex-wrap items-center gap-2">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMode(tab.key)}
              style={{
                fontSize: '0.72rem',
                padding: '0.28rem 0.65rem',
                borderRadius: '0.45rem',
                border: mode === tab.key ? `1px solid ${tab.color}` : '1px solid var(--border-dim)',
                background: mode === tab.key ? `${tab.color}18` : 'transparent',
                color: mode === tab.key ? tab.color : 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <select className="input-field" value={selectedCharacter} onChange={(event) => setSelectedCharacter(event.target.value)} style={{ width: '13rem', fontSize: '0.75rem', padding: '0.45rem 0.75rem' }}>
          <option value="all">全部角色</option>
          {characterNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))' }}>
          <StatCard label="角色数" value={characterNames.length} color="#38bdf8" />
          <StatCard label="快照数" value={baseStates.length} color="#a78bfa" />
          <StatCard label="死亡记录" value={deathStates.length} color="#fb7185" />
          <StatCard label="失踪记录" value={missingStates.length} color="#f59e0b" />
        </div>

        <section className="panel" style={{ overflow: 'hidden' }}>
          <div className="flex items-center justify-between p-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
            <div>
              <h2 className="text-base font-bold text-heading">{activeTab.label}状态</h2>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{visibleStates.length} 条状态快照</p>
            </div>
            {loading ? (
              <span className="text-xs" style={{ color: 'var(--accent-cyan)' }}>同步中…</span>
            ) : null}
          </div>

          {!selectedProjectId ? (
            <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>请先选择一个项目</div>
          ) : loading ? (
            <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
          ) : visibleStates.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: 'var(--text-dim)' }}>
              {mode === 'death' || mode === 'missing'
                ? '没有可保守识别的对应状态记录。'
                : '暂无角色状态快照。'}
            </div>
          ) : (
            <div className="grid gap-3 p-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(18rem, 1fr))' }}>
              {visibleStates.map((state) => (
                <StateCard key={state.id} state={state} />
              ))}
            </div>
          )}
        </section>
      </div>
    </article>
  );
}

function StateCard({ state }: { state: CharacterStateItem }) {
  const metadataText = state.metadata && Object.keys(state.metadata).length
    ? JSON.stringify(state.metadata)
    : '';

  return (
    <div className="list-card text-sm" style={{ minWidth: 0 }}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="text-heading font-bold">{state.characterName}</span>
        <StatusBadge value={state.status} />
        <span className="badge" style={{ background: 'var(--bg-overlay)', borderColor: 'var(--border-dim)', color: 'var(--text-dim)' }}>{state.stateType}</span>
        {state.chapterNo != null ? <span className="badge" style={{ fontSize: '0.62rem' }}>Ch.{state.chapterNo}</span> : null}
      </div>
      <div style={{ color: 'var(--text-main)', lineHeight: 1.6 }}>{state.stateValue}</div>
      {state.summary ? (
        <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-dim)', paddingTop: '0.5rem', lineHeight: 1.6 }}>{state.summary}</div>
      ) : null}
      {metadataText ? (
        <div className="mt-3 text-xs font-mono" style={{ color: 'var(--text-dim)', wordBreak: 'break-word' }}>{metadataText}</div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{label}</div>
      <div className="stat-card__value" style={{ color }}>{value}</div>
    </div>
  );
}

function sortStateDesc(a: CharacterStateItem, b: CharacterStateItem) {
  const chapterDelta = (b.chapterNo ?? -1) - (a.chapterNo ?? -1);
  if (chapterDelta !== 0) return chapterDelta;
  return a.characterName.localeCompare(b.characterName);
}

function stateMatchesKeywords(state: CharacterStateItem, keywords: string[]) {
  const haystack = [
    state.characterName,
    state.stateType,
    state.stateValue,
    state.summary,
    state.status,
    safeMetadataText(state.metadata),
  ].filter(Boolean).join(' ').toLowerCase();

  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function safeMetadataText(metadata?: Record<string, unknown> | null) {
  if (!metadata) return '';
  try {
    return JSON.stringify(metadata);
  } catch {
    return '';
  }
}
