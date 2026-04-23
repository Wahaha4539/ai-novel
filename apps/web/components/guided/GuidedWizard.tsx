import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ProjectSummary } from '../../types/dashboard';
import { useGuidedSession, GUIDED_STEPS, StepKey } from '../../hooks/useGuidedSession';
import { DocumentTOC } from './DocumentTOC';
import { StepSection } from './StepSection';
import { AiChatPanel } from './AiChatPanel';

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
    setError,
    startSession,
    sendMessage,
    generateStepData,
    confirmGeneratedData,
    getStepResultData,
  } = useGuidedSession(selectedProjectId);

  // Per-step editable data — keyed by stepKey
  const [allStepData, setAllStepData] = useState<Record<string, Record<string, unknown>>>({});
  // Active step for TOC highlight (driven by scroll or click)
  const [activeStepKey, setActiveStepKey] = useState<StepKey>('guided_setup');
  // AI drawer visibility
  const [aiDrawerOpen, setAiDrawerOpen] = useState(true);
  // Section refs for scroll-to
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Compute completed steps
  const completedSteps = useMemo(() => {
    const set = new Set<string>();
    for (const step of GUIDED_STEPS) {
      const result = getStepResultData(step.key);
      if (result && Object.keys(result).length > 0) {
        set.add(step.key);
      }
    }
    return set;
  }, [getStepResultData, session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load persisted step results into allStepData on session load
  useEffect(() => {
    if (!session) return;
    const loaded: Record<string, Record<string, unknown>> = {};
    for (const step of GUIDED_STEPS) {
      const result = getStepResultData(step.key);
      if (result) {
        loaded[step.key] = result;
      }
    }
    setAllStepData((prev) => ({ ...prev, ...loaded }));
  }, [session, getStepResultData]);

  // Handle field edits for a specific step
  const handleEditField = useCallback((stepKey: StepKey, field: string, value: string) => {
    setAllStepData((prev) => ({
      ...prev,
      [stepKey]: { ...(prev[stepKey] ?? {}), [field]: value },
    }));
  }, []);

  // Handle AI generation for a specific step
  const handleGenerate = useCallback(async (stepKey: StepKey) => {
    // For guided_volume, pass the user-specified volume count as a hint
    let hint: string | undefined;
    if (stepKey === 'guided_volume') {
      const currentVolumes = allStepData[stepKey]?.volumes;
      let volumeCount = 3; // default
      try {
        if (typeof currentVolumes === 'string') {
          volumeCount = (JSON.parse(currentVolumes) as unknown[]).length;
        } else if (Array.isArray(currentVolumes)) {
          volumeCount = currentVolumes.length;
        }
      } catch { /* use default */ }
      hint = `请严格生成 ${volumeCount} 卷，不多不少。`;
    }

    const data = await generateStepData(hint, stepKey);
    if (data) {
      setAllStepData((prev) => ({
        ...prev,
        [stepKey]: data,
      }));
    }
  }, [generateStepData, allStepData]);

  // Handle save for a specific step
  const handleSave = useCallback(async (stepKey: StepKey) => {
    const data = allStepData[stepKey];
    if (!data || Object.keys(data).length === 0) return;
    await confirmGeneratedData(data, stepKey);
  }, [allStepData, confirmGeneratedData]);

  // TOC click — scroll to section
  const handleTocClick = useCallback((stepKey: StepKey) => {
    setActiveStepKey(stepKey);
    const el = sectionRefs.current[stepKey];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // Scroll spy — update activeStepKey based on scroll position
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const containerTop = container.scrollTop + 80;
      let closest: StepKey = GUIDED_STEPS[0].key;
      let minDist = Infinity;

      for (const step of GUIDED_STEPS) {
        const el = sectionRefs.current[step.key];
        if (!el) continue;
        const dist = Math.abs(el.offsetTop - containerTop);
        if (dist < minDist) {
          minDist = dist;
          closest = step.key;
        }
      }
      setActiveStepKey(closest);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-start session when triggered from guided project creation
  useEffect(() => {
    if (autoStart && !session && !loading) {
      startSession();
    }
  }, [autoStart, session, loading, startSession]);

  // Get current step label for AI drawer
  const currentStepLabel = GUIDED_STEPS.find((s) => s.key === activeStepKey)?.label;

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
            <p className="text-sm mb-4" style={{ color: 'var(--text-muted)', lineHeight: 1.7 }}>
              通过 AI 一步步完善你的小说设定、风格、角色、大纲和伏笔体系。
              <br />
              整个过程可以随时中断，下次继续。
            </p>
            {error && (
              <div className="mb-4 text-xs" style={{ color: 'var(--status-err)' }}>{error}</div>
            )}
            <button
              className="btn"
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

  // Active session — document editing layout
  return (
    <article className="flex flex-col h-full" style={{ background: 'var(--bg-deep)' }}>
      <GuidedHeader
        projectTitle={selectedProject?.title}
        aiDrawerOpen={aiDrawerOpen}
        onToggleAi={() => setAiDrawerOpen((prev) => !prev)}
      />

      {/* Error banner */}
      {error && (
        <div
          className="animate-slide-top"
          style={{
            padding: '0.5rem 1.5rem',
            background: 'var(--status-err-bg)',
            borderBottom: '1px solid rgba(244,63,94,0.2)',
            color: '#fb7185',
            fontSize: '0.78rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>⚠️ {error}</span>
          <button
            onClick={() => setError('')}
            style={{ background: 'none', border: 'none', color: '#fb7185', cursor: 'pointer', fontSize: '0.8rem' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main content: TOC + Document + AI Drawer */}
      <div className="flex flex-1" style={{ minHeight: 0 }}>
        {/* Left: Document TOC */}
        <DocumentTOC
          activeStepKey={activeStepKey}
          completedSteps={completedSteps}
          onStepClick={handleTocClick}
        />

        {/* Center: Document Body */}
        <div
          ref={scrollContainerRef}
          className="doc-body flex-1"
          style={{ position: 'relative' }}
        >
          <div className="doc-body__sections">
            {GUIDED_STEPS.map((step) => (
              <StepSection
                key={step.key}
                ref={(el) => { sectionRefs.current[step.key] = el; }}
                stepKey={step.key}
                isActive={activeStepKey === step.key}
                isCompleted={completedSteps.has(step.key)}
                data={allStepData[step.key] ?? {}}
                onEditField={handleEditField}
                onGenerate={handleGenerate}
                onSave={handleSave}
                loading={loading}
              />
            ))}

            {/* Completion footer */}
            <div
              style={{
                textAlign: 'center',
                padding: '2rem 0 3rem',
                color: 'var(--text-dim)',
                fontSize: '0.8rem',
              }}
            >
              {completedSteps.size === GUIDED_STEPS.length ? (
                <div className="animate-fade-in">
                  <span style={{ fontSize: '1.5rem' }}>🎉</span>
                  <div className="mt-2 font-semibold" style={{ color: '#34d399' }}>
                    所有步骤已完成！
                  </div>
                  <div className="mt-1" style={{ color: 'var(--text-dim)' }}>
                    你可以随时回来修改任何章节
                  </div>
                </div>
              ) : (
                <span>
                  已完成 {completedSteps.size} / {GUIDED_STEPS.length} 步骤
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: AI Chat Drawer */}
        <AiChatPanel
          messages={chatMessages}
          onSend={sendMessage}
          loading={loading}
          isOpen={aiDrawerOpen}
          onClose={() => setAiDrawerOpen(false)}
          currentStepLabel={currentStepLabel}
        />

        {/* AI Drawer toggle button (visible when closed) */}
        {!aiDrawerOpen && (
          <button
            className="ai-drawer__toggle"
            onClick={() => setAiDrawerOpen(true)}
            title="打开 AI 助手"
          >
            💬
          </button>
        )}
      </div>
    </article>
  );
}

/** Panel header */
function GuidedHeader({
  projectTitle,
  aiDrawerOpen,
  onToggleAi,
}: {
  projectTitle?: string;
  aiDrawerOpen?: boolean;
  onToggleAi?: () => void;
}) {
  return (
    <header
      className="flex items-center justify-between shrink-0"
      style={{
        height: '3rem',
        background: 'var(--bg-editor-header)',
        padding: '0 1.5rem',
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
          className="text-base font-bold text-heading"
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
          Document
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          {projectTitle ?? '未选择项目'}
        </span>
        {onToggleAi && (
          <button
            onClick={onToggleAi}
            style={{
              padding: '0.3rem 0.6rem',
              borderRadius: '0.4rem',
              border: '1px solid var(--border-light)',
              background: aiDrawerOpen ? 'var(--accent-cyan-bg)' : 'var(--bg-hover-subtle)',
              color: aiDrawerOpen ? 'var(--accent-cyan)' : 'var(--text-dim)',
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}
          >
            🤖 AI 助手
          </button>
        )}
      </div>
    </header>
  );
}
