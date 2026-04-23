import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ProjectSummary } from '../types/dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

interface Props {
  project: ProjectSummary;
}

export function OutlineEditor({ project }: Props) {
  const [content, setContent] = useState(project.outline ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync content when project changes
  useEffect(() => {
    setContent(project.outline ?? '');
    setDirty(false);
    setSaved(false);
    setError('');
  }, [project.id, project.outline]);

  const saveContent = useCallback(async (text: string) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outline: text }),
        cache: 'no-store',
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `保存失败: ${res.status}`);
      }
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [project.id]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setContent(newValue);
    setDirty(true);
    setSaved(false);

    // Debounced auto-save after 2s of inactivity
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      saveContent(newValue);
    }, 2000);
  };

  const handleManualSave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    saveContent(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleManualSave();
    }
  };

  return (
    <div className="flex flex-col animate-fade-in" style={{ height: '100%' }}>
      {/* Toolbar */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: '0.5rem 1rem',
          borderBottom: '1px solid var(--border-dim)',
          background: 'var(--bg-card)',
          borderRadius: '0.5rem 0.5rem 0 0',
        }}
      >
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#f59e0b" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-bold" style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            剧情大纲
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Status indicator */}
          {saving && (
            <span className="text-xs animate-pulse-glow" style={{ color: 'var(--accent-cyan)' }}>
              保存中…
            </span>
          )}
          {saved && !saving && (
            <span className="text-xs" style={{ color: '#10b981' }}>
              ✓ 已保存
            </span>
          )}
          {dirty && !saving && !saved && (
            <span className="text-xs" style={{ color: '#f59e0b' }}>
              ● 未保存
            </span>
          )}
          {error && (
            <span className="text-xs" style={{ color: 'var(--status-err)' }}>
              {error}
            </span>
          )}
          <button
            className="btn"
            onClick={handleManualSave}
            disabled={saving || !dirty}
            style={{ fontSize: '0.7rem', padding: '0.25rem 0.6rem' }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {/* Editor area */}
      <div style={{ flex: 1, position: 'relative' }}>
        <textarea
          className="editor-textarea"
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={`在此编写你的剧情大纲…\n\n可以包括：\n• 故事主线与核心冲突\n• 各幕/卷的剧情走向\n• 关键转折点与高潮设计\n• 支线剧情规划\n• 结局构想与伏笔布局\n• 时间线与节奏安排`}
        />
      </div>

      {/* Footer hint */}
      <div
        className="shrink-0 text-center"
        style={{
          padding: '0.4rem',
          borderTop: '1px solid var(--border-dim)',
          fontSize: '0.65rem',
          color: 'var(--text-dim)',
        }}
      >
        Ctrl+S 手动保存 · 停止输入 2 秒后自动保存
      </div>
    </div>
  );
}
