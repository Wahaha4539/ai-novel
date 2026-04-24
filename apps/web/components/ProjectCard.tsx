import React from 'react';
import { ProjectSummary } from '../types/dashboard';

interface Props {
  project: ProjectSummary;
  isSelected: boolean;
  /** 是否处于批量选择模式 */
  batchMode: boolean;
  /** 当前卡片是否被勾选（批量模式下） */
  isChecked: boolean;
  onSelect: (id: string) => void;
  onEdit: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
  /** 切换批量勾选状态 */
  onToggleCheck: (id: string) => void;
}

export function ProjectCard({
  project,
  isSelected,
  batchMode,
  isChecked,
  onSelect,
  onEdit,
  onDelete,
  onToggleCheck,
}: Props) {
  /** 批量模式下点击卡片切换勾选；普通模式下进入项目 */
  const handleCardClick = () => {
    if (batchMode) {
      onToggleCheck(project.id);
    } else {
      onSelect(project.id);
    }
  };

  return (
    <div
      className="project-card"
      style={{
        background: isChecked
          ? 'rgba(244, 63, 94, 0.08)'
          : isSelected
            ? 'var(--accent-cyan-bg)'
            : 'var(--bg-card)',
        border: `1px solid ${
          isChecked
            ? 'rgba(244, 63, 94, 0.4)'
            : isSelected
              ? 'var(--accent-cyan)'
              : 'var(--border-light)'
        }`,
        borderRadius: 'var(--radius-lg)',
        padding: '1.25rem',
        cursor: 'pointer',
        transition: 'all 0.3s ease',
        boxShadow: isChecked
          ? '0 0 20px rgba(244, 63, 94, 0.15)'
          : isSelected
            ? '0 0 20px var(--accent-cyan-glow)'
            : '0 4px 15px rgba(0,0,0,0.1)',
        position: 'relative',
        overflow: 'hidden',
      }}
      onClick={handleCardClick}
      onMouseEnter={(e) => {
        if (!isSelected && !isChecked) {
          e.currentTarget.style.borderColor = 'var(--border-hover)';
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.12)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected && !isChecked) {
          e.currentTarget.style.borderColor = 'var(--border-light)';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 4px 15px rgba(0,0,0,0.1)';
        }
      }}
    >
      {/* Glow accent for selected */}
      {isSelected && !isChecked && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '2px',
          background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)',
        }} />
      )}

      {/* 批量模式：左上角勾选指示器 */}
      {batchMode && (
        <div
          style={{
            position: 'absolute',
            top: '0.75rem',
            left: '0.75rem',
            width: '1.25rem',
            height: '1.25rem',
            borderRadius: '4px',
            border: `2px solid ${isChecked ? 'var(--status-err)' : 'var(--border-hover)'}`,
            background: isChecked ? 'var(--status-err)' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s ease',
            zIndex: 2,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCheck(project.id);
          }}
        >
          {isChecked && (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              fill="none"
              viewBox="0 0 24 24"
              stroke="#fff"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h3
          className="text-base font-bold"
          style={{
            color: isChecked
              ? 'var(--status-err)'
              : isSelected
                ? 'var(--accent-cyan)'
                : 'var(--text-main)',
            textShadow: isSelected && !isChecked ? '0 0 10px var(--accent-cyan-glow)' : 'none',
            /* 批量模式下标题向右偏移，避免和 checkbox 重叠 */
            paddingLeft: batchMode ? '1.5rem' : '0',
            transition: 'padding-left 0.2s ease',
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

      {/* Action buttons — 非批量模式时显示 */}
      {!batchMode && (
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
      )}
    </div>
  );
}
