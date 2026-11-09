import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { splitEvenly } from './split'
import { readJsonObject, requirePositiveCents, requireText } from './validation'

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
