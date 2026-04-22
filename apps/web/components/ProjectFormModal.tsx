import React, { useState, useEffect } from 'react';
import { ProjectFormData } from '../hooks/useProjectActions';
import { ProjectSummary } from '../types/dashboard';

interface Props {
  isOpen: boolean;
  editingProject: ProjectSummary | null;
  loading: boolean;
  error: string;
  onSubmit: (data: ProjectFormData) => void;
  onClose: () => void;
}

const INITIAL_FORM: ProjectFormData = {
  title: '',
  genre: '',
  theme: '',
  tone: '',
  targetWordCount: undefined,
};

export function ProjectFormModal({ isOpen, editingProject, loading, error, onSubmit, onClose }: Props) {
  const [form, setForm] = useState<ProjectFormData>(INITIAL_FORM);

  useEffect(() => {
    if (editingProject) {
      setForm({
        title: editingProject.title,
        genre: editingProject.genre ?? '',
        theme: editingProject.theme ?? '',
        tone: editingProject.tone ?? '',
        targetWordCount: undefined,
      });
    } else {
      setForm(INITIAL_FORM);
    }
  }, [editingProject, isOpen]);

  if (!isOpen) return null;

  const isEdit = !!editingProject;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit({
      ...form,
      title: form.title.trim(),
      genre: form.genre?.trim() || undefined,
      theme: form.theme?.trim() || undefined,
      tone: form.tone?.trim() || undefined,
    });
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
          maxWidth: '28rem',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
        }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h2
          className="text-lg font-bold mb-4"
          style={{ color: 'var(--accent-cyan)', textShadow: '0 0 10px var(--accent-cyan-glow)' }}
        >
          {isEdit ? '编辑项目' : '新建项目'}
        </h2>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold mb-1" style={{ display: 'block', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              项目标题 *
            </label>
            <input
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="输入项目名称"
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-bold mb-1" style={{ display: 'block', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                类型
              </label>
              <input
                className="input"
                value={form.genre ?? ''}
                onChange={(e) => setForm({ ...form, genre: e.target.value })}
                placeholder="如：玄幻、都市"
              />
            </div>
            <div>
              <label className="text-xs font-bold mb-1" style={{ display: 'block', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                基调
              </label>
              <input
                className="input"
                value={form.tone ?? ''}
                onChange={(e) => setForm({ ...form, tone: e.target.value })}
                placeholder="如：轻松、严肃"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-bold mb-1" style={{ display: 'block', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              主题
            </label>
            <input
              className="input"
              value={form.theme ?? ''}
              onChange={(e) => setForm({ ...form, theme: e.target.value })}
              placeholder="如：成长、复仇"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
            {error}
          </div>
        )}

        <div className="flex gap-3 mt-4 justify-end">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>
            取消
          </button>
          <button type="submit" className="btn" disabled={loading || !form.title.trim()}>
            {loading ? '处理中…' : isEdit ? '保存修改' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
}
