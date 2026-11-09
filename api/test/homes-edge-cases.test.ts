import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { call, createHome, type Member } from './helpers'

function postRaw(path: string, body: string) {
  return exports.default.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
}

async function positionsOf(homeId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, position FROM members WHERE home_id = ?1 ORDER BY position',
  )
    .bind(homeId)
    .all<{ id: string; position: number }>()
  return results
}

describe('home and member validation', () => {
  it('trims the name and returns exactly id and name', async () => {
    const home = await call('POST', '/api/homes', { body: { name: '  Flat 4B  ' } })

    expect(home.status).toBe(201)
    expect(home.body).toEqual({ id: expect.any(String), name: 'Flat 4B' })
  })

  it('returns exactly id, homeId and name for a member', async () => {
    const { homeId } = await createHome([])
    const member = await call('POST', `/api/homes/${homeId}/members`, { body: { name: ' Asha ' } })

    expect(member.status).toBe(201)
    expect(member.body).toEqual({ id: expect.any(String), homeId, name: 'Asha' })
  })

  it.each([
    { name: '' },
    { name: '   ' },
    { name: 123 },
    { name: null },
    {},
    { name: 'x'.repeat(101) },
  ])('rejects the home body %j with 422', async (body) => {
    const home = await call<{ error: string }>('POST', '/api/homes', { body })

    expect(home.status).toBe(422)
    expect(home.body.error).toEqual(expect.any(String))
  })

  it('accepts a name of exactly 100 characters', async () => {
    const home = await call('POST', '/api/homes', { body: { name: 'x'.repeat(100) } })

    expect(home.status).toBe(201)
  })

  it.each([{ body: [] }, { body: 'Flat 4B' }, { body: 42 }, { body: null }])(
    'rejects the non-object body $body with 422',
    async ({ body }) => {
      const home = await call('POST', '/api/homes', { body })

      expect(home.status).toBe(422)
    },
  )

  it('rejects an invalid member name with 422', async () => {
    const { homeId } = await createHome([])
    const member = await call('POST', `/api/homes/${homeId}/members`, { body: { name: '  ' } })

    expect(member.status).toBe(422)
  })

  it.each([
    { path: '/api/homes', raw: '{"name": ' },
    { path: '/api/homes/x/members', raw: '{"name": ' },
    { path: '/api/homes', raw: '' },
  ])('rejects malformed JSON $raw on $path with 400', async ({ path, raw }) => {
    const response = await postRaw(path, raw)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: expect.any(String) })
  })

  it('answers a missing home with a JSON 404', async () => {
    const member = await call('POST', '/api/homes/does-not-exist/members', {
      body: { name: 'Asha' },
    })

    expect(member).toEqual({ status: 404, body: { error: expect.any(String) } })
  })

  it('answers an unknown route with a JSON 404', async () => {
    const response = await call('GET', '/api/nope')

    expect(response).toEqual({ status: 404, body: { error: expect.any(String) } })
  })
})

describe('member order', () => {
  it('numbers members 0, 1, 2 in the order they were added', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])

    expect(await positionsOf(homeId)).toEqual(
      members.map((member, position) => ({ id: member.id, position })),
    )
  })

  it('gives every concurrently added member a distinct position', async () => {
    const { homeId } = await createHome([])

    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        call<Member>('POST', `/api/homes/${homeId}/members`, { body: { name: `M${i}` } }),
      ),
    )

    expect(responses.every((response) => response.status === 201)).toBe(true)
    const positions = (await positionsOf(homeId)).map((row) => row.position)
    expect(positions).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it('numbers each home independently', async () => {
    const first = await createHome(['Asha', 'Ben'])
    const second = await createHome(['Chitra'])

    expect((await positionsOf(first.homeId)).map((row) => row.position)).toEqual([0, 1])
    expect((await positionsOf(second.homeId)).map((row) => row.position)).toEqual([0])
  })
})

describe('schema constraints', () => {
  async function seed() {
    const a = await createHome(['Asha', 'Ben'])
    const b = await createHome(['Chitra'])
    const billId = crypto.randomUUID()
    await env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(billId, a.homeId, 'Rent', 1000)
      .run()
    return { a, b, billId }
  }

  function insertShare(values: {
    billId: string
    homeId: string
    memberId: string
    amountCents: number
    paidAt?: string | null
    key?: string | null
  }) {
    return env.DB.prepare(
      `INSERT INTO shares (id, bill_id, home_id, member_id, amount_cents, paid_at, idempotency_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        crypto.randomUUID(),
        values.billId,
        values.homeId,
        values.memberId,
        values.amountCents,
        values.paidAt ?? null,
        values.key ?? null,
      )
      .run()
  }

  it.each([0, -1, 10.5])('rejects a bill total of %j', async (total) => {
    const { a } = await seed()
    const insert = env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(crypto.randomUUID(), a.homeId, 'Rent', total)
      .run()

    await expect(insert).rejects.toThrow(/bills_total_positive_integer/)
  })

  it('accepts a zero share but rejects a negative or fractional one', async () => {
    const { a, billId } = await seed()
    const [asha, ben] = a.members
    if (!asha || !ben) throw new Error('missing members')

    await insertShare({ billId, homeId: a.homeId, memberId: asha.id, amountCents: 0 })
    await expect(
      insertShare({ billId, homeId: a.homeId, memberId: ben.id, amountCents: -1 }),
    ).rejects.toThrow(/shares_amount_non_negative_integer/)
    await expect(
      insertShare({ billId, homeId: a.homeId, memberId: ben.id, amountCents: 1.5 }),
    ).rejects.toThrow(/shares_amount_non_negative_integer/)
  })

  it('rejects a share for a member of another home', async () => {
    const { a, b, billId } = await seed()
    const chitra = b.members[0]
    if (!chitra) throw new Error('missing member')

    await expect(
      insertShare({ billId, homeId: a.homeId, memberId: chitra.id, amountCents: 100 }),
    ).rejects.toThrow(/FOREIGN KEY/)
    await expect(
      insertShare({ billId, homeId: b.homeId, memberId: chitra.id, amountCents: 100 }),
    ).rejects.toThrow(/FOREIGN KEY/)
  })

  it('rejects a second share for the same member and bill', async () => {
    const { a, billId } = await seed()
    const asha = a.members[0]
    if (!asha) throw new Error('missing member')

    await insertShare({ billId, homeId: a.homeId, memberId: asha.id, amountCents: 500 })
    await expect(
      insertShare({ billId, homeId: a.homeId, memberId: asha.id, amountCents: 500 }),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('rejects a half-paid share', async () => {
    const { a, billId } = await seed()
    const asha = a.members[0]
    if (!asha) throw new Error('missing member')

    await expect(
      insertShare({
        billId,
        homeId: a.homeId,
        memberId: asha.id,
        amountCents: 500,
        paidAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/shares_paid_state_consistent/)
  })

  it('rejects reusing an idempotency key on another share', async () => {
    const { a, billId } = await seed()
    const [asha, ben] = a.members
    if (!asha || !ben) throw new Error('missing members')
    const paid = { paidAt: new Date().toISOString(), key: crypto.randomUUID() }

    await insertShare({ billId, homeId: a.homeId, memberId: asha.id, amountCents: 500, ...paid })
    await expect(
      insertShare({ billId, homeId: a.homeId, memberId: ben.id, amountCents: 500, ...paid }),
    ).rejects.toThrow(/UNIQUE/)
  })
})
