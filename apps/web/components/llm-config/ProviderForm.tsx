/**
 * ProviderForm — Create/edit form for LLM providers.
 * Renders inline above the provider list when active.
 */
'use client';

import React, { useState } from 'react';
import { LlmProvider, CreateLlmProviderInput } from '../../types/llm-provider';

interface Props {
  provider: LlmProvider | null; // null = create mode
  onSubmit: (input: CreateLlmProviderInput) => Promise<void>;
  onCancel: () => void;
}

export function ProviderForm({ provider, onSubmit, onCancel }: Props) {
  const isEditing = provider !== null;

  // Form state — prefilled when editing
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(''); // Never prefill masked key
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? '');
  const [isDefault, setIsDefault] = useState(provider?.isDefault ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  /** Validate and submit */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!name.trim()) { setFormError('名称不能为空'); return; }
    if (!baseUrl.trim()) { setFormError('Base URL 不能为空'); return; }
    // API key required only for new providers
    if (!isEditing && !apiKey.trim()) { setFormError('API Key 不能为空'); return; }
    if (!defaultModel.trim()) { setFormError('默认模型不能为空'); return; }

    setSubmitting(true);
    try {
      const input: CreateLlmProviderInput = {
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ''),
        apiKey: apiKey.trim() || undefined as unknown as string, // undefined = don't update key
        defaultModel: defaultModel.trim(),
        isDefault,
      };

      // When editing and key is empty, don't send apiKey (keep existing)
      if (isEditing && !apiKey.trim()) {
        // TypeScript 5.5 会阻止结构类型直接转 Record；先转 unknown 保持删除可选字段的意图明确。
        delete (input as unknown as Record<string, unknown>).apiKey;
      }

      await onSubmit(input);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        padding: '1.25rem',
        borderRadius: '0.75rem',
        background: 'var(--bg-card)',
        border: '1px solid var(--accent-cyan)',
        marginBottom: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      <h3 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--accent-cyan)', margin: 0 }}>
        {isEditing ? `✏️ 编辑 Provider「${provider.name}」` : '✨ 新建 Provider'}
      </h3>

      {formError && (
        <div style={{ fontSize: '0.75rem', color: '#ef4444' }}>❌ {formError}</div>
      )}

      {/* Name */}
      <FormField label="名称" required>
        <input
          className="input-field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：GPT-5.4 主力"
          maxLength={100}
        />
      </FormField>

      {/* Base URL */}
      <FormField label="Base URL" required>
        <input
          className="input-field"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="如：http://38.14.198.12:8318/v1"
          maxLength={500}
        />
      </FormField>

      {/* API Key */}
      <FormField label={isEditing ? 'API Key（留空保持不变）' : 'API Key'} required={!isEditing}>
        <input
          className="input-field"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={isEditing ? '••••••••' : '输入 API Key'}
        />
      </FormField>

      {/* Default Model */}
      <FormField label="默认模型" required>
        <input
          className="input-field"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="如：gpt-5.4-mini"
          maxLength={200}
        />
      </FormField>

      {/* Default toggle */}
      <label className="flex items-center gap-2" style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          style={{ accentColor: 'var(--accent-cyan)' }}
        />
        设为默认 Provider（未配置路由的步骤将使用此 Provider）
      </label>

      {/* Action buttons */}
      <div className="flex items-center gap-2" style={{ marginTop: '0.25rem' }}>
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: '0.45rem 1.2rem',
            borderRadius: '0.5rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: submitting ? 'not-allowed' : 'pointer',
            border: 'none',
            background: 'linear-gradient(135deg, rgba(6,182,212,0.9), rgba(139,92,246,0.8))',
            color: '#fff',
            opacity: submitting ? 0.6 : 1,
            transition: 'all 0.2s ease',
          }}
        >
          {submitting ? '⏳ 保存中…' : isEditing ? '✅ 更新' : '✅ 创建'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '0.45rem 1rem',
            borderRadius: '0.5rem',
            fontSize: '0.8rem',
            cursor: 'pointer',
            border: '1px solid var(--border-light)',
            background: 'transparent',
            color: 'var(--text-muted)',
          }}
        >
          取消
        </button>
      </div>
    </form>
  );
}

/** Labeled form field wrapper */
function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
        {label}
        {required && <span style={{ color: '#ef4444', marginLeft: '0.2rem' }}>*</span>}
      </label>
      {children}
    </div>
  );
}
