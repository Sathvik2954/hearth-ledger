import { type FormEvent, type Ref, useState } from 'react'
import { createBill, toApiError } from '../lib/api'
import { formatCents, parseDollarsToCents } from '../lib/money'
import { Notice } from './Notice'

type Props = {
  homeId: string
  memberCount: number
  titleRef: Ref<HTMLInputElement>
  onCreated: (title: string, totalCents: number) => void
}

export function BillForm({ homeId, memberCount, titleRef, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = amount.trim() === '' ? null : parseDollarsToCents(amount)
  const noMembers = memberCount === 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const trimmed = title.trim()
    const cents = parseDollarsToCents(amount)
    if (!trimmed) {
      setError('Give the bill a title.')
      return
    }
    if (!cents.ok) {
      setError(cents.error)
      return
    }
    setPending(true)
    setError(null)
    try {
      await createBill(homeId, trimmed, cents.cents)
      setTitle('')
      setAmount('')
      onCreated(trimmed, cents.cents)
    } catch (err) {
      setError(toApiError(err).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="card" aria-labelledby="bill-form-heading">
      <h2 id="bill-form-heading">New bill</h2>
      <form className="form" onSubmit={submit} noValidate>
        <div className="form__row">
          <label className="field field--grow">
            <span className="field__label">Title</span>
            <input
              ref={titleRef}
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Electricity"
              maxLength={100}
              autoComplete="off"
              disabled={noMembers}
            />
          </label>
          <label className="field field--amount">
            <span className="field__label">Total (USD)</span>
            <span className="input-affix">
              <span className="input-affix__symbol" aria-hidden="true">
                $
              </span>
              <input
                className="input input--amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                autoComplete="off"
                disabled={noMembers}
                aria-invalid={parsed !== null && !parsed.ok}
                aria-describedby="bill-amount-hint"
              />
            </span>
          </label>
        </div>
        <p id="bill-amount-hint" className="hint">
          {noMembers
            ? 'Add a member before creating a bill.'
            : parsed?.ok
              ? `${formatCents(parsed.cents)} split between ${memberCount} member${memberCount === 1 ? '' : 's'}.`
              : `Split equally between ${memberCount} member${memberCount === 1 ? '' : 's'}; leftover cents go to the earliest members.`}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="button button--primary" disabled={pending || noMembers}>
          {pending ? 'Creating bill…' : 'Create bill'}
        </button>
      </form>
    </section>
  )
}
