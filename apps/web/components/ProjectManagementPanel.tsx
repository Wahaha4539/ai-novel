import React, { useState, useCallback, useMemo } from 'react';
import { ProjectSummary } from '../types/dashboard';
import { ProjectCard } from './ProjectCard';
import { ProjectFormModal } from './ProjectFormModal';
import { useProjectActions, ProjectFormData } from '../hooks/useProjectActions';

interface Props {
  projects: ProjectSummary[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onProjectsChanged: () => Promise<void>;
  onGuidedCreate: (projectId: string) => void;
}

export function ProjectManagementPanel({
  projects,
  selectedProjectId,
  onSelectProject,
  onProjectsChanged,
  onGuidedCreate,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(null);

  // ── 批量操作状态 ──
  const [batchMode, setBatchMode] = useState(false);
  /** 已勾选的项目 ID 集合 */
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  /** 是否显示批量删除确认弹窗 */
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);

  const { formLoading, formError, setFormError, createProject, updateProject, deleteProject, batchDeleteProjects } =
    useProjectActions(onProjectsChanged);

  // ── 常规操作 ──

  const handleOpenCreate = () => {
    setEditingProject(null);
    setFormError('');
    setShowForm(true);
  };

  const handleGuidedCreate = async () => {
    const result = await createProject({ title: '新小说（AI引导中…）' });
    if (result) {
      onGuidedCreate(result.id);
    }
  };

  const handleOpenEdit = (project: ProjectSummary) => {
    setEditingProject(project);
    setFormError('');
    setShowForm(true);
  };

  const handleFormSubmit = async (data: ProjectFormData) => {
    if (editingProject) {
      const result = await updateProject(editingProject.id, data);
      if (result) setShowForm(false);
    } else {
      const result = await createProject(data);
      if (result) setShowForm(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingProject) return;
    const success = await deleteProject(deletingProject.id);
    if (success) {
      if (selectedProjectId === deletingProject.id) {
        onSelectProject('');
      }
      setDeletingProject(null);
    }
  };

  // ── 批量操作逻辑 ──

  /** 进入/退出批量选择模式 */
  const toggleBatchMode = useCallback(() => {
    setBatchMode((prev) => {
      if (prev) {
        // 退出批量模式时清空勾选
        setCheckedIds(new Set());
      }
      return !prev;
    });
  }, []);

  /** 切换单个项目的勾选状态 */
  const handleToggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /** 全选 / 取消全选 */
  const isAllChecked = useMemo(
    () => projects.length > 0 && checkedIds.size === projects.length,
    [projects.length, checkedIds.size],
  );

  const handleToggleAll = useCallback(() => {
    if (isAllChecked) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(projects.map((p) => p.id)));
    }
  }, [isAllChecked, projects]);

  /** 确认批量删除 */
  const handleConfirmBatchDelete = async () => {
    const ids = Array.from(checkedIds);
    const success = await batchDeleteProjects(ids);
    if (success) {
      // 如果当前选中的项目在被删除列表中，清空选择
      if (checkedIds.has(selectedProjectId)) {
        onSelectProject('');
      }
      setCheckedIds(new Set());
      setBatchMode(false);
      setShowBatchDeleteConfirm(false);
    }
  };

  return (
    <article className="project-management-panel flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      {/* Header */}
      <header
        className="project-management-header flex items-center justify-between shrink-0"
        style={{
          height: '3.5rem',
          background: 'var(--bg-editor-header)',
          padding: '0 2rem',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
          zIndex: 10,
        }}
      >
        <div className="project-management-title flex items-center gap-3">
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            项目管理
          </h1>
          <span
            className="badge"
            style={{
              background: 'var(--accent-cyan-bg)',
              color: 'var(--accent-cyan)',
              border: 'none',
            }}
          >
            {projects.length} 个项目
          </span>
        </div>
        <div className="project-management-actions flex items-center gap-2">
          {/* 批量操作入口按钮 */}
          {projects.length > 0 && (
            <button
              className={batchMode ? 'btn-secondary' : 'btn-secondary'}
              style={{
                fontSize: '0.8rem',
                padding: '0.5rem 1rem',
                borderColor: batchMode ? 'var(--accent-cyan)' : undefined,
                color: batchMode ? 'var(--accent-cyan)' : undefined,
              }}
              onClick={toggleBatchMode}
            >
              {batchMode ? '✕ 退出批量' : '☐ 批量操作'}
            </button>
          )}
          {!batchMode && (
            <>
              <button className="btn" onClick={handleOpenCreate}>
                <span style={{ marginRight: '6px', fontSize: '1.1rem' }}>+</span>
                新建项目
              </button>
              <button
                className="btn-primary"
                style={{ fontSize: '0.8rem', padding: '0.5rem 1rem' }}
                onClick={handleGuidedCreate}
                disabled={formLoading}
              >
                ✨ AI 引导创建
              </button>
            </>
          )}
        </div>
      </header>

      {/* 批量操作工具栏 — 仅在批量模式时显示 */}
      {batchMode && (
        <div
          className="flex items-center justify-between shrink-0 animate-slide-top"
          style={{
            padding: '0.5rem 2rem',
            background: 'rgba(6, 182, 212, 0.04)',
            borderBottom: '1px solid var(--border-dim)',
          }}
        >
          <div className="flex items-center gap-3">
            {/* 全选/取消全选 checkbox */}
            <label
              className="flex items-center gap-2"
              style={{ cursor: 'pointer', userSelect: 'none' }}
            >
              <div
                style={{
                  width: '1.1rem',
                  height: '1.1rem',
                  borderRadius: '3px',
                  border: `2px solid ${isAllChecked ? 'var(--accent-cyan)' : 'var(--border-hover)'}`,
                  background: isAllChecked ? 'var(--accent-cyan)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  flexShrink: 0,
                }}
                onClick={handleToggleAll}
              >
                {isAllChecked && (
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span
                className="text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
                onClick={handleToggleAll}
              >
                {isAllChecked ? '取消全选' : '全选'}
              </span>
            </label>

            {/* 已选中计数 */}
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
              已选中 <strong style={{ color: checkedIds.size > 0 ? 'var(--status-err)' : 'var(--text-muted)' }}>{checkedIds.size}</strong> / {projects.length}
            </span>
          </div>

          {/* 批量删除按钮 */}
          <button
            className="btn-danger"
            style={{ fontSize: '0.78rem', padding: '0.4rem 1rem' }}
            disabled={checkedIds.size === 0 || formLoading}
            onClick={() => setShowBatchDeleteConfirm(true)}
          >
            🗑 删除选中 ({checkedIds.size})
          </button>
        </div>
      )}

      {/* Project Grid */}
      <div className="project-management-content flex-1 p-5" style={{ overflowY: 'auto' }}>
        {projects.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full animate-fade-in"
            style={{ opacity: 0.6 }}
          >
            <div
              className="flex items-center justify-center animate-pulse-glow"
              style={{
                width: '5rem',
                height: '5rem',
                borderRadius: '1.25rem',
                background: 'var(--bg-card)',
                color: 'var(--accent-cyan)',
                border: '1px solid var(--border-light)',
                marginBottom: '1.5rem',
                cursor: 'pointer',
              }}
              onClick={handleOpenCreate}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v12m6-6H6" />
              </svg>
            </div>
            <p className="text-base font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
              还没有任何项目
            </p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-dim)' }}>
              创建你的第一个小说项目，开始 AI 辅写之旅
            </p>
            <button className="btn" onClick={handleOpenCreate}>
              创建第一个项目
            </button>
            <button
              className="btn-primary"
              style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}
              onClick={handleGuidedCreate}
              disabled={formLoading}
            >
              ✨ AI 引导创建
            </button>
          </div>
        ) : (
          <div
            className="project-grid animate-fade-in"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: '1rem',
              maxWidth: '72rem',
              margin: '0 auto',
            }}
          >
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                isSelected={project.id === selectedProjectId}
                batchMode={batchMode}
                isChecked={checkedIds.has(project.id)}
                onSelect={onSelectProject}
                onEdit={handleOpenEdit}
                onDelete={setDeletingProject}
                onToggleCheck={handleToggleCheck}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      <ProjectFormModal
        isOpen={showForm}
        editingProject={editingProject}
        loading={formLoading}
        error={formError}
        onSubmit={handleFormSubmit}
        onClose={() => setShowForm(false)}
      />

      {/* Delete Confirmation Modal — 单个删除 */}
      {deletingProject && (
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
          onClick={() => setDeletingProject(null)}
        >
          <div
            className="panel p-5 animate-slide-top"
            style={{
              width: '100%',
              maxWidth: '24rem',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-light)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold mb-2" style={{ color: 'var(--status-err)' }}>
              确认删除项目
            </h2>
            <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
              即将删除项目 <strong style={{ color: 'var(--text-main)' }}>{deletingProject.title}</strong>
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
              此操作将级联删除所有相关数据（章节、角色、记忆、事件等），且无法恢复。
            </p>

            {formError && (
              <div className="mb-3 text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
                {formError}
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setDeletingProject(null)} disabled={formLoading}>
                取消
              </button>
              <button className="btn-danger" onClick={handleConfirmDelete} disabled={formLoading}>
                {formLoading ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Delete Confirmation Modal — 批量删除确认 */}
      {showBatchDeleteConfirm && (
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
          onClick={() => setShowBatchDeleteConfirm(false)}
        >
          <div
            className="panel p-5 animate-slide-top"
            style={{
              width: '100%',
              maxWidth: '26rem',
              background: 'var(--bg-card)',
              border: '1px solid rgba(244, 63, 94, 0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold mb-2" style={{ color: 'var(--status-err)' }}>
              ⚠️ 批量删除确认
            </h2>
            <p className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
              即将删除以下 <strong style={{ color: 'var(--status-err)' }}>{checkedIds.size}</strong> 个项目：
            </p>

            {/* 待删除项目列表预览 */}
            <div
              style={{
                maxHeight: '10rem',
                overflowY: 'auto',
                background: 'var(--bg-overlay)',
                borderRadius: 'var(--radius-sm)',
                padding: '0.5rem 0.75rem',
                marginBottom: '0.75rem',
                border: '1px solid var(--border-dim)',
              }}
            >
              {projects
                .filter((p) => checkedIds.has(p.id))
                .map((p) => (
                  <div
                    key={p.id}
                    className="text-xs"
                    style={{
                      padding: '0.25rem 0',
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border-dim)',
                    }}
                  >
                    • {p.title}
                  </div>
                ))}
            </div>

            <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
              此操作将级联删除所有相关数据（章节、角色、记忆、事件等），且<strong style={{ color: 'var(--status-err)' }}>无法恢复</strong>。
            </p>

            {formError && (
              <div className="mb-3 text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
                {formError}
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setShowBatchDeleteConfirm(false)} disabled={formLoading}>
                取消
              </button>
              <button className="btn-danger" onClick={handleConfirmBatchDelete} disabled={formLoading}>
                {formLoading ? `删除中… (${checkedIds.size})` : `确认删除 ${checkedIds.size} 个项目`}
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
