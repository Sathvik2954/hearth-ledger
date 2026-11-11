import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'

// Replays the real 0002 migration against a database that already holds data, the way it
// runs on a deployed database: drop the column it adds, insert rows the way the 0001
// schema stored them, apply 0002, and check nothing was lost or reinterpreted.
it('migrates existing homes to USD, keeps their data, and defaults new homes to INR', async () => {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0002_'))
  if (!migration) throw new Error('0002 migration not found')

  await env.DB.prepare('ALTER TABLE homes DROP COLUMN currency').run()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO homes (id, name) VALUES ('old-home', 'Old flat')"),
    env.DB.prepare(
      "INSERT INTO members (id, home_id, name, position) VALUES ('old-m1', 'old-home', 'Asha', 0)",
    ),
    env.DB.prepare(
      "INSERT INTO bills (id, home_id, title, total_cents) VALUES ('old-b1', 'old-home', 'Gas', 1234)",
    ),
    env.DB.prepare(
      `INSERT INTO shares (id, bill_id, home_id, member_id, amount_cents, paid_at, idempotency_key)
       VALUES ('old-s1', 'old-b1', 'old-home', 'old-m1', 1234, '2026-01-01T00:00:00.000Z', 'k')`,
    ),
  ])

  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)))

  const home = await env.DB.prepare(
    "SELECT name, currency FROM homes WHERE id = 'old-home'",
  ).first()
  expect(home).toEqual({ name: 'Old flat', currency: 'USD' })
  const share = await env.DB.prepare(
    "SELECT amount_cents, paid_at, idempotency_key FROM shares WHERE id = 'old-s1'",
  ).first()
  expect(share).toEqual({
    amount_cents: 1234,
    paid_at: '2026-01-01T00:00:00.000Z',
    idempotency_key: 'k',
  })
  const bill = await env.DB.prepare("SELECT total_cents FROM bills WHERE id = 'old-b1'").first()
  expect(bill).toEqual({ total_cents: 1234 })

  await env.DB.prepare("INSERT INTO homes (id, name) VALUES ('new-home', 'New flat')").run()
  const fresh = await env.DB.prepare("SELECT currency FROM homes WHERE id = 'new-home'").first()
  expect(fresh).toEqual({ currency: 'INR' })

  await expect(
    env.DB.prepare("UPDATE homes SET currency = 'XYZ' WHERE id = 'old-home'").run(),
  ).rejects.toThrow(/CHECK constraint failed/)
})
