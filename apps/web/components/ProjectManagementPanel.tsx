import React, { useState } from 'react';
import { ProjectSummary } from '../types/dashboard';
import { ProjectCard } from './ProjectCard';
import { ProjectFormModal } from './ProjectFormModal';
import { useProjectActions, ProjectFormData } from '../hooks/useProjectActions';

interface Props {
  projects: ProjectSummary[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onProjectsChanged: () => Promise<void>;
}

export function ProjectManagementPanel({
  projects,
  selectedProjectId,
  onSelectProject,
  onProjectsChanged,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(null);

  const { formLoading, formError, setFormError, createProject, updateProject, deleteProject } =
    useProjectActions(onProjectsChanged);

  const handleOpenCreate = () => {
    setEditingProject(null);
    setFormError('');
    setShowForm(true);
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
        <button className="btn" onClick={handleOpenCreate}>
          <span style={{ marginRight: '6px', fontSize: '1.1rem' }}>+</span>
          新建项目
        </button>
      </header>

      {/* Project Grid */}
      <div className="flex-1 p-5" style={{ overflowY: 'auto' }}>
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
          </div>
        ) : (
          <div
            className="animate-fade-in"
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
                onSelect={onSelectProject}
                onEdit={handleOpenEdit}
                onDelete={setDeletingProject}
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

      {/* Delete Confirmation Modal */}
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
    </article>
  );
}
