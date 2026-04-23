import React, { useState, forwardRef } from 'react';
import { StepKey, GUIDED_STEPS } from '../../hooks/useGuidedSession';
import { ChapterFields } from './ChapterFields';

/** Simple field definitions for non-array steps */
type FieldDef = { field: string; label: string; type: 'text' | 'textarea' };

const SIMPLE_STEP_FIELDS: Partial<Record<StepKey, FieldDef[]>> = {
  guided_setup: [
    { field: 'genre', label: '类型', type: 'text' },
    { field: 'theme', label: '主题', type: 'text' },
    { field: 'tone', label: '基调', type: 'text' },
    { field: 'logline', label: '一句话概述', type: 'textarea' },
  ],
  guided_style: [
    { field: 'pov', label: '视角', type: 'text' },
    { field: 'tense', label: '时态', type: 'text' },
    { field: 'proseStyle', label: '文风', type: 'text' },
    { field: 'pacing', label: '节奏', type: 'text' },
  ],
  guided_outline: [
    { field: 'outline', label: '故事总纲', type: 'textarea' },
  ],

  guided_foreshadow: [
    { field: 'foreshadowPlan', label: '伏笔规划', type: 'textarea' },
    { field: 'supportingCharacters', label: '新增配角', type: 'textarea' },
  ],
};

/** Role type display labels */
const ROLE_LABELS: Record<string, string> = {
  protagonist: '主角',
  antagonist: '对手/反派',
  supporting: '配角',
  competitor: '竞争者',
};

/** Parsed character from stepData */
interface CharacterData {
  name: string;
  roleType: string;
  personalityCore: string;
  motivation: string;
  backstory: string;
}

interface VolumeData {
  volumeNo: number;
  title: string;
  synopsis: string;
  objective: string;
}

const emptyCharacter = (roleType = 'protagonist'): CharacterData => ({
  name: '',
  roleType,
  personalityCore: '',
  motivation: '',
  backstory: '',
});

const emptyVolume = (volumeNo: number): VolumeData => ({
  volumeNo,
  title: '',
  synopsis: '',
  objective: '',
});

interface Props {
  stepKey: StepKey;
  isActive: boolean;
  isCompleted: boolean;
  data: Record<string, unknown>;
  volumeData?: Record<string, unknown>;
  onEditField: (stepKey: StepKey, field: string, value: string) => void;
  onGenerate: (stepKey: StepKey) => void;
  onGenerateForVolume?: (volumeNo: number, chapterRange?: [number, number]) => void;
  onSave: (stepKey: StepKey) => void;
  onSaveVolume?: (volumeNo: number) => void;
  loading: boolean;
}

export const StepSection = forwardRef<HTMLDivElement, Props>(
  ({ stepKey, isActive, isCompleted, data, volumeData, onEditField, onGenerate, onGenerateForVolume, onSave, onSaveVolume, loading }, ref) => {
    const [collapsed, setCollapsed] = useState(false);
    const stepInfo = GUIDED_STEPS.find((s) => s.key === stepKey);
    if (!stepInfo) return null;

    const hasData = Object.values(data).some((v) => v !== '' && v !== null && v !== undefined);

    const sectionClass = [
      'doc-section',
      'animate-fade-in',
      isActive ? 'doc-section--active' : '',
    ].filter(Boolean).join(' ');

    return (
      <div ref={ref} id={`section-${stepKey}`} className={sectionClass}>
        {/* Section Header */}
        <div className="doc-section__header" onClick={() => setCollapsed(!collapsed)}>
          <div className="doc-section__title">
            <span
              className="doc-section__collapse-icon"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
            >
              ▼
            </span>
            <span className="doc-section__title-icon">{stepInfo.icon}</span>
            <span className="doc-section__title-text" style={{ color: stepInfo.color }}>
              {stepInfo.label}
            </span>
            {isCompleted && (
              <span
                style={{
                  fontSize: '0.65rem',
                  color: '#34d399',
                  background: 'rgba(16,185,129,0.1)',
                  padding: '0.1rem 0.4rem',
                  borderRadius: '0.25rem',
                  fontWeight: 600,
                }}
              >
                ✓ 已保存
              </span>
            )}
          </div>
          <div className="doc-section__actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="doc-section__btn doc-section__btn--ai"
              onClick={() => onGenerate(stepKey)}
              disabled={loading}
            >
              ⚡ AI 生成
            </button>
            {hasData && (
              <button
                className="doc-section__btn doc-section__btn--save"
                onClick={() => onSave(stepKey)}
                disabled={loading}
              >
                ✅ 保存
              </button>
            )}
          </div>
        </div>

        {/* Section Body */}
        {!collapsed && (
          <div className="doc-section__body">
            {stepKey === 'guided_characters' ? (
              <CharactersFields
                data={data}
                onChange={(field, value) => onEditField(stepKey, field, value)}
              />
            ) : stepKey === 'guided_volume' ? (
              <VolumesFields
                data={data}
                onChange={(field, value) => onEditField(stepKey, field, value)}
              />
            ) : stepKey === 'guided_chapter' ? (
              <ChapterFields
                data={data}
                volumeData={volumeData ?? {}}
                onChange={(field, value) => onEditField(stepKey, field, value)}
                onGenerateForVolume={onGenerateForVolume ?? (() => {})}
                onSaveVolume={onSaveVolume ?? (() => {})}
                loading={loading}
              />
            ) : (
              <SimpleFields
                stepKey={stepKey}
                data={data}
                onChange={(field, value) => onEditField(stepKey, field, value)}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);

StepSection.displayName = 'StepSection';

/** Simple text/textarea fields */
function SimpleFields({
  stepKey,
  data,
  onChange,
}: {
  stepKey: StepKey;
  data: Record<string, unknown>;
  onChange: (field: string, value: string) => void;
}) {
  const fields = SIMPLE_STEP_FIELDS[stepKey] ?? [];

  if (fields.length === 0) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textAlign: 'center', padding: '1.5rem 0' }}>
        点击「⚡ AI 生成」来填充此步骤
      </div>
    );
  }

  return (
    <div className="doc-section__fields">
      {fields.map(({ field, label, type }) => (
        <FieldInput
          key={field}
          field={field}
          label={label}
          type={type}
          value={(data[field] as string) ?? ''}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

/** Reusable field input */
function FieldInput({
  field,
  label,
  type,
  value,
  onChange,
}: {
  field: string;
  label: string;
  type: 'text' | 'textarea';
  value: string;
  onChange: (field: string, value: string) => void;
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: '0.72rem',
          fontWeight: 600,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.35rem',
        }}
      >
        {label}
      </label>
      {type === 'textarea' ? (
        <textarea
          className="input-field"
          rows={5}
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={`输入${label}…`}
          style={{ fontSize: '0.85rem', lineHeight: 1.8, resize: 'vertical' }}
        />
      ) : (
        <input
          className="input-field"
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={`输入${label}…`}
          style={{ fontSize: '0.85rem' }}
        />
      )}
    </div>
  );
}

/** Characters multi-card fields */
function CharactersFields({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (field: string, value: string) => void;
}) {
  const parseCharacters = (): CharacterData[] => {
    const raw = data.characters;
    if (!raw) return [emptyCharacter('protagonist'), emptyCharacter('supporting'), emptyCharacter('antagonist')];
    try {
      if (typeof raw === 'string') return JSON.parse(raw) as CharacterData[];
      if (Array.isArray(raw)) return raw as CharacterData[];
    } catch { /* ignore */ }
    return [emptyCharacter('protagonist'), emptyCharacter('supporting'), emptyCharacter('antagonist')];
  };

  const characters = parseCharacters();

  const updateCharacter = (index: number, key: keyof CharacterData, value: string) => {
    const updated = [...characters];
    updated[index] = { ...updated[index], [key]: value };
    onChange('characters', JSON.stringify(updated));
  };

  const addCharacter = () => {
    const updated = [...characters, emptyCharacter('supporting')];
    onChange('characters', JSON.stringify(updated));
  };

  const removeCharacter = (index: number) => {
    if (characters.length <= 1) return;
    const updated = characters.filter((_, i) => i !== index);
    onChange('characters', JSON.stringify(updated));
  };

  const roleColors: Record<string, string> = {
    protagonist: '#0ea5e9',
    antagonist: '#ef4444',
    supporting: '#f59e0b',
    competitor: '#8b5cf6',
  };

  return (
    <div className="doc-section__fields">
      {characters.map((char, idx) => {
        const roleLabel = ROLE_LABELS[char.roleType] ?? char.roleType;
        const accentColor = roleColors[char.roleType] ?? '#6b7280';
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
            <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
              <div className="flex items-center gap-2">
                <span
                  style={{
                    width: '6px', height: '6px', borderRadius: '50%',
                    background: accentColor, boxShadow: `0 0 6px ${accentColor}66`,
                    display: 'inline-block',
                  }}
                />
                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: accentColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {roleLabel} #{idx + 1}
                </span>
              </div>
              {characters.length > 1 && (
                <button
                  onClick={() => removeCharacter(idx)}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-dim)',
                    fontSize: '0.7rem', cursor: 'pointer', padding: '0.15rem 0.4rem',
                    borderRadius: '0.25rem',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
                >
                  ✕ 移除
                </button>
              )}
            </div>

            <div style={{ marginBottom: '0.4rem' }}>
              <select
                className="input-field"
                value={char.roleType}
                onChange={(e) => updateCharacter(idx, 'roleType', e.target.value)}
                style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}
              >
                <option value="protagonist">主角</option>
                <option value="supporting">配角/同行者</option>
                <option value="antagonist">对手/反派</option>
                <option value="competitor">竞争者</option>
              </select>
            </div>

            <div className="space-y-2">
              <input className="input-field" value={char.name} onChange={(e) => updateCharacter(idx, 'name', e.target.value)} placeholder="角色名…" style={{ fontSize: '0.8rem' }} />
              <input className="input-field" value={char.personalityCore} onChange={(e) => updateCharacter(idx, 'personalityCore', e.target.value)} placeholder="性格核心…" style={{ fontSize: '0.8rem' }} />
              <input className="input-field" value={char.motivation} onChange={(e) => updateCharacter(idx, 'motivation', e.target.value)} placeholder="核心动机…" style={{ fontSize: '0.8rem' }} />
              <textarea className="input-field" rows={2} value={char.backstory} onChange={(e) => updateCharacter(idx, 'backstory', e.target.value)} placeholder="背景故事…" style={{ fontSize: '0.8rem', lineHeight: 1.6, resize: 'vertical' }} />
            </div>
          </div>
        );
      })}

      <button
        onClick={addCharacter}
        style={{
          width: '100%', padding: '0.6rem', borderRadius: '0.5rem',
          border: '1px dashed var(--border-light)', background: 'transparent',
          color: 'var(--accent-cyan)', fontSize: '0.8rem', fontWeight: 600,
          cursor: 'pointer', transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(14,165,233,0.08)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        + 添加角色
      </button>
    </div>
  );
}

/** Volumes multi-card fields */
function VolumesFields({
  data,
  onChange,
}: {
  data: Record<string, unknown>;
  onChange: (field: string, value: string) => void;
}) {
  const parseVolumes = (): VolumeData[] => {
    const raw = data.volumes;
    if (!raw) return [emptyVolume(1), emptyVolume(2), emptyVolume(3)];
    try {
      if (typeof raw === 'string') return JSON.parse(raw) as VolumeData[];
      if (Array.isArray(raw)) return raw as VolumeData[];
    } catch { /* ignore */ }
    return [emptyVolume(1), emptyVolume(2), emptyVolume(3)];
  };

  const volumes = parseVolumes();

  const updateVolume = (index: number, key: keyof VolumeData, value: string | number) => {
    const updated = [...volumes];
    updated[index] = { ...updated[index], [key]: value };
    onChange('volumes', JSON.stringify(updated));
  };

  const addVolume = () => {
    const updated = [...volumes, emptyVolume(volumes.length + 1)];
    onChange('volumes', JSON.stringify(updated));
  };

  const removeVolume = (index: number) => {
    if (volumes.length <= 1) return;
    const updated = volumes.filter((_, i) => i !== index)
      .map((v, i) => ({ ...v, volumeNo: i + 1 }));
    onChange('volumes', JSON.stringify(updated));
  };

  const setVolumeCount = (count: number) => {
    const clamped = Math.max(1, Math.min(30, count));
    const updated: VolumeData[] = [];
    for (let i = 0; i < clamped; i++) {
      updated.push(volumes[i] ?? emptyVolume(i + 1));
      updated[i].volumeNo = i + 1;
    }
    onChange('volumes', JSON.stringify(updated));
  };

  const accentColor = '#14b8a6';

  return (
    <div className="doc-section__fields">
      {/* Volume count control */}
      <div className="flex items-center gap-3" style={{ marginBottom: '0.25rem' }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-dim)' }}>卷数：</span>
        <input
          type="number"
          className="input-field"
          min={1}
          max={30}
          value={volumes.length}
          onChange={(e) => setVolumeCount(parseInt(e.target.value, 10) || 1)}
          style={{ width: '4rem', fontSize: '0.8rem', padding: '0.25rem 0.5rem', textAlign: 'center' }}
        />
        <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>共 {volumes.length} 卷</span>
      </div>

      {volumes.map((vol, idx) => (
        <div
          key={idx}
          style={{
            borderRadius: '0.75rem',
            border: `1px solid ${accentColor}33`,
            background: `${accentColor}08`,
            padding: '0.75rem',
          }}
        >
          <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
            <div className="flex items-center gap-2">
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: accentColor, boxShadow: `0 0 6px ${accentColor}66`, display: 'inline-block' }} />
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: accentColor }}>
                第 {vol.volumeNo} 卷
              </span>
            </div>
            {volumes.length > 1 && (
              <button
                onClick={() => removeVolume(idx)}
                style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '0.7rem', cursor: 'pointer', padding: '0.15rem 0.4rem', borderRadius: '0.25rem' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
              >
                ✕ 移除
              </button>
            )}
          </div>
          <div className="space-y-2">
            <input className="input-field" value={vol.title} onChange={(e) => updateVolume(idx, 'title', e.target.value)} placeholder="卷标题…" style={{ fontSize: '0.8rem' }} />
            <input className="input-field" value={vol.objective} onChange={(e) => updateVolume(idx, 'objective', e.target.value)} placeholder="本卷核心目标…" style={{ fontSize: '0.8rem' }} />
            <textarea className="input-field" rows={3} value={vol.synopsis} onChange={(e) => updateVolume(idx, 'synopsis', e.target.value)} placeholder="本卷剧情概要…" style={{ fontSize: '0.8rem', lineHeight: 1.6, resize: 'vertical' }} />
          </div>
        </div>
      ))}

      <button
        onClick={addVolume}
        style={{
          width: '100%', padding: '0.6rem', borderRadius: '0.5rem',
          border: '1px dashed var(--border-light)', background: 'transparent',
          color: accentColor, fontSize: '0.8rem', fontWeight: 600,
          cursor: 'pointer', transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = `rgba(20,184,166,0.08)`; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        + 添加卷
      </button>
    </div>
  );
}
