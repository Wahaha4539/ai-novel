import React from 'react';
import { GUIDED_STEPS, StepKey } from '../../hooks/useGuidedSession';

interface Props {
  activeStepKey: StepKey;
  completedSteps: Set<string>;
  onStepClick: (stepKey: StepKey) => void;
}

export function DocumentTOC({ activeStepKey, completedSteps, onStepClick }: Props) {
  return (
    <nav className="doc-toc">
      <div
        style={{
          padding: '0 1rem 0.75rem',
          marginBottom: '0.5rem',
          borderBottom: '1px solid var(--border-dim)',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          文档目录
        </div>
      </div>

      {GUIDED_STEPS.map((step) => {
        const isActive = step.key === activeStepKey;
        const isCompleted = completedSteps.has(step.key);

        const itemClass = [
          'doc-toc__item',
          isActive ? 'doc-toc__item--active' : '',
          isCompleted && !isActive ? 'doc-toc__item--completed' : '',
        ]
          .filter(Boolean)
          .join(' ');

        const dotBg = isActive
          ? step.color
          : isCompleted
            ? step.color
            : 'var(--border-light)';

        const dotShadow = isActive ? `0 0 6px ${step.color}66` : 'none';

        return (
          <button
            key={step.key}
            className={itemClass}
            onClick={() => onStepClick(step.key)}
            style={{ width: '100%', textAlign: 'left' }}
          >
            <span
              className="doc-toc__dot"
              style={{ background: dotBg, boxShadow: dotShadow }}
            />
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              {isCompleted && !isActive ? '✓' : step.icon}
              <span>{step.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
