import { describe, expect, it } from 'vitest'
import { splitEvenly } from '../src/split'

function amounts(totalCents: number, memberCount: number) {
  const members = Array.from({ length: memberCount }, (_, i) => `m${i}`)
  return splitEvenly(totalCents, members).map((share) => share.amountCents)
}

describe('splitEvenly', () => {
  it.each([
    { total: 1000, count: 3, expected: [334, 333, 333] },
    { total: 1000, count: 4, expected: [250, 250, 250, 250] },
    { total: 1001, count: 3, expected: [334, 334, 333] },
    { total: 10, count: 3, expected: [4, 3, 3] },
    { total: 1, count: 3, expected: [1, 0, 0] },
    { total: 7, count: 2, expected: [4, 3] },
    { total: 4999, count: 1, expected: [4999] },
    { total: 0, count: 2, expected: [0, 0] },
  ])('splits $total between $count members as $expected', ({ total, count, expected }) => {
    expect(amounts(total, count)).toEqual(expected)
  })

  it('keeps the members in the given order, one share each', () => {
    const shares = splitEvenly(5, ['zed', 'asha', 'mo'])

    expect(shares).toEqual([
      { member: 'zed', amountCents: 2 },
      { member: 'asha', amountCents: 2 },
      { member: 'mo', amountCents: 1 },
    ])
  })

  it('stays exact at the largest safe integer', () => {
    const shares = amounts(Number.MAX_SAFE_INTEGER, 7)

    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(Number.MAX_SAFE_INTEGER)
    expect(shares.every(Number.isSafeInteger)).toBe(true)
  })

  it('always sums to the total, differs by at most 1, and front-loads the extra cents', () => {
    for (let run = 0; run < 500; run++) {
      const total = Math.floor(Math.random() * 1_000_000)
      const count = 1 + Math.floor(Math.random() * 20)

      const shares = amounts(total, count)

      expect(shares).toHaveLength(count)
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(total)
      expect(shares.every((share) => Number.isInteger(share) && share >= 0)).toBe(true)
      expect(shares).toEqual([...shares].sort((a, b) => b - a))
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
    }
  })

  it.each([-1, 1.5, Number.NaN, 2 ** 53])('rejects the total %j', (total) => {
    expect(() => splitEvenly(total, ['a'])).toThrow(RangeError)
  })

  it('rejects an empty member list', () => {
    expect(() => splitEvenly(100, [])).toThrow(RangeError)
  })
})
