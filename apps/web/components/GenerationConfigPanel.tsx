import React, { useEffect, useState } from 'react';
import { ProjectSummary } from '../types/dashboard';
import { createDefaultGenerationProfile, useGenerationProfile } from '../hooks/useGenerationProfile';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  onSaved?: () => void | Promise<void>;
}

type BooleanFormKey =
  | 'autoContinue'
  | 'autoSummarize'
  | 'autoUpdateCharacterState'
  | 'autoUpdateTimeline'
  | 'autoValidation'
  | 'allowNewCharacters'
  | 'allowNewLocations'
  | 'allowNewForeshadows';

type FormState = Record<BooleanFormKey, boolean> & {
  defaultChapterWordCount: string;
  preGenerationChecks: string;
  promptBudget: string;
  metadata: string;
};

function profileToForm(profile: ReturnType<typeof createDefaultGenerationProfile>): FormState {
  return {
    defaultChapterWordCount: profile.defaultChapterWordCount ? String(profile.defaultChapterWordCount) : '',
    autoContinue: profile.autoContinue,
    autoSummarize: profile.autoSummarize,
    autoUpdateCharacterState: profile.autoUpdateCharacterState,
    autoUpdateTimeline: profile.autoUpdateTimeline,
    autoValidation: profile.autoValidation,
    allowNewCharacters: profile.allowNewCharacters,
    allowNewLocations: profile.allowNewLocations,
    allowNewForeshadows: profile.allowNewForeshadows,
    preGenerationChecks: JSON.stringify(profile.preGenerationChecks ?? [], null, 2),
    promptBudget: JSON.stringify(profile.promptBudget ?? {}, null, 2),
    metadata: JSON.stringify(profile.metadata ?? {}, null, 2),
  };
}

export function GenerationConfigPanel({ selectedProject, selectedProjectId, onSaved }: Props) {
  const { profile, loading, saving, error, updateProfile } = useGenerationProfile(selectedProjectId);
  const [form, setForm] = useState<FormState>(() => profileToForm(createDefaultGenerationProfile(selectedProjectId)));
  const [localError, setLocalError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const nextProfile = profile ?? createDefaultGenerationProfile(selectedProjectId);
    setForm(profileToForm(nextProfile));
    setSaved(false);
  }, [profile, selectedProjectId]);

  const updateField = (key: keyof FormState, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const handleSubmit = async () => {
    setLocalError('');
    try {
      const ok = await updateProfile({
        defaultChapterWordCount: parsePositiveInt(form.defaultChapterWordCount, '默认单章字数'),
        autoContinue: form.autoContinue,
        autoSummarize: form.autoSummarize,
        autoUpdateCharacterState: form.autoUpdateCharacterState,
        autoUpdateTimeline: form.autoUpdateTimeline,
        autoValidation: form.autoValidation,
        allowNewCharacters: form.allowNewCharacters,
        allowNewLocations: form.allowNewLocations,
        allowNewForeshadows: form.allowNewForeshadows,
        preGenerationChecks: parseJsonArray(form.preGenerationChecks, '生成前检查'),
        promptBudget: parseJsonObject(form.promptBudget, 'Prompt 预算'),
        metadata: parseJsonObject(form.metadata, 'Metadata'),
      });
      setSaved(ok);
      if (ok) await onSaved?.();
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'JSON 格式错误。');
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header
        className="flex items-center justify-between shrink-0"
        style={{
          minHeight: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0.75rem 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', boxShadow: '0 0 10px rgba(56,189,248,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">生成配置</h1>
          <span className="badge" style={{ background: 'rgba(56,189,248,0.14)', color: '#38bdf8', border: 'none' }}>Generation Profile</span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
      </header>

      <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '1.5rem 2rem' }}>
        <section className="space-y-4" style={{ maxWidth: '72rem' }}>
          {loading ? <div className="panel p-4 text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div> : null}

          <div className="panel p-5 space-y-4">
            <SectionTitle title="自动流程" />
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <ToggleField label="自动续写" checked={form.autoContinue} onChange={(value) => updateField('autoContinue', value)} />
              <ToggleField label="自动总结" checked={form.autoSummarize} onChange={(value) => updateField('autoSummarize', value)} />
              <ToggleField label="自动更新角色状态" checked={form.autoUpdateCharacterState} onChange={(value) => updateField('autoUpdateCharacterState', value)} />
              <ToggleField
                label="自动更新时间线"
                description="开启后在章节生成或润色后运行时间线对齐预览与校验；默认不写库，只有 metadata.timelineAutoWritePolicy=validated_auto_write 且校验零 issue 时才允许自动写入。"
                checked={form.autoUpdateTimeline}
                onChange={(value) => updateField('autoUpdateTimeline', value)}
              />
              <ToggleField label="自动校验" checked={form.autoValidation} onChange={(value) => updateField('autoValidation', value)} />
            </div>
          </div>

          <div className="panel p-5 space-y-4">
            <SectionTitle title="新增实体权限" />
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <ToggleField label="允许新增角色" checked={form.allowNewCharacters} onChange={(value) => updateField('allowNewCharacters', value)} />
              <ToggleField label="允许新增地点" checked={form.allowNewLocations} onChange={(value) => updateField('allowNewLocations', value)} />
              <ToggleField label="允许新增伏笔" checked={form.allowNewForeshadows} onChange={(value) => updateField('allowNewForeshadows', value)} />
            </div>
          </div>

          <div className="panel p-5 space-y-4">
            <SectionTitle title="生成参数" />
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))' }}>
              <TextField
                label="默认单章字数"
                value={form.defaultChapterWordCount}
                onChange={(value) => updateField('defaultChapterWordCount', value)}
                type="number"
              />
              <JsonField
                label="生成前检查 JSON 数组"
                value={form.preGenerationChecks}
                onChange={(value) => updateField('preGenerationChecks', value)}
                minHeight="7.5rem"
              />
            </div>
          </div>

          <div className="panel p-5 space-y-4">
            <SectionTitle title="高级 JSON" />
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))' }}>
              <JsonField label="Prompt 预算 JSON 对象" value={form.promptBudget} onChange={(value) => updateField('promptBudget', value)} />
              <JsonField label="Metadata JSON 对象" value={form.metadata} onChange={(value) => updateField('metadata', value)} />
            </div>
          </div>

          {(localError || error) && (
            <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.75rem' }}>
              {localError || error}
            </div>
          )}
          {saved && !saving && <div className="text-xs" style={{ color: '#10b981' }}>已保存</div>}

          <div className="flex justify-end">
            <button className="btn" onClick={handleSubmit} disabled={saving || loading || !selectedProjectId}>
              {saving ? '保存中…' : '保存生成配置'}
            </button>
          </div>
        </section>
      </div>
    </article>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>
      {title}
    </h2>
  );
}

function ToggleField({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label
      className="flex items-center justify-between gap-3"
      style={{
        minHeight: description ? '4.5rem' : '3rem',
        padding: '0.75rem 0.9rem',
        border: '1px solid var(--border-dim)',
        borderRadius: '0.75rem',
        background: checked ? 'var(--accent-cyan-bg)' : 'var(--bg-hover-subtle)',
        cursor: 'pointer',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span className="block text-sm font-medium" style={{ color: checked ? 'var(--text-main)' : 'var(--text-muted)' }}>
          {label}
        </span>
        {description ? (
          <span className="mt-1 block text-xs leading-5" style={{ color: checked ? 'var(--text-muted)' : 'var(--text-dim)', overflowWrap: 'anywhere' }}>
            {description}
          </span>
        ) : null}
      </span>
      <input className="sr-only" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span
        aria-hidden="true"
        style={{
          width: '2.35rem',
          height: '1.3rem',
          borderRadius: '999px',
          border: `1px solid ${checked ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
          background: checked ? 'var(--accent-cyan)' : 'var(--bg-overlay)',
          position: 'relative',
          flexShrink: 0,
          transition: 'all 0.2s ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '2px',
            left: checked ? '1.08rem' : '2px',
            width: '0.95rem',
            height: '0.95rem',
            borderRadius: '50%',
            background: '#f8fafc',
            transition: 'left 0.2s ease',
          }}
        />
      </span>
    </label>
  );
}

function TextField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input className="input-field" min={type === 'number' ? 200 : undefined} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function JsonField({ label, value, onChange, minHeight = '10rem' }: { label: string; value: string; onChange: (value: string) => void; minHeight?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <textarea
        className="input-field font-mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ minHeight, resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }}
      />
    </label>
  );
}

function parsePositiveInt(value: string, label: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 200) {
    throw new Error(`${label} 必须是不低于 200 的正整数。`);
  }
  return Math.floor(parsed);
}

function parseJsonArray(value: string, label: string): unknown[] {
  const parsed = value.trim() ? JSON.parse(value) : [];
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 数组。`);
  }
  return parsed;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}
