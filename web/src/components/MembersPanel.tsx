import { type FormEvent, useState } from 'react'
import { addMember, toApiError } from '../lib/api'
import { type CurrencyCode, formatMoney } from '../lib/money'
import type { Balance } from '../lib/types'
import { Notice } from './Notice'

type Props = {
  homeId: string
  balances: Balance[]
  currency: CurrencyCode
  onMemberAdded: (name: string) => void
}

export function MembersPanel({ homeId, balances, currency, onMemberAdded }: Props) {
  return (
    <section className="card" aria-labelledby="members-heading">
      <h2 id="members-heading">Members &amp; balances</h2>
      {balances.length === 0 ? (
        <p className="empty-text">No members yet. Add the people who share this home.</p>
      ) : (
        <ul className="balance-list">
          {balances.map((balance) => (
            <li key={balance.memberId} className="balance-list__item">
              <span className="avatar" aria-hidden="true">
                {balance.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="balance-list__name">{balance.name}</span>
              {balance.outstandingCents > 0 ? (
                <span className="amount amount--owed">
                  {formatMoney(balance.outstandingCents, currency)}
                  <span className="visually-hidden"> outstanding</span>
                </span>
              ) : (
                <span className="badge badge--paid">Settled</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <AddMemberForm homeId={homeId} onAdded={onMemberAdded} />
    </section>
  )
}

function AddMemberForm({ homeId, onAdded }: { homeId: string; onAdded: (name: string) => void }) {
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter the member’s name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const member = await addMember(homeId, trimmed)
      setName('')
      onAdded(member.name)
    } catch (err) {
      setError(toApiError(err).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="form form--inline" onSubmit={submit} noValidate>
      <label className="field field--grow">
        <span className="field__label">Add a member</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          maxLength={100}
          autoComplete="off"
          aria-invalid={error !== null}
        />
      </label>
      <button type="submit" className="button" disabled={pending}>
        {pending ? 'Adding…' : 'Add'}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  )
}
