import { describe, expect, it } from 'vitest'
// The web package has no test runner, and adding one would mean new dependencies. Its money
// helpers are pure functions, so they are tested here, in the suite that `pnpm test` runs.
import {
  CURRENCIES,
  currencyLabel,
  currencySymbol,
  DEFAULT_CURRENCY,
  formatMoney,
  isCurrencyCode,
  parseAmountToMinorUnits,
} from '../../web/src/lib/money'
import { DEFAULT_CURRENCY as API_DEFAULT, SUPPORTED_CURRENCIES } from '../src/validation'

describe('web currency list', () => {
  it('matches the API and defaults to INR on both sides', () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual([...SUPPORTED_CURRENCIES])
    expect(DEFAULT_CURRENCY).toBe('INR')
    expect(API_DEFAULT).toBe('INR')
    expect(CURRENCIES[0]?.code).toBe('INR')
  })

  it('labels each option with its name, code and symbol', () => {
    expect(CURRENCIES.map((c) => currencyLabel(c.code))).toEqual([
      'Indian Rupee (INR ₹)',
      'US Dollar (USD $)',
      'Euro (EUR €)',
      'British Pound (GBP £)',
      'UAE Dirham (AED د.إ)',
    ])
  })

  it('accepts only exact supported codes', () => {
    expect(isCurrencyCode('INR')).toBe(true)
    for (const value of ['inr', 'JPY', '', null, 356, undefined]) {
      expect(isCurrencyCode(value)).toBe(false)
    }
  })
})

describe('formatMoney', () => {
  it.each([
    ['INR', '₹1,00,050.00', '₹0.99'],
    ['USD', '$100,050.00', '$0.99'],
    ['EUR', '€100,050.00', '€0.99'],
    ['GBP', '£100,050.00', '£0.99'],
    // Intl joins "AED" and the number with a no-break space (U+00A0).
    ['AED', 'AED\u00a0100,050.00', 'AED\u00a00.99'],
  ] as const)('formats %s with its own symbol and grouping', (currency, large, small) => {
    expect(formatMoney(10005000, currency)).toBe(large)
    expect(formatMoney(99, currency)).toBe(small)
    expect(formatMoney(0, currency)).toBe(small.replace('0.99', '0.00'))
  })

  it('never shows a dollar sign for a non-USD home', () => {
    for (const currency of ['INR', 'EUR', 'GBP', 'AED'] as const) {
      expect(formatMoney(123456, currency)).not.toContain('$')
      expect(currencySymbol(currency)).not.toContain('$')
    }
  })

  it('is exact up to the largest safe integer', () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'INR')).toBe('₹9,00,71,99,25,47,409.91')
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91')
    expect(formatMoney(29, 'GBP')).toBe('£0.29')
    expect(formatMoney(115, 'EUR')).toBe('€1.15')
  })

  it('keeps each currency separate when formatting alternates between homes', () => {
    expect(formatMoney(1000, 'INR')).toBe('₹10.00')
    expect(formatMoney(1000, 'USD')).toBe('$10.00')
    expect(formatMoney(1000, 'INR')).toBe('₹10.00')
    expect(formatMoney(1000, 'AED')).toBe('AED\u00a010.00')
    expect(formatMoney(1000, 'INR')).toBe('₹10.00')
  })

  it('exposes the prefix used by the amount input', () => {
    expect(
      ['INR', 'USD', 'EUR', 'GBP', 'AED'].map((c) => isCurrencyCode(c) && currencySymbol(c)),
    ).toEqual(['₹', '$', '€', '£', 'AED'])
  })
})

describe('parseAmountToMinorUnits', () => {
  it.each([
    ['1000', 100000],
    ['1000.50', 100050],
    ['0.99', 99],
    ['1000.5', 100050],
    ['1,00,050.00', 10005000],
    ['₹1,000', 100000],
    ['INR 25', 2500],
    ['  12.30  ', 1230],
    ['.5', 50],
    ['5.', 500],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %j in INR as %d minor units', (input, minorUnits) => {
    expect(parseAmountToMinorUnits(input, 'INR')).toEqual({ ok: true, minorUnits })
  })

  it('accepts each currency’s own symbol', () => {
    expect(parseAmountToMinorUnits('$10', 'USD')).toEqual({ ok: true, minorUnits: 1000 })
    expect(parseAmountToMinorUnits('€10', 'EUR')).toEqual({ ok: true, minorUnits: 1000 })
    expect(parseAmountToMinorUnits('£10', 'GBP')).toEqual({ ok: true, minorUnits: 1000 })
    expect(parseAmountToMinorUnits('AED 10', 'AED')).toEqual({ ok: true, minorUnits: 1000 })
    expect(parseAmountToMinorUnits('د.إ10', 'AED')).toEqual({ ok: true, minorUnits: 1000 })
  })

  it.each([
    ['0', 'The amount must be greater than zero.'],
    ['0.00', 'The amount must be greater than zero.'],
    ['-5', 'Enter an amount like 12.50.'],
    ['10.255', 'Use at most two decimal places.'],
    ['0.999', 'Use at most two decimal places.'],
    ['90071992547409.92', 'That amount is too large.'],
    ['1e3', 'Enter an amount like 12.50.'],
    ['abc', 'Enter an amount like 12.50.'],
    ['', 'Enter an amount like 12.50.'],
    ['.', 'Enter an amount like 12.50.'],
    ['1.2.3', 'Enter an amount like 12.50.'],
    ['$10', 'Enter an amount like 12.50.'],
  ])('rejects %j in INR', (input, error) => {
    expect(parseAmountToMinorUnits(input, 'INR')).toEqual({ ok: false, error })
  })
})
