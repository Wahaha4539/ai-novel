import React from 'react';

/** Data shape for a single foreshadow track */
export interface ForeshadowTrackData {
  title: string;
  detail: string;
  scope: string;
  technique: string;
  plantChapter: string;
  revealChapter: string;
  involvedCharacters: string;
  payoff: string;
}

/** Scope display labels and colors */
const SCOPE_LABELS: Record<string, { label: string; color: string }> = {
  arc: { label: '主线伏笔', color: '#ec4899' },
  volume: { label: '卷级伏笔', color: '#f59e0b' },
  chapter: { label: '章节伏笔', color: '#14b8a6' },
};

/** Technique display labels */
const TECHNIQUE_OPTIONS = [
  { value: '道具型', label: '🔑 道具型' },
  { value: '对话型', label: '💬 对话型' },
  { value: '行为型', label: '🎭 行为型' },
  { value: '环境型', label: '🌿 环境型' },
  { value: '叙事型', label: '📖 叙事型' },
  { value: '象征型', label: '🔮 象征型' },
  { value: '结构型', label: '🧩 结构型' },
];

/** Create an empty foreshadow track with default scope */
const emptyTrack = (scope = 'volume'): ForeshadowTrackData => ({
  title: '',
  detail: '',
  scope,
  technique: '',
  plantChapter: '',
  revealChapter: '',
  involvedCharacters: '',
  payoff: '',
});

interface Props {
  data: Record<string, unknown>;
  onChange: (field: string, value: string) => void;
}

/**
 * Multi-card editor for foreshadow tracks.
 * Stores data as a JSON array string under the 'foreshadowTracks' field.
 */
export function ForeshadowFields({ data, onChange }: Props) {
  // Parse foreshadow tracks from stepData
  const parseTracks = (): ForeshadowTrackData[] => {
    const raw = data.foreshadowTracks;
    if (!raw) return [emptyTrack('arc'), emptyTrack('volume'), emptyTrack('chapter')];
    try {
      if (typeof raw === 'string') return JSON.parse(raw) as ForeshadowTrackData[];
      if (Array.isArray(raw)) return raw as ForeshadowTrackData[];
    } catch { /* ignore parse errors */ }
    return [emptyTrack('arc'), emptyTrack('volume'), emptyTrack('chapter')];
  };

  const tracks = parseTracks();

  /** Update a single field of a track and serialize back */
  const updateTrack = (index: number, key: keyof ForeshadowTrackData, value: string) => {
    const updated = [...tracks];
    updated[index] = { ...updated[index], [key]: value };
    onChange('foreshadowTracks', JSON.stringify(updated));
  };

  /** Add a new empty track */
  const addTrack = () => {
    const updated = [...tracks, emptyTrack('volume')];
    onChange('foreshadowTracks', JSON.stringify(updated));
  };

  /** Remove a track by index */
  const removeTrack = (index: number) => {
    if (tracks.length <= 1) return;
    const updated = tracks.filter((_, i) => i !== index);
    onChange('foreshadowTracks', JSON.stringify(updated));
  };

  return (
    <div className="doc-section__fields">
      {/* Summary bar: counts by scope */}
      <div
        className="flex items-center gap-3"
        style={{
          marginBottom: '0.25rem',
          fontSize: '0.72rem',
          color: 'var(--text-dim)',
        }}
      >
        <span>共 {tracks.length} 条伏笔</span>
        {Object.entries(SCOPE_LABELS).map(([key, { label, color }]) => {
          const count = tracks.filter((t) => t.scope === key).length;
          if (count === 0) return null;
          return (
            <span key={key} style={{ color }}>
              {label} × {count}
            </span>
          );
        })}
      </div>

      {/* Track cards */}
      {tracks.map((track, idx) => {
        const scopeInfo = SCOPE_LABELS[track.scope] ?? SCOPE_LABELS.volume;
        const accentColor = scopeInfo.color;

        return (
          <div
            key={idx}
            style={{
              borderRadius: '0.75rem',
              border: `1px solid ${accentColor}33`,
              background: `${accentColor}08`,
              padding: '0.75rem',
            }}
          >
            {/* Card header: scope badge + remove button */}
            <div
              className="flex items-center justify-between"
              style={{ marginBottom: '0.5rem' }}
            >
              <div className="flex items-center gap-2">
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: accentColor,
                    boxShadow: `0 0 6px ${accentColor}66`,
                    display: 'inline-block',
                  }}
                />
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: accentColor,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {scopeInfo.label} #{idx + 1}
                </span>
              </div>
              {tracks.length > 1 && (
                <button
                  onClick={() => removeTrack(idx)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-dim)',
                    fontSize: '0.7rem',
                    cursor: 'pointer',
                    padding: '0.15rem 0.4rem',
                    borderRadius: '0.25rem',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = '#ef4444';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--text-dim)';
                  }}
                >
                  ✕ 移除
                </button>
              )}
            </div>

            {/* Row 1: scope + technique selectors */}
            <div className="flex gap-2" style={{ marginBottom: '0.4rem' }}>
              <select
                className="input-field"
                value={track.scope}
                onChange={(e) => updateTrack(idx, 'scope', e.target.value)}
                style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem', flex: 1 }}
              >
                <option value="arc">主线伏笔 (全书)</option>
                <option value="volume">卷级伏笔 (跨卷)</option>
                <option value="chapter">章节伏笔 (短距离)</option>
              </select>
              <select
                className="input-field"
                value={track.technique}
                onChange={(e) => updateTrack(idx, 'technique', e.target.value)}
                style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem', flex: 1 }}
              >
                <option value="">选择伏笔手法…</option>
                {TECHNIQUE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Row 2: title */}
            <div className="space-y-2">
              <input
                className="input-field"
                value={track.title}
                onChange={(e) => updateTrack(idx, 'title', e.target.value)}
                placeholder="伏笔标题…"
                style={{ fontSize: '0.8rem' }}
              />

              {/* Row 3: detail */}
              <textarea
                className="input-field"
                rows={2}
                value={track.detail}
                onChange={(e) => updateTrack(idx, 'detail', e.target.value)}
                placeholder="伏笔内容详细描述（50字以上，含埋设场景和揭开场景的具体画面）…"
                style={{
                  fontSize: '0.8rem',
                  lineHeight: 1.6,
                  resize: 'vertical',
                }}
              />

              {/* Row 4: timing — plant and reveal */}
              <div className="flex gap-2">
                <input
                  className="input-field"
                  value={track.plantChapter}
                  onChange={(e) =>
                    updateTrack(idx, 'plantChapter', e.target.value)
                  }
                  placeholder="埋设时机（如：第1卷第3章）"
                  style={{ fontSize: '0.8rem', flex: 1 }}
                />
                <input
                  className="input-field"
                  value={track.revealChapter}
                  onChange={(e) =>
                    updateTrack(idx, 'revealChapter', e.target.value)
                  }
                  placeholder="揭开时机（如：第3卷第8章）"
                  style={{ fontSize: '0.8rem', flex: 1 }}
                />
              </div>

              {/* Row 5: involved characters */}
              <input
                className="input-field"
                value={track.involvedCharacters}
                onChange={(e) =>
                  updateTrack(idx, 'involvedCharacters', e.target.value)
                }
                placeholder="涉及角色（如：张三、李四）"
                style={{ fontSize: '0.8rem' }}
              />

              {/* Row 6: payoff */}
              <textarea
                className="input-field"
                rows={2}
                value={track.payoff}
                onChange={(e) => updateTrack(idx, 'payoff', e.target.value)}
                placeholder="揭开后的影响和情感冲击…"
                style={{
                  fontSize: '0.8rem',
                  lineHeight: 1.6,
                  resize: 'vertical',
                }}
              />
            </div>
          </div>
        );
      })}

      {/* Add track button */}
      <button
        onClick={addTrack}
        style={{
          width: '100%',
          padding: '0.6rem',
          borderRadius: '0.5rem',
          border: '1px dashed var(--border-light)',
          background: 'transparent',
          color: '#ec4899',
          fontSize: '0.8rem',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(236,72,153,0.08)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      >
        + 添加伏笔
      </button>
    </div>
  );
}
