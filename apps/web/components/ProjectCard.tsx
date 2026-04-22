import React from 'react';
import { ProjectSummary } from '../types/dashboard';

interface Props {
  project: ProjectSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onEdit: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

export function ProjectCard({ project, isSelected, onSelect, onEdit, onDelete }: Props) {
  return (
    <div
      className="project-card"
      style={{
        background: isSelected ? 'var(--accent-cyan-bg)' : 'var(--bg-card)',
        border: `1px solid ${isSelected ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '1.25rem',
        cursor: 'pointer',
        transition: 'all 0.3s ease',
        boxShadow: isSelected ? '0 0 20px var(--accent-cyan-glow)' : '0 4px 15px rgba(0,0,0,0.2)',
        position: 'relative',
        overflow: 'hidden',
      }}
      onClick={() => onSelect(project.id)}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = 'var(--border-hover)';
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.3)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.borderColor = 'var(--border-light)';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
        }
      }}
    >
      {/* Glow accent for selected */}
      {isSelected && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '2px',
          background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)',
        }} />
      )}

      <div className="flex items-center justify-between mb-3">
        <h3
          className="text-base font-bold"
          style={{
            color: isSelected ? 'var(--accent-cyan)' : 'var(--text-main)',
            textShadow: isSelected ? '0 0 10px var(--accent-cyan-glow)' : 'none',
          }}
        >
          {project.title}
        </h3>
        <span
          className="badge"
          style={{
            background: project.status === 'active' ? 'rgba(34,197,94,0.15)' : 'var(--bg-hover-subtle)',
            color: project.status === 'active' ? '#4ade80' : 'var(--text-dim)',
            borderColor: project.status === 'active' ? 'rgba(34,197,94,0.3)' : 'var(--border-dim)',
          }}
        >
          {project.status === 'active' ? '进行中' : project.status === 'archived' ? '已归档' : '草稿'}
        </span>
      </div>

      {/* Tags row */}
      <div className="flex flex-wrap gap-2 mb-3">
        {project.genre && (
          <span className="badge" style={{ background: 'var(--bg-overlay)', color: 'var(--text-dim)', borderColor: 'var(--border-dim)' }}>
            {project.genre}
          </span>
        )}
        {project.theme && (
          <span className="badge" style={{ background: 'var(--bg-overlay)', color: 'var(--text-dim)', borderColor: 'var(--border-dim)' }}>
            {project.theme}
          </span>
        )}
        {project.tone && (
          <span className="badge" style={{ background: 'var(--bg-overlay)', color: 'var(--text-dim)', borderColor: 'var(--border-dim)' }}>
            {project.tone}
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="flex gap-4 text-xs" style={{ color: 'var(--text-dim)' }}>
        <span>📖 {project.stats?.chapterCount ?? 0} 章</span>
        <span>👤 {project.stats?.characterCount ?? 0} 角色</span>
        <span>🧠 {project.stats?.memoryChunkCount ?? 0} 记忆</span>
      </div>

      {/* Action buttons */}
      <div
        className="flex gap-2 mt-3 justify-end"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="btn-secondary text-xs"
          style={{ padding: '0.3rem 0.7rem', fontSize: '0.7rem' }}
          onClick={() => onEdit(project)}
        >
          编辑
        </button>
        <button
          className="btn-danger text-xs"
          style={{ padding: '0.3rem 0.7rem', fontSize: '0.7rem' }}
          onClick={() => onDelete(project)}
        >
          删除
        </button>
      </div>
    </div>
  );
}
