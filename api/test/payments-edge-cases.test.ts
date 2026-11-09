import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { call, createBill, createHome, type Share } from './helpers'

async function setup(memberNames = ['Asha', 'Ben'], totalCents = 1000) {
  const { homeId, members } = await createHome(memberNames)
  const bill = await createBill(homeId, totalCents)
  const [first, second] = bill.body.shares
  if (!first || !second) throw new Error('expected at least two shares')
  return { homeId, members, billId: bill.body.id, shares: bill.body.shares, first, second }
}

function pay(billId: string, shareId: string, headers: Record<string, string> = {}) {
  return call<Share & { error: string }>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers,
  })
}

function payWithKey(billId: string, shareId: string, key: string) {
  return pay(billId, shareId, { 'Idempotency-Key': key })
}

async function storedShare(shareId: string) {
  return env.DB.prepare('SELECT paid_at, idempotency_key FROM shares WHERE id = ?1')
    .bind(shareId)
    .first<{ paid_at: string | null; idempotency_key: string | null }>()
}

async function keyUsage(key: string) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE idempotency_key = ?1')
    .bind(key)
    .first<{ n: number }>()
  return row?.n
}

async function paidShareCount(billId: string) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shares WHERE bill_id = ?1 AND paid_at IS NOT NULL',
  )
    .bind(billId)
    .first<{ n: number }>()
  return row?.n
}

const unpaid = { paid_at: null, idempotency_key: null }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('paying a share', () => {
  it('pays an unpaid share, returns exactly four fields and persists the same values', async () => {
    const { billId, first } = await setup()
    const key = crypto.randomUUID()

    const paid = await payWithKey(billId, first.id, key)

    expect(paid.status).toBe(200)
    expect(paid.body).toEqual({
      id: first.id,
      memberId: first.memberId,
      amountCents: 500,
      paidAt: expect.any(String),
    })
    expect(new Date(paid.body.paidAt ?? '').toISOString()).toBe(paid.body.paidAt)
    expect(await storedShare(first.id)).toEqual({ paid_at: paid.body.paidAt, idempotency_key: key })
  })

  it('stores the key exactly as sent', async () => {
    const { billId, first } = await setup()
    const key = `opaque key/${crypto.randomUUID()}=`

    await payWithKey(billId, first.id, key)

    expect((await storedShare(first.id))?.idempotency_key).toBe(key)
  })

  it.each<{ case: string; headers: Record<string, string> }>([
    { case: 'missing', headers: {} },
    { case: 'empty', headers: { 'Idempotency-Key': '' } },
    { case: 'blank', headers: { 'Idempotency-Key': '   ' } },
    { case: 'oversized', headers: { 'Idempotency-Key': 'k'.repeat(256) } },
  ])('returns 400 for a $case key and leaves the share unpaid', async ({ headers }) => {
    const { billId, first } = await setup()

    const paid = await pay(billId, first.id, headers)

    expect(paid).toEqual({ status: 400, body: { error: expect.any(String) } })
    expect(await storedShare(first.id)).toEqual(unpaid)
  })

  it('replays the original result for the same key and does not pay again', async () => {
    const { billId, first } = await setup()
    const key = crypto.randomUUID()
    const original = await payWithKey(billId, first.id, key)

    const retries = [
      await payWithKey(billId, first.id, key),
      await payWithKey(billId, first.id, key),
    ]

    for (const retry of retries) {
      expect(retry).toEqual({ status: 200, body: original.body })
    }
    expect(await storedShare(first.id)).toEqual({
      paid_at: original.body.paidAt,
      idempotency_key: key,
    })
  })

  it('returns 409 for a different key on a paid share and keeps the original payment', async () => {
    const { billId, first } = await setup()
    const key = crypto.randomUUID()
    const original = await payWithKey(billId, first.id, key)

    const again = await payWithKey(billId, first.id, crypto.randomUUID())

    expect(again).toEqual({ status: 409, body: { error: expect.any(String) } })
    expect(await storedShare(first.id)).toEqual({
      paid_at: original.body.paidAt,
      idempotency_key: key,
    })
  })

  it('returns 409 when the key was already used for another share', async () => {
    const { billId, first, second } = await setup()
    const key = crypto.randomUUID()
    await payWithKey(billId, first.id, key)

    const reused = await payWithKey(billId, second.id, key)

    expect(reused).toEqual({ status: 409, body: { error: expect.any(String) } })
    expect(await storedShare(second.id)).toEqual(unpaid)
    expect(await keyUsage(key)).toBe(1)
  })

  it('treats keys as global across homes', async () => {
    const a = await setup()
    const b = await setup()
    const key = crypto.randomUUID()
    await payWithKey(a.billId, a.first.id, key)

    const reused = await payWithKey(b.billId, b.first.id, key)

    expect(reused.status).toBe(409)
    expect(await storedShare(b.first.id)).toEqual(unpaid)
  })

  it('returns 404 for a missing share, a missing bill, or a share of another bill', async () => {
    const a = await setup()
    const b = await setup()

    const missingShare = await payWithKey(a.billId, 'does-not-exist', crypto.randomUUID())
    const missingBill = await payWithKey('does-not-exist', a.first.id, crypto.randomUUID())
    const wrongBill = await payWithKey(b.billId, a.first.id, crypto.randomUUID())

    expect(missingShare).toEqual({ status: 404, body: { error: 'Share not found' } })
    expect(missingBill).toEqual({ status: 404, body: { error: 'Bill not found' } })
    expect(wrongBill).toEqual({ status: 404, body: { error: 'Share not found' } })
    expect(await storedShare(a.first.id)).toEqual(unpaid)
  })

  it('pays a zero-value share', async () => {
    const { billId, shares } = await setup(['Asha', 'Ben', 'Chitra'], 1)
    const zero = shares[2]
    if (!zero) throw new Error('missing share')

    const paid = await payWithKey(billId, zero.id, crypto.randomUUID())

    expect(paid.status).toBe(200)
    expect(paid.body).toMatchObject({ id: zero.id, amountCents: 0, paidAt: expect.any(String) })
  })

  it('answers an unexpected database error with a generic JSON 500', async () => {
    const { billId, first } = await setup()
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1_ERROR: database is locked: SQLITE_BUSY')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await app.fetch(
      new Request(`http://localhost/api/bills/${billId}/shares/${first.id}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }),
      env,
    )
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toEqual({ error: 'Internal server error' })
    expect(text).not.toMatch(/SQLITE|D1_ERROR/)
    expect(logged).toHaveBeenCalled()
  })
})

describe('concurrent payments', () => {
  it('A: same key, same share - all succeed with one persisted payment', async () => {
    const { billId, first } = await setup()
    const key = crypto.randomUUID()

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => payWithKey(billId, first.id, key)),
    )

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200))
    const paidAts = new Set(responses.map((r) => r.body.paidAt))
    expect(paidAts.size).toBe(1)
    expect(await storedShare(first.id)).toEqual({
      paid_at: responses[0]?.body.paidAt,
      idempotency_key: key,
    })
    expect(await keyUsage(key)).toBe(1)
    expect(await paidShareCount(billId)).toBe(1)
  })

  it('B: different keys, same share - exactly one wins, the rest get 409', async () => {
    const { billId, first } = await setup()
    const keys = Array.from({ length: 8 }, () => crypto.randomUUID())

    const responses = await Promise.all(keys.map((key) => payWithKey(billId, first.id, key)))

    const winners = responses.flatMap((r, i) => (r.status === 200 ? [{ r, key: keys[i] }] : []))
    expect(winners).toHaveLength(1)
    expect(responses.filter((r) => r.status === 409)).toHaveLength(7)
    expect(await storedShare(first.id)).toEqual({
      paid_at: winners[0]?.r.body.paidAt,
      idempotency_key: winners[0]?.key,
    })
    expect(await paidShareCount(billId)).toBe(1)
  })

  it('C: same key, different shares - at most one share is paid', async () => {
    const { billId, first, second } = await setup()
    const key = crypto.randomUUID()

    const responses = await Promise.all([
      payWithKey(billId, first.id, key),
      payWithKey(billId, second.id, key),
    ])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await keyUsage(key)).toBe(1)
    expect(await paidShareCount(billId)).toBe(1)
    const winner = responses.find((r) => r.status === 200)
    expect(await storedShare(winner?.body.id ?? '')).toEqual({
      paid_at: winner?.body.paidAt,
      idempotency_key: key,
    })
  })

  // Promise.all alone does not guarantee that requests overlap between one request's read
  // and its write. This gate forces the worst case: each request's first statement runs,
  // then its result is held until every request's first statement has run. A
  // read-then-write implementation would then have every request see the share unpaid.
  // (Holding before the statement is not enough: D1 may run one request's write before
  // the other released reads.)
  function gateFirstStatements(requestCount: number) {
    const proto: D1PreparedStatement = Object.getPrototypeOf(env.DB.prepare('SELECT 1'))
    const realFirst = proto.first
    let arrived = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(proto, 'first').mockImplementation(async function (
      this: D1PreparedStatement,
      ...args: Parameters<D1PreparedStatement['first']>
    ) {
      const result = await realFirst.apply(this, args)
      arrived += 1
      if (arrived >= requestCount) release()
      await gate
      return result
    })
  }

  it('B, forced overlap: different keys, same share - exactly one wins', async () => {
    const { billId, first } = await setup()
    const keys = Array.from({ length: 6 }, () => crypto.randomUUID())
    gateFirstStatements(keys.length)

    const responses = await Promise.all(keys.map((key) => payWithKey(billId, first.id, key)))

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409])
    expect(await paidShareCount(billId)).toBe(1)
    const winner = responses.findIndex((r) => r.status === 200)
    expect((await storedShare(first.id))?.idempotency_key).toBe(keys[winner])
  })

  it('C, forced overlap: same key, different shares - only one is paid', async () => {
    const { billId, first, second } = await setup()
    const key = crypto.randomUUID()
    gateFirstStatements(2)

    const responses = await Promise.all([
      payWithKey(billId, first.id, key),
      payWithKey(billId, second.id, key),
    ])

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await keyUsage(key)).toBe(1)
    expect(await paidShareCount(billId)).toBe(1)
  })

  it('pays every share once when each member pays concurrently with a retry', async () => {
    const { billId, shares } = await setup(['Asha', 'Ben', 'Chitra', 'Dev'], 1003)
    const keys = shares.map(() => crypto.randomUUID())

    const responses = await Promise.all(
      shares.flatMap((share, i) => {
        const key = keys[i] ?? ''
        return [payWithKey(billId, share.id, key), payWithKey(billId, share.id, key)]
      }),
    )

    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(await paidShareCount(billId)).toBe(4)
  })
})
