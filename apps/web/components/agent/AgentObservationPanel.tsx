'use client';

import type { AgentClarificationHistoryEntry, AgentObservationArtifactContent, AgentObservationPayload, AgentRun, ReplanClarificationChoice, ReplanPatchPayload } from '../../hooks/useAgentRun';
import { EmptyText, asRecord, safeJson } from './AgentSharedWidgets';

interface AgentObservationPanelProps {
  run: AgentRun | null;
  loading?: boolean;
  onAnswerClarification?: (choice: ReplanClarificationChoice) => void | Promise<void>;
}

interface LatestObservationView {
  observation?: AgentObservationPayload;
  replanPatch?: ReplanPatchPayload;
  createdAt?: string;
}

/**
 * 展示 Executor 失败后形成的 Observation 与 Replan 结果。
 * 输入：当前 AgentRun；输出：React 面板；副作用：无，只把后端诊断转成人类可读澄清卡片。
 */
export function AgentObservationPanel({ run, loading = false, onAnswerClarification }: AgentObservationPanelProps) {
  const latest = extractLatestObservation(run);
  if (!run || !latest) return null;

  const { observation, replanPatch } = latest;
  const action = replanPatch?.action;
  const tone = action === 'patch_plan' ? 'ok' : action === 'ask_user' ? 'warn' : 'danger';
  const heading = action === 'patch_plan' ? '已根据失败观察自动修复计划' : action === 'ask_user' ? '需要你补充选择' : '执行失败诊断';

  return (
    <section className="agent-panel-section" style={{ borderColor: borderColor(tone), background: panelBackground(tone) }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--text-main)' }}>Observation / Replan</h2>
        <span className="px-2 py-1 text-[10px] font-bold" style={{ borderRadius: 999, color: badgeColor(tone), border: `1px solid ${borderColor(tone)}` }}>{action ?? 'observation'}</span>
      </div>

      <div className="mb-3 p-3" style={{ borderRadius: '0.75rem', background: 'rgba(0,0,0,0.18)', border: `1px solid ${borderColor(tone)}` }}>
        <div className="text-xs font-bold mb-2" style={{ color: badgeColor(tone) }}>{heading}</div>
        <p className="text-xs leading-6" style={{ color: 'var(--text-muted)' }}>{replanPatch?.reason ?? observation?.error.message ?? 'Agent 已记录一次结构化执行观察。'}</p>
      </div>

      {observation && (
        <div className="grid gap-2 md:grid-cols-3 mb-3">
          <ObservationMetric label="失败步骤" value={`#${observation.stepNo}`} />
          <ObservationMetric label="工具" value={observation.tool} />
          <ObservationMetric label="错误码" value={observation.error.code ?? 'UNKNOWN'} />
        </div>
      )}

      {action === 'patch_plan' && (
        <div className="text-xs leading-6" style={{ color: '#bbf7d0' }}>
          Agent 已创建一个包含修复步骤的新计划版本，请重新检查计划并确认执行；已成功且有副作用的步骤不会在未审批情况下自动重跑。
        </div>
      )}

      {action === 'ask_user' && (
        <ClarificationBlock patch={replanPatch} loading={loading} onAnswerClarification={onAnswerClarification} />
      )}

      <ClarificationHistory run={run} />

      {action === 'fail_with_reason' && (
        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-xs" style={{ color: 'var(--text-dim)' }}>{safeJson({ observation, replanPatch })}</pre>
      )}
    </section>
  );
}

/** 展示用户已经完成的澄清轮次，帮助连续补项目/章节/角色时确认 Planner 使用的最新选择。 */
function ClarificationHistory({ run }: { run: AgentRun }) {
  const history = extractClarificationHistory(run);
  if (!history.length) return null;

  return (
    <div className="mt-3 space-y-2">
      <div className="text-[10px] font-bold" style={{ color: 'var(--agent-text-label)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>澄清历史</div>
      {history.slice(-4).map((item, index) => {
        const selected = asRecord(item.selectedChoice) ?? {};
        const label = typeof selected.label === 'string' ? selected.label : typeof selected.id === 'string' ? selected.id : '未命名候选';
        return (
          <div key={`${item.roundNo ?? index}-${item.answeredAt ?? index}`} className="p-2 text-xs" style={{ borderRadius: '0.65rem', border: '1px solid rgba(251,191,36,0.28)', background: 'rgba(251,191,36,0.05)', color: 'var(--text-muted)' }}>
            <div className="font-bold" style={{ color: '#fde68a' }}>第 {item.roundNo ?? index + 1} 轮：{item.question ?? '用户补充澄清'}</div>
            <div className="mt-1">已选择：<span className="font-bold" style={{ color: '#fbbf24' }}>{label}</span>{item.choices?.length ? `（候选 ${item.choices.length} 项）` : ''}</div>
            {item.message ? <div className="mt-1" style={{ color: 'var(--text-dim)' }}>{item.message}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 澄清块展示 resolver 多候选或不可自动选择的对象，支持一键把用户选择回写到重新规划输入。 */
function ClarificationBlock({ patch, loading, onAnswerClarification }: { patch?: ReplanPatchPayload; loading: boolean; onAnswerClarification?: (choice: ReplanClarificationChoice) => void | Promise<void> }) {
  const choices = patch?.choices ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs leading-6" style={{ color: '#fef3c7' }}>{patch?.questionForUser ?? '请选择一个候选对象后继续。'}</p>
      {choices.length ? (
        <div className="grid gap-2">
          {choices.map((choice, index) => (
            <button
              key={choice.id ?? index}
              type="button"
              disabled={loading || !onAnswerClarification}
              onClick={() => { void onAnswerClarification?.(choice); }}
              className="p-2 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-60"
              style={{ borderRadius: '0.65rem', border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.07)', color: 'var(--text-muted)' }}
              title={onAnswerClarification ? '通过专用接口提交该候选并重新规划' : '当前入口暂不支持直接选择，请在输入框补充说明'}
            >
              <span className="font-bold" style={{ color: '#fbbf24' }}>{String.fromCharCode(65 + index)}.</span> {choice.label ?? `候选 ${index + 1}`}
              <span className="ml-2" style={{ color: '#fde68a' }}>{onAnswerClarification ? '选择并生成待审批计划' : '请手动补充说明'}</span>
            </button>
          ))}
        </div>
      ) : <EmptyText text="当前 Observation 未提供候选项，请在输入框补充说明后重新规划。" />}
    </div>
  );
}

function ObservationMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2" style={{ borderRadius: '0.65rem', border: '1px solid var(--agent-border)', background: 'var(--agent-glass)' }}>
      <div className="text-[10px] font-bold" style={{ color: 'var(--agent-text-label)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      <div className="mt-1 break-all text-xs font-bold" style={{ color: 'var(--agent-text-accent)' }}>{value}</div>
    </div>
  );
}

function extractLatestObservation(run: AgentRun | null): LatestObservationView | undefined {
  const artifact = [...(run?.artifacts ?? [])].reverse().find((item) => item.artifactType === 'agent_observation');
  const artifactContent = asRecord(artifact?.content) as AgentObservationArtifactContent | undefined;
  if (artifactContent?.observation || artifactContent?.replanPatch) return { ...artifactContent, createdAt: artifact?.createdAt };

  const output = asRecord(run?.output);
  if (!output?.latestObservation && !output?.replanPatch) return undefined;
  return {
    observation: output.latestObservation as AgentObservationPayload | undefined,
    replanPatch: output.replanPatch as ReplanPatchPayload | undefined,
  };
}

function extractClarificationHistory(run: AgentRun | null): AgentClarificationHistoryEntry[] {
  const input = asRecord(run?.input) ?? {};
  const state = asRecord(input.clarificationState) ?? {};
  if (Array.isArray(state.history)) return state.history as AgentClarificationHistoryEntry[];
  const legacyChoices = Array.isArray(input.clarificationChoices) ? input.clarificationChoices : [];
  return legacyChoices.map((choice, index) => ({ roundNo: index + 1, selectedChoice: choice as ReplanClarificationChoice }));
}

function badgeColor(tone: 'ok' | 'warn' | 'danger') {
  if (tone === 'ok') return '#22c55e';
  if (tone === 'warn') return '#f59e0b';
  return '#ef4444';
}

function borderColor(tone: 'ok' | 'warn' | 'danger') {
  if (tone === 'ok') return 'rgba(34,197,94,0.38)';
  if (tone === 'warn') return 'rgba(251,191,36,0.42)';
  return 'rgba(239,68,68,0.42)';
}

function panelBackground(tone: 'ok' | 'warn' | 'danger') {
  if (tone === 'ok') return 'rgba(34,197,94,0.06)';
  if (tone === 'warn') return 'rgba(251,191,36,0.06)';
  return 'rgba(239,68,68,0.06)';
}