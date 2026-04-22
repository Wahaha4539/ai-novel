import React from 'react';
import { CharacterCard } from '../types/dashboard';

interface Props {
  characters: CharacterCard[];
  loading: boolean;
  onAdd: () => void;
  onEdit: (character: CharacterCard) => void;
  onDelete: (character: CharacterCard) => void;
}

const ROLE_TYPE_COLORS: Record<string, string> = {
  '主角': '#06b6d4',
  '配角': '#8b5cf6',
  '反派': '#ef4444',
  '导师': '#f59e0b',
  '龙套': '#6b7280',
};

const getRoleColor = (roleType?: string | null): string => {
  if (!roleType) return '#6b7280';
  return ROLE_TYPE_COLORS[roleType] ?? '#8b5cf6';
};

export function CharacterCardList({ characters, loading, onAdd, onEdit, onDelete }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ padding: '4rem 0' }}>
        <div className="animate-pulse-glow text-sm" style={{ color: 'var(--text-dim)' }}>
          加载角色数据中…
        </div>
      </div>
    );
  }

  if (characters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center animate-fade-in" style={{ padding: '4rem 0', opacity: 0.7 }}>
        <div
          className="flex items-center justify-center animate-pulse-glow"
          style={{
            width: '4rem',
            height: '4rem',
            borderRadius: '1rem',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-light)',
            color: '#8b5cf6',
            marginBottom: '1rem',
            cursor: 'pointer',
          }}
          onClick={onAdd}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v12m6-6H6" />
          </svg>
        </div>
        <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
          还没有角色卡
        </p>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
          创建你的第一个角色，为故事注入灵魂
        </p>
        <button className="btn" onClick={onAdd} style={{ fontSize: '0.8rem' }}>
          创建角色
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          共 {characters.length} 个角色
        </span>
        <button className="btn" onClick={onAdd} style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}>
          + 新建角色
        </button>
      </div>

      <div
        className="animate-fade-in"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {characters.map((char) => {
          const roleColor = getRoleColor(char.roleType);
          return (
            <div
              key={char.id}
              className="panel"
              style={{
                padding: '1rem 1.25rem',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-light)',
                borderRadius: '0.75rem',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                position: 'relative',
                overflow: 'hidden',
              }}
              onClick={() => onEdit(char)}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = roleColor;
                e.currentTarget.style.boxShadow = `0 0 20px ${roleColor}22`;
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-light)';
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {/* Top accent line */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: '2px',
                background: `linear-gradient(90deg, ${roleColor}, transparent)`,
              }} />

              {/* Header row */}
              <div className="flex items-center justify-between" style={{ marginBottom: '0.75rem' }}>
                <div className="flex items-center gap-2">
                  <div style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    background: `${roleColor}20`,
                    border: `1px solid ${roleColor}40`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: roleColor,
                  }}>
                    {char.name.charAt(0)}
                  </div>
                  <div>
                    <div className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
                      {char.name}
                    </div>
                    {char.roleType && (
                      <span style={{
                        fontSize: '0.6rem',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: `${roleColor}15`,
                        color: roleColor,
                        fontWeight: 600,
                      }}>
                        {char.roleType}
                      </span>
                    )}
                  </div>
                </div>

                {/* Delete button */}
                <button
                  className="flex items-center justify-center"
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '6px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-dim)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    fontSize: '0.85rem',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(char);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--status-err-bg)';
                    e.currentTarget.style.color = 'var(--status-err)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-dim)';
                  }}
                  title="删除角色"
                >
                  ✕
                </button>
              </div>

              {/* Info fields */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {char.personalityCore && (
                  <InfoRow label="性格" value={char.personalityCore} />
                )}
                {char.motivation && (
                  <InfoRow label="动机" value={char.motivation} />
                )}
                {char.speechStyle && (
                  <InfoRow label="语风" value={char.speechStyle} />
                )}
              </div>

              {/* Dead badge */}
              {char.isDead && (
                <div style={{
                  marginTop: '0.5rem',
                  fontSize: '0.65rem',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background: 'rgba(239,68,68,0.1)',
                  color: '#ef4444',
                  display: 'inline-block',
                  fontWeight: 600,
                }}>
                  已死亡
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2" style={{ fontSize: '0.75rem', lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-dim)', flexShrink: 0, width: '2.5rem' }}>{label}</span>
      <span style={{
        color: 'var(--text-muted)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}
