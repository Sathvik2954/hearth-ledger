import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { splitEvenly } from './split'
import {
  readJsonObject,
  requireIdempotencyKey,
  requirePositiveCents,
  requireText,
} from './validation'

type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
}

function toShare(row: ShareRow) {
  return {
    id: row.id,
    memberId: row.member_id,
    amountCents: row.amount_cents,
    paidAt: row.paid_at,
  }
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes('UNIQUE constraint failed: shares.idempotency_key')
  )
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const name = requireText(await readJsonObject(c.req.raw), 'name')
  const id = crypto.randomUUID()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?1, ?2)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const name = requireText(await readJsonObject(c.req.raw), 'name')
  const id = crypto.randomUUID()

  // One statement does the home check, the next-position calculation and the insert.
  // A single SQLite statement is atomic, and D1 runs statements one at a time, so two
  // concurrent inserts cannot read the same MAX(position). If the home does not exist,
  // the SELECT yields no row and nothing is inserted.
  // ponytail: no retry on position conflict. The plain INSERT (no OR REPLACE / upsert)
  // means a collision would fail loudly on members_home_position_unique (500), never
  // overwrite. Add a bounded retry if inserts ever stop being serialized.
  const result = await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, position)
     SELECT ?1, homes.id, ?2,
            COALESCE((SELECT MAX(position) FROM members WHERE home_id = homes.id), -1) + 1
     FROM homes
     WHERE homes.id = ?3`,
  )
    .bind(id, name, homeId)
    .run()

  if (result.meta.changes === 0) {
    return c.json({ error: 'Home not found' }, 404)
  }
  return c.json({ id, homeId, name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body = await readJsonObject(c.req.raw)
  const title = requireText(body, 'title')
  const totalCents = requirePositiveCents(body, 'totalCents')

  // One read answers both questions: no row means no home, a single NULL row means a home
  // without members. Members come back in insertion order (position), never by name or id.
  const { results } = await c.env.DB.prepare(
    `SELECT members.id AS member_id
     FROM homes LEFT JOIN members ON members.home_id = homes.id
     WHERE homes.id = ?1
     ORDER BY members.position`,
  )
    .bind(homeId)
    .all<{ member_id: string | null }>()

  if (results.length === 0) {
    return c.json({ error: 'Home not found' }, 404)
  }
  const memberIds = results.flatMap((row) => (row.member_id === null ? [] : [row.member_id]))
  if (memberIds.length === 0) {
    return c.json({ error: 'Home has no members to split the bill between' }, 422)
  }

  const id = crypto.randomUUID()
  const shares = splitEvenly(totalCents, memberIds).map(({ member, amountCents }) => ({
    id: crypto.randomUUID(),
    memberId: member,
    amountCents,
    paidAt: null,
  }))

  // batch() runs the statements as one transaction: if any insert fails (constraint,
  // foreign key, I/O), all of them roll back and no bill is left without its shares.
  // A member added after the read above is simply not part of this bill.
  const insertShare = c.env.DB.prepare(
    `INSERT INTO shares (id, bill_id, home_id, member_id, amount_cents)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?1, ?2, ?3, ?4)',
    ).bind(id, homeId, title, totalCents),
    ...shares.map((share) =>
      insertShare.bind(share.id, id, homeId, share.memberId, share.amountCents),
    ),
  ])

  return c.json({ id, homeId, title, totalCents, shares }, 201)
})

type BillShareRow = {
  bill_id: string | null
  title: string | null
  total_cents: number | null
  share_id: string | null
  member_id: string | null
  member_name: string | null
  amount_cents: number | null
  paid_at: string | null
}

type BillWithShares = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: {
    id: string
    memberId: string
    memberName: string
    amountCents: number
    paidAt: string | null
  }[]
}

app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  // One joined read: a row per share, starting from the home so a home without bills
  // still yields one all-NULL row (no row at all means no home). Newest bill first;
  // created_at can tie within a millisecond, so rowid (insertion order) breaks ties.
  // Shares follow member insertion order.
  const { results } = await c.env.DB.prepare(
    `SELECT bills.id AS bill_id, bills.title, bills.total_cents,
            shares.id AS share_id, shares.member_id, members.name AS member_name,
            shares.amount_cents, shares.paid_at
     FROM homes
     LEFT JOIN bills ON bills.home_id = homes.id
     LEFT JOIN shares ON shares.bill_id = bills.id
     LEFT JOIN members ON members.id = shares.member_id
     WHERE homes.id = ?1
     ORDER BY bills.created_at DESC, bills.rowid DESC, members.position ASC`,
  )
    .bind(homeId)
    .all<BillShareRow>()

  if (results.length === 0) {
    return c.json({ error: 'Home not found' }, 404)
  }

  // Map keeps the SQL order of first appearance, so bill order is preserved.
  const bills = new Map<string, BillWithShares>()
  for (const row of results) {
    if (row.bill_id === null || row.title === null || row.total_cents === null) continue
    let bill = bills.get(row.bill_id)
    if (!bill) {
      bill = { id: row.bill_id, homeId, title: row.title, totalCents: row.total_cents, shares: [] }
      bills.set(row.bill_id, bill)
    }
    if (
      row.share_id !== null &&
      row.member_id !== null &&
      row.member_name !== null &&
      row.amount_cents !== null
    ) {
      bill.shares.push({
        id: row.share_id,
        memberId: row.member_id,
        memberName: row.member_name,
        amountCents: row.amount_cents,
        paidAt: row.paid_at,
      })
    }
  }

  return c.json({ bills: [...bills.values()] }, 200)
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const key = requireIdempotencyKey(c.req.header('Idempotency-Key'))
  const db = c.env.DB

  // Compare-and-set in one statement: the share must belong to the bill, still be unpaid,
  // and the key must not be on any share yet. A single statement is atomic and D1 runs
  // statements one at a time, so of any number of concurrent requests exactly one can make
  // the unpaid -> paid transition. No read-then-write gap, no upsert, nothing overwritten.
  let paid: ShareRow | null = null
  try {
    paid = await db
      .prepare(
        `UPDATE shares SET paid_at = ?1, idempotency_key = ?2
         WHERE id = ?3 AND bill_id = ?4 AND paid_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM shares WHERE idempotency_key = ?2)
         RETURNING id, member_id, amount_cents, paid_at`,
      )
      .bind(new Date().toISOString(), key, shareId, billId)
      .first<ShareRow>()
  } catch (err) {
    // shares_idempotency_key_unique is the last line of defence; the NOT EXISTS above
    // should make it unreachable. If it fires, the persisted state below decides the
    // answer. Any other database error propagates as a 500.
    if (!isIdempotencyKeyConflict(err)) throw err
  }
  if (paid) {
    return c.json(toShare(paid), 200)
  }

  // Nothing changed. Work out why from the persisted state.
  const share = await db
    .prepare(
      `SELECT id, member_id, amount_cents, paid_at, idempotency_key
       FROM shares WHERE id = ?1 AND bill_id = ?2`,
    )
    .bind(shareId, billId)
    .first<ShareRow & { idempotency_key: string | null }>()

  if (!share) {
    const bill = await db.prepare('SELECT 1 FROM bills WHERE id = ?1').bind(billId).first()
    return c.json({ error: bill ? 'Share not found' : 'Bill not found' }, 404)
  }
  if (share.idempotency_key === key) {
    // A retry (or a concurrent duplicate) of the payment that won: replay the stored result.
    return c.json(toShare(share), 200)
  }
  if (share.paid_at !== null) {
    return c.json({ error: 'Share is already paid with a different Idempotency-Key' }, 409)
  }
  const keyInUse = await db
    .prepare('SELECT 1 FROM shares WHERE idempotency_key = ?1')
    .bind(key)
    .first()
  if (keyInUse) {
    return c.json({ error: 'Idempotency-Key was already used for another share' }, 409)
  }
  // Unpaid share and unused key, yet the update matched nothing: not a client error.
  throw new Error(`Payment of share ${shareId} matched no row in an unexpected state`)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  // Aggregated in SQL. LEFT JOINs keep members with nothing unpaid (COALESCE -> 0); the
  // paid_at IS NULL filter sits in the join condition so it drops shares, not members.
  // No row means no home; a single NULL row means a home without members.
  const { results } = await c.env.DB.prepare(
    `SELECT members.id AS member_id, members.name,
            COALESCE(SUM(shares.amount_cents), 0) AS outstanding_cents
     FROM homes
     LEFT JOIN members ON members.home_id = homes.id
     LEFT JOIN shares ON shares.member_id = members.id
                     AND shares.home_id = homes.id
                     AND shares.paid_at IS NULL
     WHERE homes.id = ?1
     GROUP BY members.id
     ORDER BY members.position`,
  )
    .bind(homeId)
    .all<{ member_id: string | null; name: string | null; outstanding_cents: number }>()

  if (results.length === 0) {
    return c.json({ error: 'Home not found' }, 404)
  }
  const balances = results.flatMap((row) =>
    row.member_id === null || row.name === null
      ? []
      : [{ memberId: row.member_id, name: row.name, outstandingCents: row.outstanding_cents }],
  )
  return c.json({ balances }, 200)
})

app.notFound((c) => c.json({ error: 'Not found' }, 404))

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  // Log details server-side only; clients never see SQL errors or stack traces.
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
