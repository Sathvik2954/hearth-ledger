// All money is integer cents. Parsing works on the digit string, never on a float.

export type CentsResult = { ok: true; cents: number } | { ok: false; error: string }

const AMOUNT_PATTERN = /^(\d*)(?:\.(\d*))?$/

export function parseDollarsToCents(input: string): CentsResult {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '').trim()
  const match = AMOUNT_PATTERN.exec(cleaned)
  const whole = match?.[1] ?? ''
  const fraction = match?.[2] ?? ''
  if (!match || (whole === '' && fraction === '')) {
    return { ok: false, error: 'Enter an amount like 12.50.' }
  }
  if (fraction.length > 2) {
    return { ok: false, error: 'Use at most two decimal places.' }
  }
  const cents = Number(`${whole}${fraction.padEnd(2, '0')}`)
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, error: 'That amount is too large.' }
  }
  if (cents <= 0) {
    return { ok: false, error: 'The amount must be greater than zero.' }
  }
  return { ok: true, cents }
}

const wholeDollars = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

// Exact for any safe integer: splits into whole dollars and cents with integer maths
// instead of formatting cents / 100 as a float.
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const remainder = abs % 100
  const dollars = (abs - remainder) / 100
  return `${sign}$${wholeDollars.format(dollars)}.${String(remainder).padStart(2, '0')}`
}

const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date)
}
