/**
 * RoutingSection — Maps the 3 fixed app steps to LLM providers.
 *
 * Each step (guided/generate/polish) shows a dropdown to select
 * a provider. Unset steps display a fallback warning.
 */
'use client';

import React from 'react';
import { LlmProvider, LlmRoutingEntry, SetRoutingInput } from '../../types/llm-provider';

/** Human-readable labels and descriptions for each app step */
const STEP_META: Record<string, { label: string; emoji: string; desc: string }> = {
  guided: { label: '创作引导', emoji: '📝', desc: 'AI 向导：世界观、角色、大纲等引导对话' },
  generate: { label: '章节生成', emoji: '✍️', desc: '章节正文的 AI 生成' },
  polish: { label: '章节润色', emoji: '✨', desc: '已生成章节的深度润色' },
};

interface Props {
  routings: LlmRoutingEntry[];
  providers: LlmProvider[];
  onSetRouting: (appStep: string, input: SetRoutingInput) => Promise<void>;
  onDeleteRouting: (appStep: string) => Promise<void>;
}

export function RoutingSection({ routings, providers, onSetRouting, onDeleteRouting }: Props) {
  /** Active providers available for selection */
  const activeProviders = providers.filter((p) => p.isActive);

  /** Handle dropdown change for a step */
  const handleChange = async (appStep: string, providerId: string) => {
    if (providerId === '__none__') {
      await onDeleteRouting(appStep);
    } else {
      await onSetRouting(appStep, { providerId });
    }
  };

  return (
    <section>
      <h2
        style={{
          fontSize: '0.9rem',
          fontWeight: 700,
          color: 'var(--text-main)',
          marginBottom: '0.8rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}
      >
        🔀 步骤路由配置
      </h2>

      <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '1rem' }}>
        为每个应用步骤指定 Provider。未配置的步骤将使用默认 Provider，无默认则回退到环境变量。
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {routings.map(({ appStep, routing }) => {
          const meta = STEP_META[appStep] ?? { label: appStep, emoji: '⚙️', desc: '' };
          const currentProviderId = routing?.provider?.id ?? '__none__';
          // Find the default provider for fallback display
          const defaultProvider = providers.find((p) => p.isDefault && p.isActive);

          return (
            <div
              key={appStep}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                padding: '0.75rem 1rem',
                borderRadius: '0.5rem',
                background: 'var(--bg-card)',
                border: `1px solid ${routing ? 'var(--border-light)' : 'rgba(234,179,8,0.3)'}`,
              }}
            >
              {/* Step label */}
              <div style={{ minWidth: '7.5rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main)' }}>
                  {meta.emoji} {meta.label}
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                  {meta.desc}
                </div>
              </div>

              {/* Arrow */}
              <span style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>→</span>

              {/* Provider dropdown */}
              <select
                className="input-field"
                value={currentProviderId}
                onChange={(e) => handleChange(appStep, e.target.value)}
                style={{
                  flex: 1,
                  maxWidth: '20rem',
                  padding: '0.35rem 0.6rem',
                  fontSize: '0.8rem',
                }}
              >
                <option value="__none__">
                  {defaultProvider
                    ? `🔸 使用默认 (${defaultProvider.name})`
                    : '⚠️ 未配置（回退到环境变量）'}
                </option>
                {activeProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.defaultModel}
                  </option>
                ))}
              </select>

              {/* Current model display */}
              {routing && (
                <span
                  style={{
                    fontSize: '0.7rem',
                    color: 'var(--text-dim)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  模型: {routing.modelOverride ?? routing.provider?.defaultModel ?? '—'}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
