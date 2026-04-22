import React, { useState, useEffect } from 'react';
import { CharacterFormData } from '../hooks/useCharacterActions';
import { CharacterCard } from '../types/dashboard';

interface Props {
  isOpen: boolean;
  editingCharacter: CharacterCard | null;
  loading: boolean;
  error: string;
  onSubmit: (data: CharacterFormData) => void;
  onClose: () => void;
}

const ROLE_OPTIONS = ['主角', '配角', '反派', '导师', '龙套'];

const INITIAL_FORM: CharacterFormData = {
  name: '',
  roleType: '',
  personalityCore: '',
  motivation: '',
  speechStyle: '',
  backstory: '',
  growthArc: '',
  isDead: false,
};

export function CharacterFormModal({ isOpen, editingCharacter, loading, error, onSubmit, onClose }: Props) {
  const [form, setForm] = useState<CharacterFormData>(INITIAL_FORM);

  useEffect(() => {
    if (editingCharacter) {
      setForm({
        name: editingCharacter.name,
        roleType: editingCharacter.roleType ?? '',
        personalityCore: editingCharacter.personalityCore ?? '',
        motivation: editingCharacter.motivation ?? '',
        speechStyle: editingCharacter.speechStyle ?? '',
        backstory: editingCharacter.backstory ?? '',
        growthArc: editingCharacter.growthArc ?? '',
        isDead: editingCharacter.isDead ?? false,
      });
    } else {
      setForm(INITIAL_FORM);
    }
  }, [editingCharacter, isOpen]);

  if (!isOpen) return null;

  const isEdit = !!editingCharacter;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    onSubmit({
      ...form,
      name: form.name.trim(),
      roleType: form.roleType?.trim() || undefined,
      personalityCore: form.personalityCore?.trim() || undefined,
      motivation: form.motivation?.trim() || undefined,
      speechStyle: form.speechStyle?.trim() || undefined,
      backstory: form.backstory?.trim() || undefined,
      growthArc: form.growthArc?.trim() || undefined,
    });
  };

  const handleChange = (field: keyof CharacterFormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(8px)',
      }}
      onClick={onClose}
    >
      <form
        className="panel p-5 animate-slide-top"
        style={{
          width: '100%',
          maxWidth: '32rem',
          maxHeight: '85vh',
          overflowY: 'auto',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
        }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2
          className="text-lg font-bold mb-4"
          style={{ color: '#8b5cf6', textShadow: '0 0 10px rgba(139,92,246,0.3)' }}
        >
          {isEdit ? '编辑角色卡' : '新建角色卡'}
        </h2>

        <div className="space-y-3">
          {/* 名称 */}
          <FormField label="角色名 *">
            <input
              className="input"
              value={form.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="输入角色姓名"
              required
              autoFocus
            />
          </FormField>

          {/* 角色类型 */}
          <FormField label="角色类型">
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              {ROLE_OPTIONS.map((role) => (
                <button
                  key={role}
                  type="button"
                  style={{
                    padding: '0.25rem 0.65rem',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    border: '1px solid',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    borderColor: form.roleType === role ? '#8b5cf6' : 'var(--border-light)',
                    background: form.roleType === role ? 'rgba(139,92,246,0.15)' : 'transparent',
                    color: form.roleType === role ? '#8b5cf6' : 'var(--text-muted)',
                  }}
                  onClick={() => handleChange('roleType', form.roleType === role ? '' : role)}
                >
                  {role}
                </button>
              ))}
              <input
                className="input"
                value={ROLE_OPTIONS.includes(form.roleType ?? '') ? '' : (form.roleType ?? '')}
                onChange={(e) => handleChange('roleType', e.target.value)}
                placeholder="或自定义…"
                style={{ flex: 1, minWidth: '6rem', fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              />
            </div>
          </FormField>

          {/* 性格核心 */}
          <FormField label="性格核心">
            <textarea
              className="input"
              value={form.personalityCore ?? ''}
              onChange={(e) => handleChange('personalityCore', e.target.value)}
              placeholder="例如：外冷内热、正义感强、偏执多疑…"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </FormField>

          {/* 动机 */}
          <FormField label="核心动机">
            <textarea
              className="input"
              value={form.motivation ?? ''}
              onChange={(e) => handleChange('motivation', e.target.value)}
              placeholder="角色行动的核心驱动力…"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </FormField>

          {/* 说话风格 */}
          <FormField label="说话风格">
            <input
              className="input"
              value={form.speechStyle ?? ''}
              onChange={(e) => handleChange('speechStyle', e.target.value)}
              placeholder="例如：简洁冷酷、文绉绉、带口头禅…"
            />
          </FormField>

          {/* 背景故事 */}
          <FormField label="背景故事">
            <textarea
              className="input"
              value={form.backstory ?? ''}
              onChange={(e) => handleChange('backstory', e.target.value)}
              placeholder="角色的过往经历…"
              rows={3}
              style={{ resize: 'vertical' }}
            />
          </FormField>

          {/* 成长弧线 */}
          <FormField label="成长弧线">
            <textarea
              className="input"
              value={form.growthArc ?? ''}
              onChange={(e) => handleChange('growthArc', e.target.value)}
              placeholder="角色在故事中的变化轨迹…"
              rows={2}
              style={{ resize: 'vertical' }}
            />
          </FormField>

          {/* 已死亡 */}
          {isEdit && (
            <div className="flex items-center gap-2" style={{ padding: '0.5rem 0' }}>
              <input
                type="checkbox"
                id="isDead"
                checked={form.isDead ?? false}
                onChange={(e) => handleChange('isDead', e.target.checked)}
                style={{ accentColor: '#ef4444' }}
              />
              <label
                htmlFor="isDead"
                className="text-xs font-medium"
                style={{ color: form.isDead ? '#ef4444' : 'var(--text-dim)', cursor: 'pointer' }}
              >
                标记为已死亡
              </label>
            </div>
          )}
        </div>

        {error && (
          <div
            className="mt-3 text-xs"
            style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}
          >
            {error}
          </div>
        )}

        <div className="flex gap-3 mt-4 justify-end">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button type="submit" className="btn" disabled={loading || !form.name.trim()}>
            {loading ? '处理中…' : isEdit ? '保存修改' : '创建角色'}
          </button>
        </div>
      </form>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="text-xs font-bold mb-1"
        style={{
          display: 'block',
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
