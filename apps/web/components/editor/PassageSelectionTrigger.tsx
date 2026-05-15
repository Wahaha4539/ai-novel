'use client';

import type { FocusEventHandler, MouseEventHandler } from 'react';
import type { PassagePopoverPosition } from './passageSelection';

interface PassageSelectionTriggerProps {
  position?: PassagePopoverPosition;
  open?: boolean;
  onMouseEnter?: MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: MouseEventHandler<HTMLButtonElement>;
  onFocus?: FocusEventHandler<HTMLButtonElement>;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export function PassageSelectionTrigger({
  position,
  open = false,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onClick,
}: PassageSelectionTriggerProps) {
  return (
    <button
      type="button"
      className={open ? 'passage-selection-trigger passage-selection-trigger--open' : 'passage-selection-trigger'}
      style={position ? { position: position.strategy, top: position.top, left: position.left } : undefined}
      aria-label={open ? '隐藏正文选区修订面板' : '打开正文选区修订面板'}
      aria-haspopup="dialog"
      aria-expanded={open}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onClick={onClick}
    >
      <span aria-hidden="true">AI</span>
    </button>
  );
}
