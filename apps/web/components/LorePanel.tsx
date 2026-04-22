import React, { useState, useEffect } from 'react';
import { ProjectSummary, CharacterCard } from '../types/dashboard';
import { useCharacterActions, CharacterFormData } from '../hooks/useCharacterActions';
import { CharacterCardList } from './CharacterCardList';
import { CharacterFormModal } from './CharacterFormModal';
import { WorldviewEditor } from './WorldviewEditor';

type LoreTab = 'characters' | 'worldview';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

export function LorePanel({ selectedProject, selectedProjectId }: Props) {
  const [activeTab, setActiveTab] = useState<LoreTab>('characters');
  const [showForm, setShowForm] = useState(false);
  const [editingCharacter, setEditingCharacter] = useState<CharacterCard | null>(null);
  const [deletingCharacter, setDeletingCharacter] = useState<CharacterCard | null>(null);

  const {
    characters,
    loading,
    formLoading,
    formError,
    setFormError,
    loadCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
  } = useCharacterActions(selectedProjectId);

  // Load characters when project changes
  useEffect(() => {
    if (selectedProjectId) {
      loadCharacters();
    }
  }, [selectedProjectId, loadCharacters]);

  const handleOpenCreate = () => {
    setEditingCharacter(null);
    setFormError('');
    setShowForm(true);
  };

  const handleOpenEdit = (character: CharacterCard) => {
    setEditingCharacter(character);
    setFormError('');
    setShowForm(true);
  };

  const handleFormSubmit = async (data: CharacterFormData) => {
    if (editingCharacter) {
      const ok = await updateCharacter(editingCharacter.id, data);
      if (ok) setShowForm(false);
    } else {
      const ok = await createCharacter(data);
      if (ok) setShowForm(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingCharacter) return;
    const ok = await deleteCharacter(deletingCharacter.id);
    if (ok) setDeletingCharacter(null);
  };

  const TABS: { key: LoreTab; label: string; color: string }[] = [
    { key: 'characters', label: '角色卡', color: '#8b5cf6' },
    { key: 'worldview', label: '世界观', color: '#10b981' },
  ];

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
              background: '#8b5cf6',
              boxShadow: '0 0 10px rgba(139,92,246,0.5)',
            }}
          />
          <h1
            className="text-lg font-bold text-heading"
            style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
          >
            角色与设定
          </h1>
          <span
            className="badge"
            style={{
              background: 'rgba(139,92,246,0.12)',
              color: '#8b5cf6',
              border: 'none',
            }}
          >
            Lore
          </span>
        </div>
        <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
          {selectedProject?.title ?? '未选择项目'}
        </div>
      </header>

      {/* Tab bar */}
      <div
        className="flex shrink-0"
        style={{
          borderBottom: '1px solid var(--border-dim)',
          padding: '0 2rem',
          background: 'var(--bg-card)',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '0.65rem 1.25rem',
              fontSize: '0.8rem',
              fontWeight: activeTab === tab.key ? 700 : 500,
              color: activeTab === tab.key ? tab.color : 'var(--text-dim)',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.key ? `2px solid ${tab.color}` : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              marginBottom: '-1px',
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.key) e.currentTarget.style.color = 'var(--text-muted)';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.key) e.currentTarget.style.color = 'var(--text-dim)';
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1" style={{ overflowY: 'auto', padding: activeTab === 'worldview' ? 0 : '1.5rem 2rem' }}>
        {activeTab === 'characters' ? (
          <CharacterCardList
            characters={characters}
            loading={loading}
            onAdd={handleOpenCreate}
            onEdit={handleOpenEdit}
            onDelete={setDeletingCharacter}
          />
        ) : selectedProject ? (
          <WorldviewEditor project={selectedProject} />
        ) : (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-dim)' }}>
            请先选择一个项目
          </div>
        )}
      </div>

      {/* Character Form Modal */}
      <CharacterFormModal
        isOpen={showForm}
        editingCharacter={editingCharacter}
        loading={formLoading}
        error={formError}
        onSubmit={handleFormSubmit}
        onClose={() => setShowForm(false)}
      />

      {/* Delete Confirmation Modal */}
      {deletingCharacter && (
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
          onClick={() => setDeletingCharacter(null)}
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
              确认删除角色
            </h2>
            <p className="text-sm mb-1" style={{ color: 'var(--text-muted)' }}>
              即将删除角色 <strong style={{ color: 'var(--text-main)' }}>{deletingCharacter.name}</strong>
            </p>
            <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
              删除后涉及该角色的状态快照等数据不会自动清理，请谨慎操作。
            </p>
            {formError && (
              <div className="mb-3 text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
                {formError}
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button className="btn-secondary" onClick={() => setDeletingCharacter(null)} disabled={formLoading}>
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
