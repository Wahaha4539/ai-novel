/**
 * LlmProviderPanel — Management UI for LLM Providers and step routing.
 *
 * Two sections:
 *   1. Provider Management — CRUD + connectivity test
 *   2. Step Routing — Map guided/generate/polish to providers
 */
'use client';

import React, { useState, useCallback } from 'react';
import { useLlmProviders } from '../hooks/useLlmProviders';
import { LlmProvider, CreateLlmProviderInput } from '../types/llm-provider';
import { ProviderCard } from './llm-config/ProviderCard';
import { ProviderForm } from './llm-config/ProviderForm';
import { RoutingSection } from './llm-config/RoutingSection';

export function LlmProviderPanel() {
  const llm = useLlmProviders();
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<LlmProvider | null>(null);

  /** Open create mode for a new provider */
  const handleCreate = useCallback(() => {
    setEditingProvider(null);
    setShowForm(true);
  }, []);

  /** Handle create or update submission */
  const handleSubmit = useCallback(async (input: CreateLlmProviderInput) => {
    if (editingProvider) {
      await llm.updateProvider(editingProvider.id, input);
    } else {
      await llm.createProvider(input);
    }
    setShowForm(false);
    setEditingProvider(null);
  }, [editingProvider, llm]);

  /** Open edit mode for an existing provider */
  const handleEdit = useCallback((provider: LlmProvider) => {
    setEditingProvider(provider);
    setShowForm(true);
  }, []);

  /** Close form and reset editing state */
  const handleCloseForm = useCallback(() => {
    setShowForm(false);
    setEditingProvider(null);
  }, []);

  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      {/* ── Header ── */}
      <header
        className="shrink-0 flex items-center justify-between"
        style={{
          height: '3.5rem',
          padding: '0 2rem',
          background: 'var(--bg-editor-header)',
          borderBottom: '1px solid var(--border-light)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <h1
          className="text-lg font-bold text-heading"
          style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
        >
          🔧 LLM 配置
        </h1>
        <button
          onClick={handleCreate}
          style={{
            padding: '0.4rem 1rem',
            borderRadius: '0.5rem',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            border: '1px solid var(--accent-cyan)',
            background: 'rgba(6,182,212,0.1)',
            color: 'var(--accent-cyan)',
            transition: 'all 0.2s ease',
          }}
        >
          + 新建 Provider
        </button>
      </header>

      {/* ── Scrollable content ── */}
      <div className="flex-1" style={{ overflowY: 'auto', padding: '1.5rem 2rem' }}>
        {/* Error message */}
        {llm.error && (
          <div
            style={{
              padding: '0.6rem 1rem',
              borderRadius: '0.5rem',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              color: '#ef4444',
              fontSize: '0.8rem',
              marginBottom: '1rem',
            }}
          >
            ❌ {llm.error}
          </div>
        )}

        {/* ── Provider Form (inline overlay) ── */}
        {showForm && (
          <ProviderForm
            provider={editingProvider}
            onSubmit={handleSubmit}
            onCancel={handleCloseForm}
          />
        )}

        {/* ── Section 1: Provider List ── */}
        <section style={{ marginBottom: '2rem' }}>
          <div
            style={{
              marginBottom: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <h2
              style={{
                fontSize: '0.9rem',
                fontWeight: 700,
                color: 'var(--text-main)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              📡 Provider 列表
              {llm.loading && (
                <span className="animate-pulse" style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                  加载中…
                </span>
              )}
            </h2>
            <button
              onClick={handleCreate}
              style={{
                padding: '0.35rem 0.85rem',
                borderRadius: '0.5rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                border: '1px solid var(--accent-cyan)',
                background: 'rgba(6,182,212,0.1)',
                color: 'var(--accent-cyan)',
                transition: 'all 0.2s ease',
              }}
            >
              + 新建 Provider
            </button>
          </div>

          {llm.providers.length === 0 && !llm.loading && (
            <div
              style={{
                padding: '2rem',
                textAlign: 'center',
                color: 'var(--text-dim)',
                fontSize: '0.85rem',
                background: 'var(--bg-card)',
                borderRadius: '0.75rem',
                border: '1px dashed var(--border-light)',
              }}
            >
              暂无 Provider。点击「新建 Provider」添加第一个 LLM 服务。
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {llm.providers.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                onEdit={handleEdit}
                onDelete={llm.deleteProvider}
                onTest={llm.testConnectivity}
                onSetDefault={(id) => llm.updateProvider(id, { isDefault: true })}
                isTesting={llm.testingId === p.id}
                testResult={llm.testingId === null && llm.testResult ? llm.testResult : null}
              />
            ))}
          </div>
        </section>

        {/* ── Section 2: Step Routing ── */}
        <RoutingSection
          routings={llm.routings}
          providers={llm.providers}
          onSetRouting={llm.setRouting}
          onDeleteRouting={llm.deleteRouting}
        />
      </div>
    </article>
  );
}
