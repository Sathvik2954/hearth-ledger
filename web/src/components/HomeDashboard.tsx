import { useEffect, useRef, useState } from 'react'
import { payShare, toApiError } from '../lib/api'
import { type CurrencyCode, currencyLabel, formatMoney, formatTimestamp } from '../lib/money'
import { forgetPaymentKeys, paymentKeyFor, type SavedHome } from '../lib/storage'
import { useHomeData } from '../lib/useHomeData'
import { BillForm } from './BillForm'
import { BillList, type PaymentState } from './BillList'
import { MembersPanel } from './MembersPanel'
import { Notice, type NoticeTone } from './Notice'

type Props = { home: SavedHome; onSwitchHome: () => void }

type Message = { tone: NoticeTone; text: string }

export function HomeDashboard({ home, onSwitchHome }: Props) {
  const { data, error, loading, reload, applyPaidShare } = useHomeData(home.id)
  const [message, setMessage] = useState<Message | null>(null)
  const [payments, setPayments] = useState<Record<string, PaymentState>>({})
  const inFlight = useRef(new Set<string>())
  const billTitleRef = useRef<HTMLInputElement>(null)

  // Success messages fade on their own; errors stay until dismissed or replaced.
  useEffect(() => {
    if (message?.tone !== 'success') return
    const timer = setTimeout(() => setMessage(null), 5000)
    return () => clearTimeout(timer)
  }, [message])

  // Once the server state shows a share as paid, its idempotency key is no longer needed.
  useEffect(() => {
    if (!data) return
    const paidIds = data.bills.flatMap((bill) =>
      bill.shares.filter((share) => share.paidAt !== null).map((share) => share.id),
    )
    forgetPaymentKeys(paidIds)
  }, [data])

  function setPayment(shareId: string, state: PaymentState | null) {
    setPayments((current) => {
      const next = { ...current }
      if (state) next[shareId] = state
      else delete next[shareId]
      return next
    })
  }

  async function pay(billId: string, shareId: string) {
    if (inFlight.current.has(shareId)) return
    inFlight.current.add(shareId)
    setPayment(shareId, { pending: true, error: null })
    // Same key for every attempt at this share until the payment is confirmed, so a retry
    // after a timeout or a lost response can never pay twice.
    const key = paymentKeyFor(shareId)
    try {
      const paid = await payShare(billId, shareId, key)
      forgetPaymentKeys([shareId])
      applyPaidShare(billId, paid)
      setPayment(shareId, null)
      setMessage({ tone: 'success', text: `Payment recorded ${formatTimestamp(paid.paidAt)}.` })
      reload()
    } catch (err) {
      const apiError = toApiError(err)
      if (apiError.status === 409) {
        setPayment(shareId, null)
        setMessage({
          tone: 'info',
          text: 'That share was already paid by another request. Showing the latest state.',
        })
        reload()
      } else if (apiError.status === 404) {
        setPayment(shareId, null)
        setMessage({ tone: 'error', text: 'That bill or share no longer exists.' })
        reload()
      } else {
        // Network error, timeout or 5xx: the outcome is unknown. Keep the share unpaid
        // and keep the key, so "Retry" repeats the same request.
        setPayment(shareId, {
          pending: false,
          error: `${apiError.message} The payment was not confirmed. Retrying is safe: it cannot pay twice.`,
        })
      }
    } finally {
      inFlight.current.delete(shareId)
    }
  }

  // The server's home record is the source of truth; the saved name only fills the header
  // while it loads.
  const title = data?.home.name ?? home.name ?? 'Your home'

  return (
    <main className="dashboard">
      <header className="dashboard__header">
        <div>
          <p className="eyebrow">Home</p>
          <h1>{title}</h1>
          {data && <p className="home-currency">{currencyLabel(data.home.currency)}</p>}
          <HomeIdLine id={home.id} />
        </div>
        <button type="button" className="button" onClick={onSwitchHome}>
          Switch home
        </button>
      </header>

      <div className="live-region" aria-live="polite">
        {message && (
          <Notice tone={message.tone} onDismiss={() => setMessage(null)}>
            {message.text}
          </Notice>
        )}
      </div>

      {!data && loading && <DashboardSkeleton />}

      {!data && !loading && error && (
        <section className="card state-panel">
          <h2>{error.status === 404 ? 'Home not found' : 'Could not load this home'}</h2>
          <p>
            {error.status === 404
              ? 'No home exists with this ID. It may have been mistyped.'
              : error.message}
          </p>
          <div className="state-panel__actions">
            {error.status !== 404 && (
              <button type="button" className="button button--primary" onClick={reload}>
                Try again
              </button>
            )}
            <button type="button" className="button" onClick={onSwitchHome}>
              Choose another home
            </button>
          </div>
        </section>
      )}

      {data && (
        <>
          {error && (
            <Notice tone="error" action={{ label: 'Retry', onClick: reload }}>
              Could not refresh: {error.message} Showing the last loaded data.
            </Notice>
          )}
          <Summary
            billCount={data.bills.length}
            memberCount={data.balances.length}
            outstandingCents={data.balances.reduce((sum, b) => sum + b.outstandingCents, 0)}
            currency={data.home.currency}
            refreshing={loading}
          />
          <div className="dashboard__grid">
            <div className="dashboard__side">
              <MembersPanel
                homeId={home.id}
                balances={data.balances}
                currency={data.home.currency}
                onMemberAdded={(name) => {
                  setMessage({ tone: 'success', text: `${name} joined the home.` })
                  reload()
                }}
              />
            </div>
            <div className="dashboard__main">
              <BillForm
                homeId={home.id}
                currency={data.home.currency}
                memberCount={data.balances.length}
                titleRef={billTitleRef}
                onCreated={(billTitle, minorUnits) => {
                  setMessage({
                    tone: 'success',
                    text: `“${billTitle}” (${formatMoney(minorUnits, data.home.currency)}) was split between members.`,
                  })
                  reload()
                }}
              />
              <BillList
                bills={data.bills}
                currency={data.home.currency}
                payments={payments}
                canCreate={data.balances.length > 0}
                onPay={pay}
                onCreateFirst={() => billTitleRef.current?.focus()}
              />
            </div>
          </div>
        </>
      )}
    </main>
  )
}

function Summary({
  billCount,
  memberCount,
  outstandingCents,
  currency,
  refreshing,
}: {
  billCount: number
  memberCount: number
  outstandingCents: number
  currency: CurrencyCode
  refreshing: boolean
}) {
  return (
    <section className="summary" aria-label="Summary" aria-busy={refreshing}>
      <div className="summary__item">
        <span className="summary__label">Outstanding</span>
        <span className="summary__value">{formatMoney(outstandingCents, currency)}</span>
      </div>
      <div className="summary__item">
        <span className="summary__label">Bills</span>
        <span className="summary__value">{billCount}</span>
      </div>
      <div className="summary__item">
        <span className="summary__label">Members</span>
        <span className="summary__value">{memberCount}</span>
      </div>
      <span
        className={`refresh-indicator ${refreshing ? 'is-visible' : ''}`}
        aria-hidden={!refreshing}
      >
        Refreshing…
      </span>
    </section>
  )
}

function HomeIdLine({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked: the ID is still selectable text.
    }
  }

  return (
    <p className="home-id">
      ID <code>{id}</code>
      <button type="button" className="link-button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  )
}

function DashboardSkeleton() {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <div className="skeleton__bar skeleton__bar--wide" />
      <div className="dashboard__grid">
        <div className="skeleton__card" />
        <div className="skeleton__card skeleton__card--tall" />
      </div>
      <p className="visually-hidden">Loading bills and balances…</p>
    </div>
  )
}
