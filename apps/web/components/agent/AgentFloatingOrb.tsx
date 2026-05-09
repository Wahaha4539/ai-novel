'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type AgentPageContext, AgentRunStatus, useAgentRun } from '../../hooks/useAgentRun';
import { AgentFloatingPanel } from './AgentFloatingPanel';

interface AgentFloatingOrbProps {
  projectId: string;
  selectedChapterId?: string;
  pageContext?: AgentPageContext;
  onRefresh?: () => void | Promise<void>;
}

/**
 * 根据 AgentRun 状态映射圆球的 CSS 修饰类名。
 * idle/planning → 慢脉冲；running/acting → 快脉冲+旋转光环；
 * waiting_approval/waiting_review → 琥珀闪烁；failed → 红色静态；succeeded → 绿色静态。
 */
function orbStatusClass(status?: AgentRunStatus): string {
  if (!status || status === 'planning') return 'agent-orb--idle';
  if (status === 'running' || status === 'acting') return 'agent-orb--running';
  if (status === 'waiting_approval' || status === 'waiting_review') return 'agent-orb--waiting';
  if (status === 'failed') return 'agent-orb--failed';
  if (status === 'succeeded') return 'agent-orb--success';
  return 'agent-orb--idle';
}

/** 判断当前状态是否应展示旋转光环 */
const isRunningStatus = (status?: AgentRunStatus) =>
  status === 'running' || status === 'acting' || status === 'planning';

/** 判断当前状态是否需要用户关注（显示通知徽标） */
const needsAttention = (status?: AgentRunStatus) =>
  status === 'waiting_approval' || status === 'waiting_review' || status === 'failed';

// 拖拽阈值（像素）：低于此值的指针移动视为点击而非拖拽
const DRAG_THRESHOLD = 5;

/**
 * Agent 悬浮圆球入口组件。
 * - 固定定位于屏幕右下角，支持 pointer 拖拽移动
 * - 根据 AgentRun 状态展示不同动画反馈
 * - 点击（非拖拽）切换详情面板的展开/收起
 */
export function AgentFloatingOrb({ projectId, selectedChapterId, pageContext, onRefresh }: AgentFloatingOrbProps) {
  const agentHook = useAgentRun();
  const [isOpen, setIsOpen] = useState(false);

  // ── 拖拽状态 ──
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [initialized, setInitialized] = useState(false);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const posStart = useRef({ x: 0, y: 0 });
  const totalDragDist = useRef(0);
  const refreshedRunKeyRef = useRef<string | null>(null);

  const status = agentHook.currentRun?.status;

  useEffect(() => {
    const run = agentHook.currentRun;
    if (!run || run.status !== 'succeeded') return;
    const refreshKey = `${run.id}:${run.updatedAt ?? ''}`;
    if (refreshedRunKeyRef.current === refreshKey) return;
    refreshedRunKeyRef.current = refreshKey;
    void onRefresh?.();
  }, [agentHook.currentRun?.id, agentHook.currentRun?.status, agentHook.currentRun?.updatedAt, onRefresh]);

  // 初始化位置：右下角偏移 2rem
  useEffect(() => {
    setPosition({ x: window.innerWidth - 80, y: window.innerHeight - 80 });
    setInitialized(true);
  }, []);

  // ── 拖拽逻辑 ──

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    totalDragDist.current = 0;
    dragStart.current = { x: e.clientX, y: e.clientY };
    posStart.current = { ...position };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    totalDragDist.current = Math.max(totalDragDist.current, Math.abs(dx) + Math.abs(dy));
    // 限制在视口范围内
    const newX = Math.max(0, Math.min(window.innerWidth - 60, posStart.current.x + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - 60, posStart.current.y + dy));
    setPosition({ x: newX, y: newY });
  }, []);

  const handlePointerUp = useCallback(() => {
    // 移动距离低于阈值则视为点击，切换面板
    if (totalDragDist.current < DRAG_THRESHOLD) {
      setIsOpen((prev) => !prev);
    }
    isDragging.current = false;
  }, []);

  // 面板关闭回调
  const handleClosePanel = useCallback(() => {
    setIsOpen(false);
  }, []);

  if (!initialized) return null;

  return (
    <>
      {/* 悬浮圆球 */}
      <button
        type="button"
        className={`agent-orb ${orbStatusClass(status)}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        aria-label="Agent 工作台"
      >
        {/* 运行时旋转光环 */}
        {isRunningStatus(status) && <span className="agent-orb__ring" />}
        {/* 需要关注时显示通知红点 */}
        {needsAttention(status) && <span className="agent-orb__badge" />}
        {/* 图标 */}
        <span className="agent-orb__icon">🧠</span>
      </button>

      {/* 详情面板 */}
      {isOpen && (
        <AgentFloatingPanel
          projectId={projectId}
          selectedChapterId={selectedChapterId}
          pageContext={pageContext}
          onRefresh={onRefresh}
          onClose={handleClosePanel}
          agentHook={agentHook}
          orbPosition={position}
        />
      )}
    </>
  );
}
