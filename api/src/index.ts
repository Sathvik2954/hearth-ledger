import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { readJsonObject, requireText } from './validation'

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
