import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ProjectSummary } from '../../types/dashboard';
import { type GuidedAiBackend, useGuidedSession, GUIDED_STEPS, StepKey } from '../../hooks/useGuidedSession';
import { type AgentPageContext, type AgentRun, type AgentRunListItem, useAgentRun } from '../../hooks/useAgentRun';
import { AgentRunHistoryPanel } from '../agent/AgentRunHistoryPanel';
import { DocumentTOC } from './DocumentTOC';
import { StepSection } from './StepSection';
import { AiChatPanel } from './AiChatPanel';

const GUIDED_ASSISTANT_BACKEND: GuidedAiBackend =
  process.env.NEXT_PUBLIC_GUIDED_AI_BACKEND === 'guided' ? 'guided' : 'agent';

/** Parse volumeChapters from chapter step data */
function parseVolumeChapters(data: Record<string, unknown>): Record<number, Array<Record<string, unknown>>> {
  const raw = data?.volumeChapters;
  if (!raw) return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw) as Record<number, Array<Record<string, unknown>>>;
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<number, Array<Record<string, unknown>>>;
  } catch { /* ignore */ }
  return {};
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatChapterForHint(ch: Record<string, unknown>, outlineLimit = 500): string {
  const outline = typeof ch.outline === 'string' ? ch.outline : '';
  const trimmedOutline = outline.length > outlineLimit ? `${outline.slice(0, outlineLimit)}...` : outline;
  return [
    `- 章节号：第 ${getNumber(ch.chapterNo) ?? '未知'} 章`,
    `- 标题：${typeof ch.title === 'string' ? ch.title : '未命名'}`,
    `- 目标：${typeof ch.objective === 'string' ? ch.objective : '未填写'}`,
    `- 冲突：${typeof ch.conflict === 'string' ? ch.conflict : '未填写'}`,
    `- outline：${trimmedOutline || '未填写'}`,
  ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isGuidedAgentRun(run: AgentRunListItem): boolean {
  const input = asRecord(run.input);
  const context = asRecord(input.context);
  const guided = asRecord(context.guided);
  return run.taskType?.startsWith('guided_step') === true
    || context.sourcePage === 'guided_wizard'
    || Object.keys(guided).length > 0;
}

function latestPlanSummary(run: AgentRun | null): string | undefined {
  const plan = run?.plans?.[0];
  const nestedPlan = plan?.plan;
  return nestedPlan?.summary ?? plan?.summary;
}

interface Props {
  selectedProject?: ProjectSummary;
  selectedProjectId: string;
  autoStart?: boolean;
  onDataChanged?: () => void;
  onAgentContextChange?: (context: AgentPageContext) => void;
}

export function GuidedWizard({ selectedProject, selectedProjectId, autoStart, onDataChanged, onAgentContextChange }: Props) {
  const {
    session,
    currentStepIndex,
    currentStepKey,
    chatMessages,
    loading,
    error,
    setError,
    agentStatus,
    startSession,
    sendMessage,
    generateStepData,
    confirmGeneratedData,
    getStepResultData,
  } = useGuidedSession(selectedProjectId, { aiBackend: GUIDED_ASSISTANT_BACKEND });

  // Per-step editable data — keyed by stepKey
  const [allStepData, setAllStepData] = useState<Record<string, Record<string, unknown>>>({});
  // Active step for TOC highlight (driven by scroll or click)
  const [activeStepKey, setActiveStepKey] = useState<StepKey>('guided_setup');
  // AI drawer visibility
  const [aiDrawerOpen, setAiDrawerOpen] = useState(true);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  // True while sequentially generating chapters for all volumes
  const [batchGenerating, setBatchGenerating] = useState(false);
  // Section refs for scroll-to
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const latestStepDataRef = useRef(allStepData);
  const autoSaveTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const {
    currentRun: selectedAgentRun,
    runHistory: agentRunHistory,
    loading: agentHistoryLoading,
    listByProject: listAgentRunsByProject,
    refresh: refreshAgentRun,
    loadAudit: loadAgentRunAudit,
  } = useAgentRun();

  useEffect(() => {
    latestStepDataRef.current = allStepData;
  }, [allStepData]);

  useEffect(() => () => {
    Object.values(autoSaveTimersRef.current).forEach((timer) => clearTimeout(timer));
  }, []);

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
  const completedStepKeys = useMemo(() => Array.from(completedSteps), [completedSteps]);
  const guidedAgentRuns = useMemo(() => agentRunHistory.filter(isGuidedAgentRun), [agentRunHistory]);

  useEffect(() => {
    if (!agentHistoryOpen || !selectedProjectId) return;
    void listAgentRunsByProject(selectedProjectId);
  }, [agentHistoryOpen, listAgentRunsByProject, selectedProjectId]);

  // Load persisted step results into allStepData on session load.
  // Transforms flat chapter arrays back into the volumeChapters format
  // that ChapterFields expects (keyed by volumeNo).
  useEffect(() => {
    if (!session) return;
    const loaded: Record<string, Record<string, unknown>> = {};
    for (const step of GUIDED_STEPS) {
      const result = getStepResultData(step.key);
      if (result) {
        // For guided_chapter: convert flat chapters[] → volumeChapters { [volumeNo]: chapters[] }
        // because finalizeStep saves as { chapters: [...] } but UI reads volumeChapters
        if (step.key === 'guided_chapter' && Array.isArray(result.chapters) && !result.volumeChapters) {
          // Group flat chapters by volumeNo for UI consumption
          const grouped: Record<number, Array<Record<string, unknown>>> = {};
          for (const ch of result.chapters as Array<Record<string, unknown>>) {
            const vn = (ch.volumeNo as number) ?? 0;
            if (!grouped[vn]) grouped[vn] = [];
            grouped[vn].push(ch);
          }
          // Carry over volumeSupportingCharacters if saved by the merge logic
          loaded[step.key] = {
            ...result,
            volumeChapters: grouped,
            volumeSupportingCharacters: result.volumeSupportingCharacters ?? {},
          };
        } else {
          loaded[step.key] = result;
        }
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

  const saveGuidedChapterVolume = useCallback(async (
    volumeNo: number,
    rawData: Record<string, unknown>,
    options?: { silent?: boolean },
  ) => {
    const vc = parseVolumeChapters(rawData);
    const chapters = vc[volumeNo];
    if (!chapters || chapters.length === 0) return false;

    const volumeSC = (rawData.volumeSupportingCharacters ?? {}) as Record<number, Array<Record<string, unknown>>>;
    const supportChars = volumeSC[volumeNo];
    const flatChapters = chapters.map((ch) => ({ ...ch, volumeNo }));
    const saved = await confirmGeneratedData(
      {
        chapters: flatChapters,
        ...(Array.isArray(supportChars) && supportChars.length > 0 && { supportingCharacters: supportChars }),
      },
      'guided_chapter',
      volumeNo,
      options,
    );
    if (saved && !options?.silent) onDataChanged?.();
    return saved;
  }, [confirmGeneratedData, onDataChanged]);

  const scheduleChapterVolumeAutoSave = useCallback((volumeNo: number) => {
    if (!Number.isFinite(volumeNo)) return;
    const existingTimer = autoSaveTimersRef.current[volumeNo];
    if (existingTimer) clearTimeout(existingTimer);

    autoSaveTimersRef.current[volumeNo] = setTimeout(() => {
      delete autoSaveTimersRef.current[volumeNo];
      void saveGuidedChapterVolume(
        volumeNo,
        latestStepDataRef.current['guided_chapter'] ?? {},
        { silent: true },
      );
    }, 900);
  }, [saveGuidedChapterVolume]);

  // Handle AI generation for a specific step.
  // For guided_chapter: sequentially generates chapters for each volume in order,
  // so the AI focuses on one volume's narrative arc at a time.
  const handleGenerate = useCallback(async (stepKey: StepKey) => {
    // For guided_volume, pass the user-specified volume count as a hint
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
      const hint = `请严格生成 ${volumeCount} 卷，不多不少。`;
      const data = await generateStepData(hint, stepKey);
      if (data) {
        setAllStepData((prev) => ({ ...prev, [stepKey]: data }));
      }
      return;
    }

    // For guided_chapter: iterate through volumes one by one.
    // Uses batchGenerating flag to keep buttons disabled across the entire loop.
    if (stepKey === 'guided_chapter') {
      setBatchGenerating(true);
      const volumeRaw = allStepData['guided_volume']?.volumes;
      let volumes: Array<{ volumeNo: number }> = [];
      try {
        if (typeof volumeRaw === 'string') volumes = JSON.parse(volumeRaw);
        else if (Array.isArray(volumeRaw)) volumes = volumeRaw as Array<{ volumeNo: number }>;
      } catch { /* ignore */ }

      if (volumes.length === 0) {
        setBatchGenerating(false);
        return;
      }

      // Generate chapters sequentially, volume by volume.
      // Each volume retries up to MAX_RETRIES times on failure before skipping.
      // try/finally ensures the batch flag is always cleared.
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 2000;
      try {
        for (const vol of volumes) {
          // Read current chapter range settings (default 15-20)
          const chapterRange: [number, number] = [15, 20];
          const [minCh, maxCh] = chapterRange;

          // Retry loop: attempt generation up to MAX_RETRIES times
          let data: Record<string, unknown> | null = null;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              data = await generateStepData(
                `为第 ${vol.volumeNo} 卷生成章节细纲，请生成 ${minCh}-${maxCh} 章`,
                'guided_chapter',
                vol.volumeNo,
              );
              if (data) break; // Success — exit retry loop
            } catch { /* generateStepData already sets error state */ }

            // Wait before retrying (skip delay on last attempt)
            if (attempt < MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            }
          }

          if (data) {
            const newChapters = (data as Record<string, unknown>).chapters;
            const newSupportChars = (data as Record<string, unknown>).supportingCharacters;

            // Merge returned chapters and supporting characters into local state
            setAllStepData((prev) => {
              const existingData = prev['guided_chapter'] ?? {};
              const existingVC = parseVolumeChapters(existingData);
              if (Array.isArray(newChapters)) {
                existingVC[vol.volumeNo] = newChapters;
              }
              // Merge supporting characters keyed by volumeNo
              const existingSC = (existingData.volumeSupportingCharacters ?? {}) as Record<number, unknown[]>;
              if (Array.isArray(newSupportChars)) {
                existingSC[vol.volumeNo] = newSupportChars;
              }
              return {
                ...prev,
                guided_chapter: {
                  ...existingData,
                  volumeChapters: existingVC,
                  volumeSupportingCharacters: existingSC,
                },
              };
            });

            // Auto-save: persist this volume's chapters + characters to DB immediately.
            // Uses the fresh data from generateStepData (not stale allStepData).
            if (Array.isArray(newChapters) && newChapters.length > 0) {
              const flatChapters = (newChapters as Array<Record<string, unknown>>)
                .map((ch) => ({ ...ch, volumeNo: vol.volumeNo }));
              await confirmGeneratedData(
                {
                  chapters: flatChapters,
                  ...(Array.isArray(newSupportChars) && { supportingCharacters: newSupportChars }),
                },
                'guided_chapter',
                vol.volumeNo,
              );
              onDataChanged?.();
            }
          }
          // If all retries failed (data is null), skip this volume and continue
        }
      } finally {
        setBatchGenerating(false);
      }
      return;
    }

    // Default: single-shot generation for other steps
    const data = await generateStepData(undefined, stepKey);
    if (data) {
      setAllStepData((prev) => ({ ...prev, [stepKey]: data }));
    }
  }, [generateStepData, confirmGeneratedData, allStepData, onDataChanged]);

  // Handle AI generation for a specific volume's chapters
  const handleGenerateForVolume = useCallback(async (volumeNo: number, chapterRange?: [number, number]) => {
    const [minCh, maxCh] = chapterRange ?? [8, 15];
    const data = await generateStepData(
      `为第 ${volumeNo} 卷生成章节细纲，请生成 ${minCh}-${maxCh} 章`,
      'guided_chapter',
      volumeNo,
    );
    if (data) {
      // Merge returned chapters and supporting characters into local state
      const existingData = allStepData['guided_chapter'] ?? {};
      const existingVC = parseVolumeChapters(existingData);
      const newChapters = (data as Record<string, unknown>).chapters;
      const newSupportChars = (data as Record<string, unknown>).supportingCharacters;
      if (Array.isArray(newChapters)) {
        existingVC[volumeNo] = newChapters;
      }
      const existingSC = (existingData.volumeSupportingCharacters ?? {}) as Record<number, unknown[]>;
      if (Array.isArray(newSupportChars)) {
        existingSC[volumeNo] = newSupportChars;
      }
      setAllStepData((prev) => ({
        ...prev,
        guided_chapter: {
          ...existingData,
          volumeChapters: existingVC,
          volumeSupportingCharacters: existingSC,
        },
      }));

      if (Array.isArray(newChapters) && newChapters.length > 0) {
        const flatChapters = (newChapters as Array<Record<string, unknown>>)
          .map((ch) => ({ ...ch, volumeNo }));
        await confirmGeneratedData(
          {
            chapters: flatChapters,
            ...(Array.isArray(newSupportChars) && { supportingCharacters: newSupportChars }),
          },
          'guided_chapter',
          volumeNo,
        );
        onDataChanged?.();
      }
    }
  }, [generateStepData, confirmGeneratedData, allStepData, onDataChanged]);

  // Handle AI refinement for one chapter only.
  const handleGenerateForChapter = useCallback(async (volumeNo: number, chapterNo: number) => {
    const existingData = allStepData['guided_chapter'] ?? {};
    const existingVC = parseVolumeChapters(existingData);
    const currentChapters = [...(existingVC[volumeNo] ?? [])];
    const targetIndex = currentChapters.findIndex((ch) => getNumber(ch.chapterNo) === chapterNo);
    const fallbackIndex = targetIndex >= 0 ? targetIndex : chapterNo - 1;
    const targetChapter = currentChapters[fallbackIndex];

    const neighborSummary = currentChapters
      .map((ch, idx) => ({ ch, idx }))
      .filter(({ idx }) => idx !== fallbackIndex && Math.abs(idx - fallbackIndex) <= 3)
      .map(({ ch }) => formatChapterForHint(ch, 180))
      .join('\n\n');

    const hint = [
      `细化第 ${volumeNo} 卷第 ${chapterNo} 章细纲。`,
      '只返回这 1 个 chapter，不生成正文，不新增/删除/重排本卷章节。',
      'outline 必须写成 Markdown「## 本章执行卡」，包含表层目标、隐藏情绪、核心冲突、行动链、物证/线索、对话潜台词、人物变化、不可逆后果。',
      '',
      '当前章：',
      targetChapter ? formatChapterForHint(targetChapter) : `第 ${chapterNo} 章当前内容未在前端状态中找到，请保持 chapterNo 不变。`,
      '',
      '前后章摘要：',
      neighborSummary || '未找到前后章摘要。',
    ].join('\n');

    const data = await generateStepData(
      hint,
      'guided_chapter',
      volumeNo,
      chapterNo,
    );

    const returnedChapters = data?.chapters;
    if (!Array.isArray(returnedChapters) || returnedChapters.length === 0) return;

    if (returnedChapters.length > 1) {
      setError(`单章细化返回了 ${returnedChapters.length} 个章节，已只使用第一个。`);
    }

    const returnedChapter = returnedChapters[0] as Record<string, unknown>;
    if (getNumber(returnedChapter.chapterNo) !== undefined && getNumber(returnedChapter.chapterNo) !== chapterNo) {
      setError(`单章细化返回的章节号与请求不一致，已按第 ${chapterNo} 章替换。`);
    }
    const mergedChapter = {
      ...(targetChapter ?? {}),
      ...returnedChapter,
      volumeNo,
      chapterNo,
    };

    setAllStepData((prev) => {
      const prevChapterData = prev['guided_chapter'] ?? {};
      const prevVC = parseVolumeChapters(prevChapterData);
      const nextVC = { ...prevVC };
      const nextVolumeChapters = [...(nextVC[volumeNo] ?? [])];
      const replaceIndex = nextVolumeChapters.findIndex((ch) => getNumber(ch.chapterNo) === chapterNo);
      const indexToReplace = replaceIndex >= 0 ? replaceIndex : chapterNo - 1;
      nextVolumeChapters[indexToReplace] = mergedChapter;
      nextVC[volumeNo] = nextVolumeChapters;

      return {
        ...prev,
        guided_chapter: {
          ...prevChapterData,
          volumeChapters: nextVC,
        },
      };
    });

    await confirmGeneratedData(
      { saveMode: 'single_chapter', chapters: [mergedChapter] },
      'guided_chapter',
      volumeNo,
    );
    onDataChanged?.();
  }, [allStepData, generateStepData, confirmGeneratedData, onDataChanged, setError]);

  // Handle save for a specific step
  const handleSave = useCallback(async (stepKey: StepKey) => {
    const rawData = allStepData[stepKey];
    if (!rawData || Object.keys(rawData).length === 0) return;

    // Normalize: parse JSON-stringified fields back to objects
    // (VolumesFields, CharactersFields, and ChapterFields store edited data as JSON strings via onChange)
    const data = { ...rawData };
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        try { data[key] = JSON.parse(val); } catch { /* keep as-is */ }
      }
    }

    // For guided_chapter, flatten volumeChapters + volumeSupportingCharacters
    if (stepKey === 'guided_chapter') {
      const vc = parseVolumeChapters(data);
      const flatChapters: Array<Record<string, unknown>> = [];
      for (const [volNoStr, chapters] of Object.entries(vc)) {
        const volNo = parseInt(volNoStr, 10);
        for (const ch of chapters) {
          flatChapters.push({ ...ch, volumeNo: volNo });
        }
      }

      // Flatten all volumes' supporting characters into a single array
      const volumeSC = (data.volumeSupportingCharacters ?? {}) as Record<number, Array<Record<string, unknown>>>;
      const allSupportChars: Array<Record<string, unknown>> = [];
      for (const chars of Object.values(volumeSC)) {
        if (Array.isArray(chars)) allSupportChars.push(...chars);
      }

      if (flatChapters.length > 0) {
        await confirmGeneratedData(
          {
            chapters: flatChapters,
            ...(allSupportChars.length > 0 && { supportingCharacters: allSupportChars }),
          },
          stepKey,
        );
        onDataChanged?.();
      }
      return;
    }

    await confirmGeneratedData(data, stepKey);
    // Trigger sidebar refresh after saving
    onDataChanged?.();
  }, [allStepData, confirmGeneratedData, onDataChanged]);

  // Handle save for a specific volume's chapters and supporting characters
  const handleSaveVolume = useCallback(async (volumeNo: number) => {
    await saveGuidedChapterVolume(volumeNo, allStepData['guided_chapter'] ?? {});
  }, [allStepData, saveGuidedChapterVolume]);

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

  const guidedAgentContext = useMemo<AgentPageContext>(() => ({
    currentProjectId: selectedProjectId,
    sourcePage: 'guided_wizard',
    guided: {
      currentStep: activeStepKey,
      currentStepLabel,
      currentStepData: allStepData[activeStepKey] ?? {},
      completedSteps: completedStepKeys,
      documentDraft: allStepData,
    },
  }), [activeStepKey, allStepData, completedStepKeys, currentStepLabel, selectedProjectId]);

  useEffect(() => {
    onAgentContextChange?.(guidedAgentContext);
  }, [guidedAgentContext, onAgentContextChange]);

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
        agentHistoryOpen={agentHistoryOpen}
        onToggleAgentHistory={() => setAgentHistoryOpen((prev) => !prev)}
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

      {agentHistoryOpen && (
        <GuidedAgentHistoryPanel
          runs={guidedAgentRuns}
          currentRun={selectedAgentRun}
          loading={agentHistoryLoading}
          onRefresh={async () => { await listAgentRunsByProject(selectedProjectId); }}
          onSelect={async (id) => {
            await refreshAgentRun(id);
            await loadAgentRunAudit(id);
          }}
        />
      )}

      {/* Main content: TOC + Document + AI Drawer */}
      <div className="flex flex-1" style={{ minHeight: 0 }}>
        {/* Left: Document TOC */}
        <DocumentTOC
          activeStepKey={activeStepKey}
          completedSteps={completedSteps}
          onStepClick={handleTocClick}
          volumeData={allStepData['guided_volume'] ?? {}}
          chapterData={allStepData['guided_chapter'] ?? {}}
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
                volumeData={allStepData['guided_volume'] ?? {}}
                onEditField={handleEditField}
                onGenerate={handleGenerate}
                onGenerateForVolume={handleGenerateForVolume}
                onGenerateForChapter={handleGenerateForChapter}
                onAutoSaveVolume={scheduleChapterVolumeAutoSave}
                onSave={handleSave}
                onSaveVolume={handleSaveVolume}
                loading={loading || batchGenerating}
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
          agentStatus={agentStatus}
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
  agentHistoryOpen,
  onToggleAi,
  onToggleAgentHistory,
}: {
  projectTitle?: string;
  aiDrawerOpen?: boolean;
  agentHistoryOpen?: boolean;
  onToggleAi?: () => void;
  onToggleAgentHistory?: () => void;
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
        {onToggleAgentHistory && (
          <button
            onClick={onToggleAgentHistory}
            style={{
              padding: '0.3rem 0.6rem',
              borderRadius: '0.4rem',
              border: '1px solid var(--border-light)',
              background: agentHistoryOpen ? 'var(--accent-cyan-bg)' : 'var(--bg-hover-subtle)',
              color: agentHistoryOpen ? 'var(--accent-cyan)' : 'var(--text-dim)',
              fontSize: '0.72rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            Agent 记录
          </button>
        )}
      </div>
    </header>
  );
}

function GuidedAgentHistoryPanel({
  runs,
  currentRun,
  loading,
  onRefresh,
  onSelect,
}: {
  runs: AgentRunListItem[];
  currentRun: AgentRun | null;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  onSelect: (id: string) => void | Promise<void>;
}) {
  const artifacts = currentRun?.artifacts ?? [];
  const summary = latestPlanSummary(currentRun);

  return (
    <section
      className="animate-slide-top"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(16rem, 22rem) minmax(0, 1fr)',
        gap: '0.75rem',
        padding: '0.75rem 1rem',
        borderBottom: '1px solid var(--border-light)',
        background: 'color-mix(in srgb, var(--bg-editor-header) 92%, transparent)',
        maxHeight: '20rem',
        overflow: 'hidden',
      }}
    >
      <div style={{ minHeight: 0, overflowY: 'auto' }}>
        <AgentRunHistoryPanel
          runs={runs}
          currentRunId={currentRun?.id}
          loading={loading}
          onRefresh={onRefresh}
          onSelect={onSelect}
        />
      </div>
      <div
        style={{
          minHeight: 0,
          overflowY: 'auto',
          border: '1px solid var(--border-light)',
          borderRadius: '0.5rem',
          background: 'var(--bg-card)',
          padding: '0.85rem',
        }}
      >
        {currentRun ? (
          <div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold" style={{ color: 'var(--text-main)' }}>
                  {currentRun.taskType ?? 'AgentRun'}
                </div>
                <div className="mt-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  {currentRun.status}
                </div>
              </div>
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {currentRun.id.slice(0, 8)}
              </span>
            </div>
            <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              {summary ?? currentRun.goal}
            </p>
            <div className="mt-4">
              <div className="mb-2 text-[11px] font-bold uppercase" style={{ color: 'var(--accent-cyan)' }}>
                Artifacts
              </div>
              {artifacts.length ? (
                <div className="space-y-2">
                  {artifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      style={{
                        padding: '0.55rem 0.65rem',
                        borderRadius: '0.45rem',
                        border: '1px solid var(--border-dim)',
                        background: 'var(--bg-deep)',
                      }}
                    >
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-main)' }}>
                        {artifact.title ?? artifact.artifactType ?? 'Artifact'}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-dim)' }}>
                        {artifact.artifactType ?? 'unknown'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  选择一条历史记录后会显示对应 Artifact。
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs" style={{ color: 'var(--text-dim)' }}>
            选择左侧记录查看计划摘要和 Artifact。
          </div>
        )}
      </div>
    </section>
  );
}
