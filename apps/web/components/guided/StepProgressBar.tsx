import React from 'react';
import { GUIDED_STEPS } from '../../hooks/useGuidedSession';

interface Props {
  currentStepIndex: number;
  onStepClick?: (index: number) => void;
}

export function StepProgressBar({ currentStepIndex, onStepClick }: Props) {
  return (
    <div
      className="flex items-center shrink-0"
      style={{
        padding: '0.75rem 2rem',
        borderBottom: '1px solid var(--border-dim)',
        background: 'var(--bg-card)',
        gap: '0.25rem',
        overflowX: 'auto',
      }}
    >
      {GUIDED_STEPS.map((step, index) => {
        const isActive = index === currentStepIndex;
        const isCompleted = index < currentStepIndex;
        const isClickable = index <= currentStepIndex && onStepClick;

        return (
          <React.Fragment key={step.key}>
            {index > 0 && (
              <div
                style={{
                  width: '1.5rem',
                  height: '2px',
                  background: isCompleted ? step.color : 'var(--border-dim)',
                  transition: 'background 0.3s ease',
                  flexShrink: 0,
                }}
              />
            )}
            <button
              onClick={() => isClickable && onStepClick(index)}
              disabled={!isClickable}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.35rem 0.65rem',
                borderRadius: '0.5rem',
                border: isActive ? `1px solid ${step.color}` : '1px solid transparent',
                background: isActive ? `${step.color}18` : isCompleted ? `${step.color}0a` : 'transparent',
                color: isActive ? step.color : isCompleted ? step.color : 'var(--text-dim)',
                fontSize: '0.7rem',
                fontWeight: isActive ? 600 : 400,
                cursor: isClickable ? 'pointer' : 'default',
                transition: 'all 0.3s ease',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                opacity: !isActive && !isCompleted ? 0.5 : 1,
              }}
            >
              <span style={{ fontSize: '0.85rem' }}>{isCompleted ? '✓' : step.icon}</span>
              {step.label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
