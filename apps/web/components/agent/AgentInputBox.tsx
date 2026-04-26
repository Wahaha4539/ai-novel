'use client';

import { FormEvent } from 'react';

const EXAMPLE_PROMPTS = [
  '帮我写第 1 章正文，保持悬疑节奏，目标 3000 字',
  '把第一卷拆成 12 章，每章给出冲突、钩子和字数建议',
  '拆解这段文案，生成角色、世界观和章节大纲预览',
];

interface AgentInputBoxProps {
  goal: string;
  loading: boolean;
  canReplan: boolean;
  hasCurrentRun: boolean;
  onGoalChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onReplan: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
}

/** AgentInputBox 承载自然语言任务输入、示例填充和重新规划入口。 */
export function AgentInputBox({ goal, loading, canReplan, hasCurrentRun, onGoalChange, onSubmit, onReplan, onRefresh }: AgentInputBoxProps) {
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || loading) return;
    await onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="panel p-5 h-fit" style={{ borderColor: 'rgba(245,158,11,0.22)' }}>
      <label className="block text-xs font-bold mb-3" style={{ color: '#fbbf24', letterSpacing: '0.16em', textTransform: 'uppercase' }}>MISSION BRIEF</label>
      <textarea
        value={goal}
        onChange={(event) => onGoalChange(event.target.value)}
        rows={8}
        className="w-full resize-none p-4 text-sm outline-none"
        style={{ borderRadius: '1rem', border: '1px solid var(--border-light)', background: 'rgba(0,0,0,0.22)', color: 'var(--text-main)', lineHeight: 1.7 }}
        placeholder="例如：帮我写第 3 章正文，目标 3200 字，强化主角第一次发现异常记忆的惊悚感…"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {EXAMPLE_PROMPTS.map((item) => (
          <button key={item} type="button" onClick={() => onGoalChange(item)} className="px-3 py-2 text-xs" style={{ borderRadius: '999px', border: '1px solid var(--border-dim)', color: 'var(--text-muted)', background: 'var(--bg-hover-subtle)' }}>
            {item}
          </button>
        ))}
      </div>
      <div className="mt-5 flex gap-3">
        <button type="submit" disabled={loading || !goal.trim()} className="px-5 py-3 text-sm font-bold" style={{ borderRadius: '0.8rem', border: 'none', cursor: loading ? 'wait' : 'pointer', color: '#001018', background: 'linear-gradient(135deg, #67e8f9, #fbbf24)', opacity: loading || !goal.trim() ? 0.55 : 1 }}>
          {loading ? '处理中…' : '生成计划'}
        </button>
        {hasCurrentRun && <button type="button" onClick={() => void onReplan()} disabled={!canReplan || loading} className="px-4 py-3 text-sm" style={{ borderRadius: '0.8rem', border: '1px solid rgba(251,191,36,0.45)', color: '#fbbf24', background: 'transparent', opacity: !canReplan || loading ? 0.5 : 1 }}>重新规划</button>}
        {hasCurrentRun && <button type="button" onClick={() => void onRefresh()} disabled={loading} className="px-4 py-3 text-sm" style={{ borderRadius: '0.8rem', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'transparent' }}>刷新</button>}
      </div>
    </form>
  );
}