import React, { useEffect, useState } from 'react';
import { ProjectSummary } from '../types/dashboard';
import { useCreativeProfile } from '../hooks/useCreativeProfile';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function CreativeProfilePanel({ selectedProject, selectedProjectId }: Props) {
  const { profile, loading, saving, error, updateProfile } = useCreativeProfile(selectedProjectId);
  const [form, setForm] = useState({
    audienceType: '',
    platformTarget: '',
    sellingPoints: '',
    pacingPreference: '',
    targetWordCount: '',
    chapterWordCount: '',
    contentRating: '',
    centralConflict: '{}',
    generationDefaults: '{}',
    validationDefaults: '{}',
  });
  const [localError, setLocalError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setForm({
      audienceType: profile.audienceType ?? '',
      platformTarget: profile.platformTarget ?? '',
      sellingPoints: (profile.sellingPoints ?? []).join(', '),
      pacingPreference: profile.pacingPreference ?? '',
      targetWordCount: profile.targetWordCount ? String(profile.targetWordCount) : '',
      chapterWordCount: profile.chapterWordCount ? String(profile.chapterWordCount) : '',
      contentRating: profile.contentRating ?? '',
      centralConflict: JSON.stringify(profile.centralConflict ?? {}, null, 2),
      generationDefaults: JSON.stringify(profile.generationDefaults ?? {}, null, 2),
      validationDefaults: JSON.stringify(profile.validationDefaults ?? {}, null, 2),
    });
    setSaved(false);
  }, [profile]);

  const updateField = (key: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const handleSubmit = async () => {
    setLocalError('');
    try {
      const ok = await updateProfile({
        audienceType: emptyToNull(form.audienceType),
        platformTarget: emptyToNull(form.platformTarget),
        sellingPoints: form.sellingPoints.split(',').map((item) => item.trim()).filter(Boolean),
        pacingPreference: emptyToNull(form.pacingPreference),
        targetWordCount: parsePositiveInt(form.targetWordCount),
        chapterWordCount: parsePositiveInt(form.chapterWordCount),
        contentRating: emptyToNull(form.contentRating),
        centralConflict: parseJsonObject(form.centralConflict, '核心冲突'),
        generationDefaults: parseJsonObject(form.generationDefaults, '生成默认值'),
        validationDefaults: parseJsonObject(form.validationDefaults, '校验默认值'),
      });
      setSaved(ok);
    } catch (parseError) {
      setLocalError(parseError instanceof Error ? parseError.message : 'JSON 格式错误。');
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <header className="flex items-center justify-between shrink-0" style={{ height: '3.5rem', background: 'var(--bg-editor-header)', padding: '0 2rem', borderBottom: '1px solid var(--border-light)', backdropFilter: 'blur(12px)', zIndex: 10 }}>
        <div className="flex items-center gap-3">
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#38bdf8', boxShadow: '0 0 10px rgba(56,189,248,0.5)' }} />
          <h1 className="text-lg font-bold text-heading">生成配置</h1>
          <span className="badge" style={{ background: 'rgba(56,189,248,0.14)', color: '#38bdf8', border: 'none' }}>Creative Profile</span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
      </header>

      <div className="flex-1 min-h-0" style={{ overflowY: 'auto', padding: '1.5rem 2rem' }}>
        <section className="panel p-5 space-y-4" style={{ maxWidth: '64rem' }}>
          {loading ? <div className="text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div> : null}

          <div className="grid grid-cols-2 gap-4">
            <TextField label="读者定位" value={form.audienceType} onChange={(value) => updateField('audienceType', value)} />
            <TextField label="平台定位" value={form.platformTarget} onChange={(value) => updateField('platformTarget', value)} />
            <TextField label="爽点" value={form.sellingPoints} onChange={(value) => updateField('sellingPoints', value)} />
            <TextField label="节奏偏好" value={form.pacingPreference} onChange={(value) => updateField('pacingPreference', value)} />
            <TextField label="总字数目标" value={form.targetWordCount} onChange={(value) => updateField('targetWordCount', value)} type="number" />
            <TextField label="单章字数" value={form.chapterWordCount} onChange={(value) => updateField('chapterWordCount', value)} type="number" />
            <TextField label="内容分级" value={form.contentRating} onChange={(value) => updateField('contentRating', value)} />
          </div>

          <JsonField label="核心冲突 JSON" value={form.centralConflict} onChange={(value) => updateField('centralConflict', value)} />
          <JsonField label="生成默认值 JSON" value={form.generationDefaults} onChange={(value) => updateField('generationDefaults', value)} />
          <JsonField label="校验默认值 JSON" value={form.validationDefaults} onChange={(value) => updateField('validationDefaults', value)} />

          {(localError || error) && <div className="text-xs" style={{ color: 'var(--status-err)', background: 'var(--status-err-bg)', borderRadius: '0.5rem', padding: '0.6rem' }}>{localError || error}</div>}
          {saved && !saving && <div className="text-xs" style={{ color: '#10b981' }}>已保存</div>}

          <div className="flex justify-end">
            <button className="btn" onClick={handleSubmit} disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
          </div>
        </section>
      </div>
    </article>
  );
}

function TextField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <input className="input-field" type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold mb-1" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <textarea className="input-field font-mono" value={value} onChange={(event) => onChange(event.target.value)} style={{ minHeight: '8rem', resize: 'vertical', fontSize: '0.78rem', lineHeight: 1.5 }} />
    </label>
  );
}

function emptyToNull(value: string) {
  return value.trim() || null;
}

function parsePositiveInt(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('字数必须是正整数。');
  }
  return Math.floor(parsed);
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = value.trim() ? JSON.parse(value) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return parsed as Record<string, unknown>;
}
