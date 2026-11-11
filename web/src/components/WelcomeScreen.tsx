import { type FormEvent, useState } from 'react'
import { createHome, getHome, toApiError } from '../lib/api'
import {
  CURRENCIES,
  type CurrencyCode,
  currencyLabel,
  DEFAULT_CURRENCY,
  isCurrencyCode,
} from '../lib/money'
import type { SavedHome } from '../lib/storage'
import { Notice } from './Notice'

type Props = { onSelect: (home: SavedHome) => void }

export function WelcomeScreen({ onSelect }: Props) {
  return (
    <main className="welcome">
      <section className="welcome__intro">
        <h1>Split shared bills fairly</h1>
        <p>
          Create a home, add the people who live there, and split each bill exactly. Everyone pays
          their own share.
        </p>
      </section>
      <div className="welcome__forms">
        <CreateHomeForm onCreated={onSelect} />
        <OpenHomeForm onOpened={onSelect} />
      </div>
    </main>
  )
}

function CreateHomeForm({ onCreated }: { onCreated: (home: SavedHome) => void }) {
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the home a name.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const home = await createHome(trimmed, currency)
      onCreated({ id: home.id, name: home.name })
    } catch (err) {
      setError(toApiError(err).message)
      setPending(false)
    }
  }

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>Create a home</h2>
      <label className="field">
        <span className="field__label">Home name</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Flat 4B"
          maxLength={100}
          autoComplete="off"
          aria-invalid={error !== null}
        />
      </label>
      <label className="field">
        <span className="field__label">Currency</span>
        <select
          className="input"
          value={currency}
          onChange={(event) => {
            const next = event.target.value
            if (isCurrencyCode(next)) setCurrency(next)
          }}
        >
          {CURRENCIES.map((option) => (
            <option key={option.code} value={option.code}>
              {currencyLabel(option.code)}
            </option>
          ))}
        </select>
        <span className="hint">Every bill and balance in this home uses this currency.</span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" className="button button--primary" disabled={pending}>
        {pending ? 'Creating…' : 'Create home'}
      </button>
    </form>
  )
}

function OpenHomeForm({ onOpened }: { onOpened: (home: SavedHome) => void }) {
  const [homeId, setHomeId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    const id = homeId.trim()
    if (!id) {
      setError('Paste the ID of an existing home.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const home = await getHome(id)
      onOpened({ id: home.id, name: home.name })
    } catch (err) {
      const apiError = toApiError(err)
      setError(apiError.status === 404 ? 'No home exists with that ID.' : apiError.message)
      setPending(false)
    }
  }

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>Open an existing home</h2>
      <label className="field">
        <span className="field__label">Home ID</span>
        <input
          className="input input--mono"
          value={homeId}
          onChange={(event) => setHomeId(event.target.value)}
          placeholder="e.g. 3f2c…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
        />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" className="button" disabled={pending}>
        {pending ? 'Opening…' : 'Open home'}
      </button>
    </form>
  )
}
