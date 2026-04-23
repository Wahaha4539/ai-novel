import React, { useState, useMemo } from 'react';
import { ProjectSummary, PromptTemplate } from '../types/dashboard';
import { usePromptTemplates, PromptFormData } from '../hooks/usePromptTemplates';
import { GUIDED_STEPS } from '../hooks/useGuidedSession';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
}

/** All possible step keys for prompt templates */
const STEP_OPTIONS = [
  { value: '', label: '全部步骤' },
  ...GUIDED_STEPS.map((s) => ({ value: s.key, label: `${s.icon} ${s.label}` })),
  { value: 'generate_outline', label: '📐 大纲生成' },
  { value: 'write_chapter', label: '📖 章节写作' },
  { value: 'polish_chapter', label: '✨ 章节润色' },
  { value: 'writing_style', label: '🎨 写作风格' },
  { value: 'summarize', label: '📋 章节总结' },
  { value: 'extract_facts', label: '🔍 事实提取' },
];

export function PromptManagerPanel({ selectedProject, selectedProjectId }: Props) {
  const {
    templates,
    loading,
    error,
    setError,
    createTemplate,
    updateTemplate,
    setDefault,
    deleteTemplate,
  } = usePromptTemplates(selectedProjectId);

  const [filterStep, setFilterStep] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!filterStep) return templates;
    return templates.filter((t) => t.stepKey === filterStep);
  }, [templates, filterStep]);

  // Group by stepKey
  const grouped = useMemo(() => {
    const map = new Map<string, PromptTemplate[]>();
    for (const t of filtered) {
      const group = map.get(t.stepKey) ?? [];
      group.push(t);
      map.set(t.stepKey, group);
    }
    return map;
  }, [filtered]);

  const handleCreate = async (data: PromptFormData) => {
    const ok = await createTemplate(data);
    if (ok) setShowCreateForm(false);
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
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b', boxShadow: '0 0 10px rgba(245,158,11,0.5)' }} />
          <h1 className="text-lg font-bold text-heading" style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}>
            提示词管理
          </h1>
          <span className="badge" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: 'none' }}>Prompts</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>{selectedProject?.title ?? '未选择项目'}</div>
          {selectedProjectId && (
            <button
              className="btn-primary"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.85rem' }}
              onClick={() => { setShowCreateForm(true); setError(''); }}
            >
              + 新建模板
            </button>
          )}
        </div>
      </header>

      {/* Filter bar */}
      <div
        className="flex items-center gap-3 shrink-0"
        style={{ padding: '0.75rem 2rem', borderBottom: '1px solid var(--border-dim)', background: 'var(--bg-card)' }}
      >
        <span className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>按步骤筛选：</span>
        <div className="flex gap-1 flex-wrap">
          {STEP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilterStep(opt.value)}
              style={{
                fontSize: '0.7rem',
                padding: '0.25rem 0.6rem',
                borderRadius: '0.4rem',
                border: filterStep === opt.value ? '1px solid #f59e0b' : '1px solid var(--border-dim)',
                background: filterStep === opt.value ? 'rgba(245,158,11,0.12)' : 'transparent',
                color: filterStep === opt.value ? '#f59e0b' : 'var(--text-muted)',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-8 py-6" style={{ overflowY: 'auto' }}>
        {error && (
          <div className="mb-4 text-xs" style={{ color: 'var(--status-err)', padding: '0.5rem', background: 'var(--status-err-bg)', borderRadius: '8px' }}>
            {error}
          </div>
        )}

        {showCreateForm && (
          <PromptCreateForm
            projectId={selectedProjectId}
            onSubmit={handleCreate}
            onCancel={() => setShowCreateForm(false)}
          />
        )}

        {!selectedProjectId ? (
          <EmptyState message="请先选择一个项目" />
        ) : loading && templates.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm" style={{ color: 'var(--text-dim)' }}>加载中…</div>
        ) : templates.length === 0 && !showCreateForm ? (
          <EmptyState message="尚无提示词模板。点击「新建模板」开始创建。" />
        ) : (
          <div className="space-y-6">
            {[...grouped.entries()].map(([stepKey, items]) => {
              const stepInfo = STEP_OPTIONS.find((s) => s.value === stepKey);
              return (
                <div key={stepKey}>
                  <h3 className="text-sm font-bold mb-3" style={{ color: 'var(--text-muted)' }}>
                    {stepInfo?.label ?? stepKey}
                    <span className="ml-2 text-xs" style={{ color: 'var(--text-dim)' }}>({items.length})</span>
                  </h3>
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(20rem, 1fr))' }}>
                    {items.map((t) => (
                      <PromptCard
                        key={t.id}
                        template={t}
                        isEditing={editingId === t.id}
                        onEdit={() => setEditingId(t.id)}
                        onCancelEdit={() => setEditingId(null)}
                        onUpdate={(data) => updateTemplate(t.id, data)}
                        onSetDefault={() => setDefault(t.id)}
                        onDelete={() => deleteTemplate(t.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}

/* ─── Sub-components ─── */

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full animate-fade-in" style={{ opacity: 0.7 }}>
      <div className="flex items-center justify-center animate-pulse-glow" style={{ width: '5rem', height: '5rem', borderRadius: '1.25rem', background: 'var(--bg-card)', border: '1px solid var(--border-light)', color: '#f59e0b', marginBottom: '1.5rem' }}>
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <p className="text-sm text-center" style={{ color: 'var(--text-dim)', maxWidth: '24rem', lineHeight: 1.6 }}>{message}</p>
    </div>
  );
}

function PromptCreateForm({
  projectId,
  onSubmit,
  onCancel,
}: {
  projectId: string;
  onSubmit: (data: PromptFormData) => void;
  onCancel: () => void;
}) {
  const [stepKey, setStepKey] = useState('guided_setup');
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userTemplate, setUserTemplate] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="panel p-5 mb-6 animate-fade-in" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)' }}>
      <h3 className="text-sm font-bold mb-4" style={{ color: '#f59e0b' }}>新建提示词模板</h3>
      <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>适用步骤</label>
          <select className="input-field" value={stepKey} onChange={(e) => setStepKey(e.target.value)}>
            {STEP_OPTIONS.filter((s) => s.value).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>模板名称</label>
          <input className="input-field" placeholder="如：创意发散模式" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>描述 (可选)</label>
          <input className="input-field" placeholder="简述这个模板的效果…" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>System Prompt</label>
          <textarea className="input-field" rows={4} placeholder="你是一个资深小说创作顾问…" value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>User Template</label>
          <textarea className="input-field" rows={4} placeholder={'请根据以下项目设定生成…\n\n【项目信息】\n{{projectContext}}\n\n【用户要求】\n{{userHint}}'} value={userTemplate} onChange={(e) => setUserTemplate(e.target.value)} />
        </div>
        <div style={{ gridColumn: '1 / -1', padding: '0.6rem 0.8rem', background: 'rgba(14,165,233,0.06)', borderRadius: '0.5rem', border: '1px solid rgba(14,165,233,0.15)' }}>
          <p className="text-xs font-medium mb-1" style={{ color: '#0ea5e9' }}>可用模板变量 {'（使用 {{变量名}} 语法）'}</p>
          <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 1fr', fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            <span><code style={{ color: '#f59e0b' }}>{'{{projectContext}}'}</code> — 项目累积设定</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{chatSummary}}'}</code> — 对话决策摘要</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{userHint}}'}</code> — 用户自由输入偏好</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{userMessage}}'}</code> — 用户当前消息</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{stepLabel}}'}</code> — 当前步骤名称</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{stepInstruction}}'}</code> — 步骤生成指令</span>
            <span><code style={{ color: '#f59e0b' }}>{'{{jsonSchema}}'}</code> — JSON 输出 schema</span>
          </div>
        </div>
      </div>
      <div className="flex gap-3 justify-end mt-4">
        <button className="btn-secondary" onClick={onCancel}>取消</button>
        <button
          className="btn-primary"
          disabled={!name || !systemPrompt || !userTemplate}
          onClick={() => onSubmit({ projectId, stepKey, name, systemPrompt, userTemplate, description: description || undefined })}
        >
          创建
        </button>
      </div>
    </div>
  );
}

function PromptCard({
  template,
  isEditing,
  onEdit,
  onCancelEdit,
  onUpdate,
  onSetDefault,
  onDelete,
}: {
  template: PromptTemplate;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onUpdate: (data: Partial<PromptFormData>) => Promise<boolean>;
  onSetDefault: () => void;
  onDelete: () => void;
}) {
  const [systemPrompt, setSystemPrompt] = useState(template.systemPrompt);
  const [userTemplate, setUserTemplate] = useState(template.userTemplate);

  const isGlobal = !template.projectId;
  const scopeLabel = isGlobal ? '全局' : '项目';
  const scopeColor = isGlobal ? '#6366f1' : '#0ea5e9';

  return (
    <div
      className="panel p-4 animate-fade-in"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${isEditing ? '#f59e0b' : template.isDefault ? '#10b98140' : 'var(--border-light)'}`,
        transition: 'border-color 0.3s ease',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>{template.name}</span>
          {template.isDefault && (
            <span className="badge" style={{ background: 'rgba(16,185,129,0.12)', color: '#10b981', border: 'none', fontSize: '0.6rem' }}>默认</span>
          )}
          <span className="badge" style={{ background: `${scopeColor}15`, color: scopeColor, border: 'none', fontSize: '0.6rem' }}>{scopeLabel}</span>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>v{template.version}</span>
      </div>

      {template.description && (
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{template.description}</p>
      )}

      {isEditing ? (
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>System Prompt</label>
            <textarea className="input-field" rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block" style={{ color: 'var(--text-dim)' }}>User Template</label>
            <textarea className="input-field" rows={3} value={userTemplate} onChange={(e) => setUserTemplate(e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end">
            <button className="btn-secondary" onClick={onCancelEdit} style={{ fontSize: '0.7rem' }}>取消</button>
            <button className="btn-primary" onClick={() => onUpdate({ systemPrompt, userTemplate })} style={{ fontSize: '0.7rem' }}>保存</button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-xs mb-2" style={{ color: 'var(--text-dim)' }}>
            <span style={{ fontWeight: 600 }}>System:</span>{' '}
            <span style={{ color: 'var(--text-muted)' }}>{template.systemPrompt.slice(0, 80)}{template.systemPrompt.length > 80 ? '…' : ''}</span>
          </div>
          <div className="flex gap-2 mt-3 pt-2" style={{ borderTop: '1px solid var(--border-dim)' }}>
            <button className="btn-secondary" onClick={onEdit} style={{ fontSize: '0.65rem' }}>编辑</button>
            {!template.isDefault && (
              <button className="btn-secondary" onClick={onSetDefault} style={{ fontSize: '0.65rem', color: '#10b981' }}>设为默认</button>
            )}
            <button className="btn-secondary" onClick={onDelete} style={{ fontSize: '0.65rem', color: 'var(--status-err)' }}>删除</button>
          </div>
        </>
      )}
    </div>
  );
}
