// All money is integer minor units (paise, cents, fils) of the home's currency. Parsing works
// on the digit string and formatting on integer parts, never on a float.

// Must match the API's SUPPORTED_CURRENCIES. The locale is fixed per currency (never taken
// from the browser), so a home always shows the same symbol and grouping, e.g. ₹1,00,050.00.
export const CURRENCIES = [
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', locale: 'en-IN' },
  { code: 'USD', name: 'US Dollar', symbol: '$', locale: 'en-US' },
  { code: 'EUR', name: 'Euro', symbol: '€', locale: 'en-IE' },
  { code: 'GBP', name: 'British Pound', symbol: '£', locale: 'en-GB' },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', locale: 'en-AE' },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

export const DEFAULT_CURRENCY: CurrencyCode = 'INR'

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((currency) => currency.code === value)
}

function currencyInfo(code: CurrencyCode) {
  return CURRENCIES.find((currency) => currency.code === code) ?? CURRENCIES[0]
}

// ponytail: every supported currency has 2 minor digits. Add a per-currency digits field
// before supporting one that does not (JPY has 0, KWD has 3).
const MINOR_PER_MAJOR = 100

export type AmountResult = { ok: true; minorUnits: number } | { ok: false; error: string }

const AMOUNT_PATTERN = /^(\d*)(?:\.(\d*))?$/

// "1000" -> 100000, "1000.50" -> 100050, "0.99" -> 99. A leading symbol or code of the
// home's own currency and thousands separators are allowed; anything else is rejected.
export function parseAmountToMinorUnits(input: string, currency: CurrencyCode): AmountResult {
  let cleaned = input.trim()
  for (const marker of [currencyInfo(currency).symbol, currencySymbol(currency), currency]) {
    if (cleaned.startsWith(marker)) {
      cleaned = cleaned.slice(marker.length)
      break
    }
  }
  cleaned = cleaned.replace(/,/g, '').trim()
  const match = AMOUNT_PATTERN.exec(cleaned)
  const whole = match?.[1] ?? ''
  const fraction = match?.[2] ?? ''
  if (!match || (whole === '' && fraction === '')) {
    return { ok: false, error: 'Enter an amount like 12.50.' }
  }
  if (fraction.length > 2) {
    return { ok: false, error: 'Use at most two decimal places.' }
  }
  const minorUnits = Number(`${whole}${fraction.padEnd(2, '0')}`)
  if (!Number.isSafeInteger(minorUnits)) {
    return { ok: false, error: 'That amount is too large.' }
  }
  if (minorUnits <= 0) {
    return { ok: false, error: 'The amount must be greater than zero.' }
  }
  return { ok: true, minorUnits }
}

const formatters = new Map<CurrencyCode, Intl.NumberFormat>()

function formatterFor(currency: CurrencyCode): Intl.NumberFormat {
  let formatter = formatters.get(currency)
  if (!formatter) {
    formatter = new Intl.NumberFormat(currencyInfo(currency).locale, {
      style: 'currency',
      currency,
    })
    formatters.set(currency, formatter)
  }
  return formatter
}

// Exact for any safe integer: Intl formats the whole major units (an exact integer) with the
// currency's symbol and grouping, and the fraction part is replaced by the remainder digits,
// instead of formatting minorUnits / 100 as a float.
export function formatMoney(minorUnits: number, currency: CurrencyCode): string {
  const abs = Math.abs(minorUnits)
  const remainder = abs % MINOR_PER_MAJOR
  const whole = (abs - remainder) / MINOR_PER_MAJOR
  return formatterFor(currency)
    .formatToParts(minorUnits < 0 ? -whole : whole)
    .map((part) => (part.type === 'fraction' ? String(remainder).padStart(2, '0') : part.value))
    .join('')
}

// The symbol Intl uses when formatting amounts, e.g. "₹", "$" or "AED".
export function currencySymbol(currency: CurrencyCode): string {
  const part = formatterFor(currency)
    .formatToParts(0)
    .find((p) => p.type === 'currency')
  return part?.value ?? currency
}

export function currencyLabel(currency: CurrencyCode): string {
  const info = currencyInfo(currency)
  return `${info.name} (${info.code} ${info.symbol})`
}

const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date)
}
