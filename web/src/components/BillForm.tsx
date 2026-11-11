import { type FormEvent, type Ref, useState } from 'react'
import { createBill, toApiError } from '../lib/api'
import {
  type CurrencyCode,
  currencySymbol,
  formatMoney,
  parseAmountToMinorUnits,
} from '../lib/money'
import { Notice } from './Notice'

type Props = {
  homeId: string
  currency: CurrencyCode
  memberCount: number
  titleRef: Ref<HTMLInputElement>
  onCreated: (title: string, totalMinorUnits: number) => void
}

export function BillForm({ homeId, currency, memberCount, titleRef, onCreated }: Props) {
  const [title, setTitle] = useState('')
  const [amount, setAmount] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = amount.trim() === '' ? null : parseAmountToMinorUnits(amount, currency)
  const noMembers = memberCount === 0
  const symbol = currencySymbol(currency)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const trimmed = title.trim()
    const total = parseAmountToMinorUnits(amount, currency)
    if (!trimmed) {
      setError('Give the bill a title.')
      return
    }
    if (!total.ok) {
      setError(total.error)
      return
    }
    setPending(true)
    setError(null)
    try {
      await createBill(homeId, trimmed, total.minorUnits)
      setTitle('')
      setAmount('')
      onCreated(trimmed, total.minorUnits)
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
            <span className="field__label">Total ({currency})</span>
            <span className="input-affix">
              <span className="input-affix__symbol" aria-hidden="true">
                {symbol}
              </span>
              <input
                className={`input input--amount ${symbol.length > 1 ? 'input--amount-wide' : ''}`}
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
              ? `${formatMoney(parsed.minorUnits, currency)} split between ${memberCount} member${memberCount === 1 ? '' : 's'}.`
              : `Split equally between ${memberCount} member${memberCount === 1 ? '' : 's'}; any remainder goes to the earliest members.`}
        </p>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" className="button button--primary" disabled={pending || noMembers}>
          {pending ? 'Creating bill…' : 'Create bill'}
        </button>
      </form>
    </section>
  )
}
