import type { ReactNode } from 'react'

export type NoticeTone = 'success' | 'error' | 'info'

type Props = {
  tone: NoticeTone
  children: ReactNode
  onDismiss?: () => void
  action?: { label: string; onClick: () => void }
}

// Errors use role="alert" so screen readers announce them at once; the rest are polite.
export function Notice({ tone, children, onDismiss, action }: Props) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="notice__text">{children}</div>
      {action && (
        <button type="button" className="button button--small" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="notice__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss message"
        >
          ×
        </button>
      )}
    </div>
  )
}
