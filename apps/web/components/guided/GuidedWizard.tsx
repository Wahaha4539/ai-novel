import React, { useState, useCallback, useEffect } from 'react';
import { ProjectSummary } from '../../types/dashboard';
import { useGuidedSession, GUIDED_STEPS } from '../../hooks/useGuidedSession';
import { StepProgressBar } from './StepProgressBar';
import { AiChatPanel } from './AiChatPanel';
import { StructuredPreview } from './StructuredPreview';

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  autoStart?: boolean;
}

export function GuidedWizard({ selectedProject, selectedProjectId, autoStart }: Props) {
  const {
    session,
    currentStepIndex,
    currentStepKey,
    chatMessages,
    loading,
    error,
    startSession,
    saveStepProgress,
    goToNextStep,
    goToPrevStep,
    sendMessage,
    generateStepData,
    confirmGeneratedData,
    autoAdvanceToNextStep,
  } = useGuidedSession(selectedProjectId);

  // Local editable fields for the structured preview
  const [previewData, setPreviewData] = useState<Record<string, unknown>>({});
  // Track whether we have AI-generated data pending confirmation
  const [hasGeneratedData, setHasGeneratedData] = useState(false);

  const handleEditField = useCallback((field: string, value: string) => {
    setPreviewData((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleConfirmAndNext = useCallback(async () => {
    await saveStepProgress(previewData);
    setPreviewData({});
    setHasGeneratedData(false);
    await goToNextStep();
  }, [saveStepProgress, previewData, goToNextStep]);

  // One-shot generation: AI generates everything, user reviews in preview
  const handleGenerate = useCallback(async () => {
    const data = await generateStepData();
    if (data) {
      setPreviewData(data);
      setHasGeneratedData(true);
    }
  }, [generateStepData]);

  // Confirm generated/edited data and persist to DB, then advance
  const handleConfirmGenerated = useCallback(async () => {
    const success = await confirmGeneratedData(previewData);
    if (success) {
      setHasGeneratedData(false);
      setPreviewData({});
      // Data already persisted — use autoAdvance (skips re-finalization)
      await autoAdvanceToNextStep();
    }
  }, [confirmGeneratedData, previewData, autoAdvanceToNextStep]);

  const isLastStep = currentStepIndex >= GUIDED_STEPS.length - 1;

  // Reset preview data when step changes
  useEffect(() => {
    setPreviewData({});
    setHasGeneratedData(false);
  }, [currentStepIndex]);

  // Auto-start session when triggered from guided project creation
  useEffect(() => {
    if (autoStart && !session && !loading) {
      startSession();
    }
  }, [autoStart, session, loading, startSession]);

  // No session yet — show start screen
  if (!session) {
    return (
      <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
        <GuidedHeader projectTitle={selectedProject?.title} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center animate-fade-in" style={{ maxWidth: '28rem' }}>
            <div
              className="animate-pulse-glow"
              style={{
                width: '5rem',
                height: '5rem',
                borderRadius: '1.5rem',
                background: 'linear-gradient(135deg, var(--accent-cyan), #8b5cf6)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 1.5rem',
                fontSize: '2rem',
              }}
            >
              ✨
            </div>
            <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-main)' }}>
              AI 创作引导
            </h2>
            <p className="text-sm mb-6" style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
              通过 AI 对话一步步完善你的小说设定、风格、角色、大纲和伏笔体系。
              <br />
              整个过程可以随时中断，下次继续。
            </p>
            {error && (
              <div className="mb-4 text-xs" style={{ color: 'var(--status-err)' }}>{error}</div>
            )}
            <button
              className="btn-primary"
              onClick={startSession}
              disabled={loading}
              style={{ padding: '0.6rem 2rem', fontSize: '0.9rem' }}
            >
              {loading ? '启动中…' : '开始引导创作'}
            </button>
          </div>
        </div>
      </article>
    );
  }

  // Active session — show wizard
  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <GuidedHeader projectTitle={selectedProject?.title} />
      <StepProgressBar currentStepIndex={currentStepIndex} />

      {/* Main content: Chat + Preview split */}
      <div className="flex flex-1" style={{ minHeight: 0 }}>
        {/* Left: AI Chat */}
        <div
          className="flex flex-col"
          style={{
            flex: '1 1 50%',
            borderRight: '1px solid var(--border-dim)',
            minWidth: 0,
          }}
        >
          <AiChatPanel
            messages={chatMessages}
            onSend={sendMessage}
            loading={loading}
          />
        </div>

        {/* Right: Structured Preview */}
        <div
          className="flex flex-col"
          style={{ flex: '1 1 50%', minWidth: 0 }}
        >
          <StructuredPreview
            currentStepKey={currentStepKey}
            stepData={previewData}
            onEditField={handleEditField}
          />

          {/* Confirm generated data button — shown when AI data is pending */}
          {hasGeneratedData && (
            <div
              style={{
                padding: '0.75rem 1.25rem',
                borderTop: '1px solid var(--border-dim)',
                background: 'var(--bg-card)',
              }}
            >
              <button
                className="btn-primary"
                onClick={handleConfirmGenerated}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.6rem',
                  fontSize: '0.85rem',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                }}
              >
                {loading ? '保存中…' : '✅ 确认并保存'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom navigation */}
      <div
        className="flex items-center justify-between shrink-0"
        style={{
          padding: '0.75rem 2rem',
          borderTop: '1px solid var(--border-dim)',
          background: 'var(--bg-card)',
        }}
      >
        <button
          className="btn-secondary"
          onClick={goToPrevStep}
          disabled={currentStepIndex <= 0}
          style={{ opacity: currentStepIndex <= 0 ? 0.4 : 1 }}
        >
          ← 上一步
        </button>

        <div className="flex items-center gap-3">
          {/* One-shot generation button */}
          <button
            onClick={handleGenerate}
            disabled={loading}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '0.5rem',
              border: '1px solid rgba(139, 92, 246, 0.4)',
              background: loading
                ? 'var(--bg-hover-subtle)'
                : 'linear-gradient(135deg, rgba(139,92,246,0.15), rgba(14,165,233,0.15))',
              color: loading ? 'var(--text-dim)' : '#a78bfa',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: loading ? 'default' : 'pointer',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
            }}
          >
            ⚡ AI 一键生成
          </button>

          <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
            步骤 {currentStepIndex + 1} / {GUIDED_STEPS.length}
          </div>

          <button
            className="btn-primary"
            onClick={handleConfirmAndNext}
            disabled={loading}
          >
            {isLastStep ? '🎉 完成引导' : '确认并继续 →'}
          </button>
        </div>
      </div>
    </article>
  );
}

/** Panel header — reused for both start screen and active wizard */
function GuidedHeader({ projectTitle }: { projectTitle?: string }) {
  return (
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
            background: 'linear-gradient(135deg, #0ea5e9, #8b5cf6)',
            boxShadow: '0 0 10px rgba(14,165,233,0.5)',
          }}
        />
        <h1
          className="text-lg font-bold text-heading"
          style={{ textShadow: '0 2px 10px var(--accent-cyan-glow)' }}
        >
          创作引导
        </h1>
        <span
          className="badge"
          style={{
            background: 'rgba(14,165,233,0.12)',
            color: '#0ea5e9',
            border: 'none',
          }}
        >
          Guided
        </span>
      </div>
      <div className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>
        {projectTitle ?? '未选择项目'}
      </div>
    </header>
  );
}
