import React, { useState, useEffect } from 'react';
import { ProjectSummary, VolumeSummary } from '../types/dashboard';
import { useVolumeActions, VolumeFormData } from '../hooks/useVolumeActions';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function VolumePanel({ selectedProject, selectedProjectId }: Props) {
  const {
    volumes,
    loading,
    error,
    setError,
    loadVolumes,
    createVolume,
    updateVolume,
    deleteVolume,
  } = useVolumeActions(selectedProjectId);

  const [editingVolume, setEditingVolume] = useState<VolumeSummary | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    if (selectedProjectId) {
      loadVolumes();
    }
  }, [selectedProjectId, loadVolumes]);

  const handleCreate = async (data: VolumeFormData) => {
    const ok = await createVolume(data);
    if (ok) setShowCreateForm(false);
  };

  const handleSaveSynopsis = async (volumeId: string, synopsis: string) => {
    await updateVolume(volumeId, { synopsis });
  };

  const handleDelete = async (volumeId: string) => {
    await deleteVolume(volumeId);
    if (editingVolume?.id === volumeId) {
      setEditingVolume(null);
    }
  };

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between shrink-0"
        style={{
          height: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
        }}
      >
        <div className="flex items-center gap-3">
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: '#14b8a6',
              boxShadow: '0 0 10px rgba(20,184,166,0.5)',
            }}
          />
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            卷管理
          </h1>
          <span
            className="badge"
            style={{
              background: 'rgba(20,184,166,0.12)',
              color: '#14b8a6',
              border: 'none',
            }}
          >
            Volumes
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
            {selectedProject?.title ?? '未选择项目'}
          </div>
          {selectedProjectId && (
            <button
              className="btn-primary"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.85rem' }}
              onClick={() => {
                setShowCreateForm(true);
                setError('');
              }}
            >
              + 新增卷
            </button>
          )}
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 px-8 py-6" style={{ overflowY: 'auto' }}>
        {!selectedProjectId ? (
          <EmptyState message="请先选择一个项目" />
        ) : loading && volumes.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-dim)' }}>
            加载中…
          </div>
        ) : (
          <div className="space-y-4">
            {error && (
              <div className="text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
                {error}
              </div>
            )}

            {/* Create form */}
            {showCreateForm && (
              <VolumeCreateForm
                nextVolumeNo={volumes.length + 1}
                onSubmit={handleCreate}
                onCancel={() => setShowCreateForm(false)}
              />
            )}

            {/* Volume list */}
            {volumes.length === 0 && !showCreateForm ? (
              <EmptyState message="尚未创建任何卷。点击「新增卷」开始规划你的故事结构。" />
            ) : (
              <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(22rem, 1fr))' }}>
                {volumes.map((volume) => (
                  <VolumeCard
                    key={volume.id}
                    volume={volume}
                    isEditing={editingVolume?.id === volume.id}
                    onEdit={() => setEditingVolume(volume)}
                    onSaveSynopsis={(synopsis) => handleSaveSynopsis(volume.id, synopsis)}
                    onDelete={() => handleDelete(volume.id)}
                    onCancelEdit={() => setEditingVolume(null)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/* ─── Sub-components (kept local since they're small and panel-specific) ─── */

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full animate-fade-in" style={{ opacity: 0.7 }}>
      <div
        className="flex items-center justify-center animate-pulse-glow"
        style={{
          width: '5rem',
          height: '5rem',
          borderRadius: '1.25rem',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-light)',
          color: '#14b8a6',
          marginBottom: '1.5rem',
        }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      </div>
      <p className="text-sm text-center" style={{ color: 'var(--text-dim)', maxWidth: '24rem', lineHeight: 1.6 }}>
        {message}
      </p>
    </div>
  );
}

function VolumeCreateForm({
  nextVolumeNo,
  onSubmit,
  onCancel,
}: {
  nextVolumeNo: number;
  onSubmit: (data: VolumeFormData) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');

  const handleSubmit = () => {
    onSubmit({
      volumeNo: nextVolumeNo,
      title: title || undefined,
      objective: objective || undefined,
    });
  };

  return (
    <div
      className="panel p-5 animate-fade-in"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)' }}
    >
      <h3 className="text-sm font-bold mb-3" style={{ color: '#14b8a6' }}>新增第 {nextVolumeNo} 卷</h3>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>卷标题</label>
          <input
            className="input-field"
            placeholder={`第${nextVolumeNo}卷`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>本卷目标</label>
          <textarea
            className="input-field"
            rows={2}
            placeholder="描述这一卷的叙事目标…"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </div>
        <div className="flex gap-3 justify-end">
          <button className="btn-secondary" onClick={onCancel}>取消</button>
          <button className="btn-primary" onClick={handleSubmit}>创建</button>
        </div>
      </div>
    </div>
  );
}

function VolumeCard({
  volume,
  isEditing,
  onEdit,
  onSaveSynopsis,
  onDelete,
  onCancelEdit,
}: {
  volume: VolumeSummary;
  isEditing: boolean;
  onEdit: () => void;
  onSaveSynopsis: (synopsis: string) => void;
  onDelete: () => void;
  onCancelEdit: () => void;
}) {
  const [synopsis, setSynopsis] = useState(volume.synopsis ?? '');
  const chapterCount = volume._count?.chapters ?? 0;

  useEffect(() => {
    setSynopsis(volume.synopsis ?? '');
  }, [volume.synopsis]);

  const statusLabel: Record<string, { text: string; color: string }> = {
    planned: { text: '规划中', color: '#f59e0b' },
    active: { text: '进行中', color: '#10b981' },
    completed: { text: '已完成', color: '#6366f1' },
  };
  const statusInfo = statusLabel[volume.status] ?? statusLabel.planned;

  return (
    <div
      className="panel p-5 animate-fade-in"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${isEditing ? '#14b8a6' : 'var(--border-light)'}`,
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold" style={{ color: 'var(--text-main)' }}>
            {volume.title || `第${volume.volumeNo}卷`}
          </span>
          <span
            className="badge"
            style={{
              background: `${statusInfo.color}20`,
              color: statusInfo.color,
              border: 'none',
              fontSize: '0.65rem',
            }}
          >
            {statusInfo.text}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
            {chapterCount} 章
          </span>
        </div>
      </div>

      {/* Objective */}
      {volume.objective && (
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>目标：</span>
          {volume.objective}
        </p>
      )}

      {/* Synopsis editor */}
      {isEditing ? (
        <div className="space-y-2">
          <label className="text-xs font-medium block" style={{ color: 'var(--text-dim)' }}>卷纲</label>
          <textarea
            className="input-field"
            rows={5}
            value={synopsis}
            onChange={(e) => setSynopsis(e.target.value)}
            placeholder="编写这一卷的详细剧情大纲…"
          />
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={onCancelEdit} style={{ fontSize: '0.75rem' }}>取消</button>
            <button className="btn-primary" onClick={() => onSaveSynopsis(synopsis)} style={{ fontSize: '0.75rem' }}>保存卷纲</button>
          </div>
        </div>
      ) : (
        <>
          {volume.synopsis ? (
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.6, maxHeight: '6rem', overflow: 'hidden' }}>
              {volume.synopsis}
            </p>
          ) : (
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
              尚未编写卷纲
            </p>
          )}
        </>
      )}

      {/* Card actions */}
      {!isEditing && (
        <div className="flex gap-2 mt-3 pt-3" style={{ borderTop: '1px solid var(--border-dim)' }}>
          <button className="btn-secondary" onClick={onEdit} style={{ fontSize: '0.7rem' }}>编辑卷纲</button>
          <button
            className="btn-secondary"
            onClick={onDelete}
            style={{ fontSize: '0.7rem', color: 'var(--status-err)' }}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}
