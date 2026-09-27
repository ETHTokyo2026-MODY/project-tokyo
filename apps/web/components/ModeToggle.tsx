'use client';

import { APP_MODE_LABELS, APP_MODES, type AppMode } from '@/lib/demo/mode';

type Props = {
  mode: AppMode;
  disabled?: boolean;
  onChange: (mode: AppMode) => void;
};

export function ModeToggle({ mode, disabled, onChange }: Props) {
  return (
    <div className="mode-toggle" role="group" aria-label="Data mode">
      {APP_MODES.map((id) => (
        <button
          key={id}
          type="button"
          className={mode === id ? 'on' : undefined}
          aria-pressed={mode === id}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {APP_MODE_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
