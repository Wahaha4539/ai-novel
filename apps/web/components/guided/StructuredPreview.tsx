import React from 'react';
import { GUIDED_STEPS, StepKey } from '../../hooks/useGuidedSession';

interface Props {
  currentStepKey: StepKey;
  stepData: Record<string, unknown>;
  onEditField: (field: string, value: string) => void;
}

/** Simple field definitions for non-character steps */
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
  // guided_volume uses dedicated VolumesPreview component
  guided_chapter: [
    { field: 'chapterPlan', label: '章节规划', type: 'textarea' },
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

/** Default empty character */
const emptyCharacter = (roleType = 'protagonist'): CharacterData => ({
  name: '',
  roleType,
  personalityCore: '',
  motivation: '',
  backstory: '',
});

export function StructuredPreview({ currentStepKey, stepData, onEditField }: Props) {
  const stepInfo = GUIDED_STEPS.find((s) => s.key === currentStepKey);

  // Character step uses a special multi-card layout
  if (currentStepKey === 'guided_characters') {
    return (
      <CharactersPreview
        stepInfo={stepInfo}
        stepData={stepData}
        onEditField={onEditField}
      />
    );
  }

  // Volume step uses a special multi-card layout
  if (currentStepKey === 'guided_volume') {
    return (
      <VolumesPreview
        stepInfo={stepInfo}
        stepData={stepData}
        onEditField={onEditField}
      />
    );
  }

  // All other steps use simple field layout
  const fields = SIMPLE_STEP_FIELDS[currentStepKey] ?? [];

  return (
    <div className="flex flex-col h-full">
      <PreviewHeader stepInfo={stepInfo} />
      <div className="flex-1 p-4 space-y-4" style={{ overflowY: 'auto' }}>
        {fields.map(({ field, label, type }) => {
          const value = (stepData[field] as string) ?? '';
          return (
            <FieldInput
              key={field}
              field={field}
              label={label}
              type={type}
              value={value}
              onChange={onEditField}
            />
          );
        })}

        {fields.length === 0 && (
          <div className="text-sm" style={{ color: 'var(--text-dim)', textAlign: 'center', paddingTop: '3rem' }}>
            此步骤暂无结构化预览字段
          </div>
        )}
      </div>
    </div>
  );
}

/** Preview header — shared by all steps */
function PreviewHeader({ stepInfo }: { stepInfo?: { icon: string; label: string; color: string } }) {
  return (
    <div
      style={{
        padding: '0.75rem 1.25rem',
        borderBottom: '1px solid var(--border-dim)',
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: '1.1rem' }}>{stepInfo?.icon}</span>
        <h3 className="text-sm font-bold" style={{ color: stepInfo?.color ?? 'var(--text-main)' }}>
          {stepInfo?.label ?? '预览'}
        </h3>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>— 可直接编辑</span>
      </div>
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
        className="text-xs font-semibold mb-1.5 block"
        style={{ color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}
      >
        {label}
      </label>
      {type === 'textarea' ? (
        <textarea
          className="input-field"
          rows={4}
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={`输入${label}…`}
          style={{ fontSize: '0.85rem', lineHeight: 1.7, resize: 'vertical' }}
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

/** Multi-character card preview for guided_characters step */
function CharactersPreview({
  stepInfo,
  stepData,
  onEditField,
}: {
  stepInfo?: { icon: string; label: string; color: string };
  stepData: Record<string, unknown>;
  onEditField: (field: string, value: string) => void;
}) {
  // Parse characters from stepData — stored as JSON string under "characters"
  const parseCharacters = (): CharacterData[] => {
    const raw = stepData.characters;
    if (!raw) {
      // Return default character slots
      return [
        emptyCharacter('protagonist'),
        emptyCharacter('supporting'),
        emptyCharacter('antagonist'),
      ];
    }
    try {
      if (typeof raw === 'string') return JSON.parse(raw) as CharacterData[];
      if (Array.isArray(raw)) return raw as CharacterData[];
    } catch {
      // Ignore parse errors
    }
    return [emptyCharacter('protagonist'), emptyCharacter('supporting'), emptyCharacter('antagonist')];
  };

  const characters = parseCharacters();

  const updateCharacter = (index: number, key: keyof CharacterData, value: string) => {
    const updated = [...characters];
    updated[index] = { ...updated[index], [key]: value };
    onEditField('characters', JSON.stringify(updated));
  };

  const addCharacter = () => {
    const updated = [...characters, emptyCharacter('supporting')];
    onEditField('characters', JSON.stringify(updated));
  };

  const removeCharacter = (index: number) => {
    if (characters.length <= 1) return;
    const updated = characters.filter((_, i) => i !== index);
    onEditField('characters', JSON.stringify(updated));
  };

  return (
    <div className="flex flex-col h-full">
      <PreviewHeader stepInfo={stepInfo} />
      <div className="flex-1 p-4 space-y-3" style={{ overflowY: 'auto' }}>
        {characters.map((char, idx) => (
          <CharacterCard
            key={idx}
            index={idx}
            character={char}
            total={characters.length}
            onUpdate={updateCharacter}
            onRemove={removeCharacter}
          />
        ))}

        {/* Add character button */}
        <button
          onClick={addCharacter}
          style={{
            width: '100%',
            padding: '0.6rem',
            borderRadius: '0.5rem',
            border: '1px dashed var(--border-light)',
            background: 'transparent',
            color: 'var(--accent-cyan)',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(14,165,233,0.08)';
            e.currentTarget.style.borderColor = 'var(--accent-cyan)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-light)';
          }}
        >
          + 添加角色
        </button>
      </div>
    </div>
  );
}

/** Single character card */
function CharacterCard({
  index,
  character,
  total,
  onUpdate,
  onRemove,
}: {
  index: number;
  character: CharacterData;
  total: number;
  onUpdate: (index: number, key: keyof CharacterData, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const roleLabel = ROLE_LABELS[character.roleType] ?? character.roleType;

  const roleColors: Record<string, string> = {
    protagonist: '#0ea5e9',
    antagonist: '#ef4444',
    supporting: '#f59e0b',
    competitor: '#8b5cf6',
  };
  const accentColor = roleColors[character.roleType] ?? '#6b7280';

  return (
    <div
      style={{
        borderRadius: '0.75rem',
        border: `1px solid ${accentColor}33`,
        background: `${accentColor}08`,
        padding: '0.75rem',
        transition: 'all 0.2s ease',
      }}
    >
      {/* Card header */}
      <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
        <div className="flex items-center gap-2">
          <div
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: accentColor,
              boxShadow: `0 0 6px ${accentColor}66`,
            }}
          />
          <span
            className="text-xs font-bold"
            style={{ color: accentColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            {roleLabel} #{index + 1}
          </span>
        </div>
        {total > 1 && (
          <button
            onClick={() => onRemove(index)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              fontSize: '0.7rem',
              cursor: 'pointer',
              padding: '0.15rem 0.4rem',
              borderRadius: '0.25rem',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            ✕ 移除
          </button>
        )}
      </div>

      {/* Role type selector */}
      <div style={{ marginBottom: '0.4rem' }}>
        <select
          className="input-field"
          value={character.roleType}
          onChange={(e) => onUpdate(index, 'roleType', e.target.value)}
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.5rem' }}
        >
          <option value="protagonist">主角</option>
          <option value="supporting">配角/同行者</option>
          <option value="antagonist">对手/反派</option>
          <option value="competitor">竞争者</option>
        </select>
      </div>

      {/* Character fields */}
      <div className="space-y-2">
        <input
          className="input-field"
          value={character.name}
          onChange={(e) => onUpdate(index, 'name', e.target.value)}
          placeholder="角色名…"
          style={{ fontSize: '0.8rem' }}
        />
        <input
          className="input-field"
          value={character.personalityCore}
          onChange={(e) => onUpdate(index, 'personalityCore', e.target.value)}
          placeholder="性格核心…"
          style={{ fontSize: '0.8rem' }}
        />
        <input
          className="input-field"
          value={character.motivation}
          onChange={(e) => onUpdate(index, 'motivation', e.target.value)}
          placeholder="核心动机…"
          style={{ fontSize: '0.8rem' }}
        />
        <textarea
          className="input-field"
          rows={2}
          value={character.backstory}
          onChange={(e) => onUpdate(index, 'backstory', e.target.value)}
          placeholder="背景故事…"
          style={{ fontSize: '0.8rem', lineHeight: 1.6, resize: 'vertical' }}
        />
      </div>
    </div>
  );
}

/** Volume data shape */
interface VolumeData {
  volumeNo: number;
  title: string;
  synopsis: string;
  objective: string;
}

const emptyVolume = (volumeNo: number): VolumeData => ({
  volumeNo,
  title: '',
  synopsis: '',
  objective: '',
});

/** Multi-volume card preview for guided_volume step */
function VolumesPreview({
  stepInfo,
  stepData,
  onEditField,
}: {
  stepInfo?: { icon: string; label: string; color: string };
  stepData: Record<string, unknown>;
  onEditField: (field: string, value: string) => void;
}) {
  const parseVolumes = (): VolumeData[] => {
    const raw = stepData.volumes;
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
    onEditField('volumes', JSON.stringify(updated));
  };

  const setVolumeCount = (count: number) => {
    const clamped = Math.max(1, Math.min(30, count));
    const updated: VolumeData[] = [];
    for (let i = 0; i < clamped; i++) {
      updated.push(volumes[i] ?? emptyVolume(i + 1));
      updated[i].volumeNo = i + 1;
    }
    onEditField('volumes', JSON.stringify(updated));
  };

  const addVolume = () => {
    const updated = [...volumes, emptyVolume(volumes.length + 1)];
    onEditField('volumes', JSON.stringify(updated));
  };

  const removeVolume = (index: number) => {
    if (volumes.length <= 1) return;
    const updated = volumes.filter((_, i) => i !== index)
      .map((v, i) => ({ ...v, volumeNo: i + 1 }));
    onEditField('volumes', JSON.stringify(updated));
  };

  return (
    <div className="flex flex-col h-full">
      <PreviewHeader stepInfo={stepInfo} />

      {/* Volume count control */}
      <div
        className="flex items-center gap-3 shrink-0"
        style={{
          padding: '0.6rem 1.25rem',
          borderBottom: '1px solid var(--border-dim)',
          background: 'var(--bg-card)',
        }}
      >
        <span className="text-xs font-semibold" style={{ color: 'var(--text-dim)' }}>卷数：</span>
        <input
          type="number"
          className="input-field"
          min={1}
          max={30}
          value={volumes.length}
          onChange={(e) => setVolumeCount(parseInt(e.target.value, 10) || 1)}
          style={{ width: '4rem', fontSize: '0.8rem', padding: '0.25rem 0.5rem', textAlign: 'center' }}
        />
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          共 {volumes.length} 卷
        </span>
      </div>

      <div className="flex-1 p-4 space-y-3" style={{ overflowY: 'auto' }}>
        {volumes.map((vol, idx) => (
          <VolumeCard
            key={idx}
            index={idx}
            volume={vol}
            total={volumes.length}
            onUpdate={updateVolume}
            onRemove={removeVolume}
          />
        ))}

        <button
          onClick={addVolume}
          style={{
            width: '100%',
            padding: '0.6rem',
            borderRadius: '0.5rem',
            border: '1px dashed var(--border-light)',
            background: 'transparent',
            color: '#14b8a6',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(20,184,166,0.08)';
            e.currentTarget.style.borderColor = '#14b8a6';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-light)';
          }}
        >
          + 添加卷
        </button>
      </div>
    </div>
  );
}

/** Single volume card */
function VolumeCard({
  index,
  volume,
  total,
  onUpdate,
  onRemove,
}: {
  index: number;
  volume: VolumeData;
  total: number;
  onUpdate: (index: number, key: keyof VolumeData, value: string | number) => void;
  onRemove: (index: number) => void;
}) {
  const accentColor = '#14b8a6';

  return (
    <div
      style={{
        borderRadius: '0.75rem',
        border: `1px solid ${accentColor}33`,
        background: `${accentColor}08`,
        padding: '0.75rem',
        transition: 'all 0.2s ease',
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
        <div className="flex items-center gap-2">
          <div
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: accentColor,
              boxShadow: `0 0 6px ${accentColor}66`,
            }}
          />
          <span className="text-xs font-bold" style={{ color: accentColor }}>
            第 {volume.volumeNo} 卷
          </span>
        </div>
        {total > 1 && (
          <button
            onClick={() => onRemove(index)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              fontSize: '0.7rem',
              cursor: 'pointer',
              padding: '0.15rem 0.4rem',
              borderRadius: '0.25rem',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            ✕ 移除
          </button>
        )}
      </div>

      <div className="space-y-2">
        <input
          className="input-field"
          value={volume.title}
          onChange={(e) => onUpdate(index, 'title', e.target.value)}
          placeholder="卷标题…"
          style={{ fontSize: '0.8rem' }}
        />
        <input
          className="input-field"
          value={volume.objective}
          onChange={(e) => onUpdate(index, 'objective', e.target.value)}
          placeholder="本卷核心目标…"
          style={{ fontSize: '0.8rem' }}
        />
        <textarea
          className="input-field"
          rows={3}
          value={volume.synopsis}
          onChange={(e) => onUpdate(index, 'synopsis', e.target.value)}
          placeholder="本卷剧情概要…"
          style={{ fontSize: '0.8rem', lineHeight: 1.6, resize: 'vertical' }}
        />
      </div>
    </div>
  );
}
