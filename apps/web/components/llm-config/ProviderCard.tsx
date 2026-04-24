/**
 * ProviderCard — Displays a single LLM Provider in card format.
 * Shows name, baseUrl, model, status badges, and action buttons.
 */
'use client';

import React, { useState } from 'react';
import { LlmProvider, ConnectivityResult } from '../../types/llm-provider';

interface Props {
  provider: LlmProvider;
  onEdit: (p: LlmProvider) => void;
  onDelete: (id: string) => void;
  onTest: (id: string) => void;
  onSetDefault: (id: string) => void;
  isTesting: boolean;
  testResult: ConnectivityResult | null;
}

export function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onTest,
  onSetDefault,
  isTesting,
  testResult,
}: Props) {
  // 用卡片内联确认替代 window.confirm，避免浏览器原生弹窗破坏配置页交互节奏。
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  /** Show inline delete confirmation before removing a provider. */
  const handleDelete = () => setIsConfirmingDelete(true);

  return (
    <div
      style={{
        padding: '1rem 1.25rem',
        borderRadius: '0.75rem',
        background: 'var(--bg-card)',
        border: `1px solid ${provider.isDefault ? 'var(--accent-cyan)' : 'var(--border-light)'}`,
        transition: 'all 0.2s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Default badge glow strip */}
      {provider.isDefault && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '2px',
            background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))',
          }}
        />
      )}

      {/* Row 1: Name + badges */}
      <div className="flex items-center gap-2" style={{ marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-main)' }}>
          {provider.name}
        </span>

        {/* Default badge */}
        {provider.isDefault && (
          <span
            style={{
              padding: '0.1rem 0.4rem',
              borderRadius: '0.25rem',
              fontSize: '0.65rem',
              fontWeight: 600,
              background: 'rgba(6,182,212,0.15)',
              color: 'var(--accent-cyan)',
              border: '1px solid rgba(6,182,212,0.3)',
            }}
          >
            默认
          </span>
        )}

        {/* Active/inactive badge */}
        {!provider.isActive && (
          <span
            style={{
              padding: '0.1rem 0.4rem',
              borderRadius: '0.25rem',
              fontSize: '0.65rem',
              background: 'rgba(239,68,68,0.1)',
              color: '#ef4444',
            }}
          >
            已停用
          </span>
        )}

        {/* Routed steps */}
        {provider.routedSteps.length > 0 && (
          <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>
            已绑定：{provider.routedSteps.join(' / ')}
          </span>
        )}
      </div>

      {/* Row 2: Connection details */}
      <div
        className="flex items-center gap-4"
        style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.6rem' }}
      >
        <span title={provider.baseUrl}>
          🌐 {provider.baseUrl.length > 40 ? provider.baseUrl.slice(0, 40) + '…' : provider.baseUrl}
        </span>
        <span>🤖 {provider.defaultModel}</span>
        <span>🔑 {provider.apiKey}</span>
      </div>

      {/* Row 3: Action buttons */}
      <div className="flex items-center gap-2">
        {/* Test button */}
        <ActionButton
          label={isTesting ? '⏳ 测试中…' : '🔌 测试连通'}
          disabled={isTesting}
          onClick={() => onTest(provider.id)}
          variant="default"
        />

        {/* Set default button (only if not already default) */}
        {!provider.isDefault && (
          <ActionButton
            label="⭐ 设为默认"
            onClick={() => onSetDefault(provider.id)}
            variant="default"
          />
        )}

        {/* Edit button */}
        <ActionButton label="✏️ 编辑" onClick={() => onEdit(provider)} variant="default" />

        {/* Delete button */}
        <ActionButton label="🗑️ 删除" onClick={handleDelete} variant="danger" />

        {/* Test result inline display */}
        {testResult && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.7rem',
              color: testResult.success ? '#10b981' : '#ef4444',
            }}
          >
            {testResult.success
              ? `✅ 连通成功 (${testResult.models?.length ?? 0} 模型)`
              : `❌ ${testResult.error}`}
          </span>
        )}
      </div>

      {isConfirmingDelete && (
        <div
          className="animate-fade-in"
          style={{
            marginTop: '0.85rem',
            padding: '0.75rem',
            borderRadius: '0.65rem',
            border: '1px solid rgba(239,68,68,0.28)',
            background: 'rgba(239,68,68,0.07)',
          }}
        >
          <p style={{ fontSize: '0.76rem', lineHeight: 1.7, color: 'var(--text-muted)', marginBottom: '0.6rem' }}>
            确认删除 Provider「{provider.name}」？
            {provider.routedSteps.length > 0 && (
              <>
                <br />
                将同时移除以下步骤的路由配置：{provider.routedSteps.join('、')}
              </>
            )}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.45rem' }}>
            <ActionButton label="取消" onClick={() => setIsConfirmingDelete(false)} variant="default" />
            <ActionButton label="确认删除" onClick={() => onDelete(provider.id)} variant="danger" />
          </div>
        </div>
      )}
    </div>
  );
}

/** Small action button with consistent styling */
function ActionButton({
  label,
  onClick,
  variant = 'default',
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}) {
  const isDanger = variant === 'danger';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '0.2rem 0.5rem',
        borderRadius: '0.3rem',
        fontSize: '0.7rem',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${isDanger ? 'rgba(239,68,68,0.3)' : 'var(--border-light)'}`,
        background: isDanger ? 'rgba(239,68,68,0.06)' : 'transparent',
        color: isDanger ? '#ef4444' : 'var(--text-muted)',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </button>
  );
}
