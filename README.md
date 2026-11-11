# HearthLedger: Shared Bill Splitter

HearthLedger is a small bill splitter for people who share a home. You create a home, add the people who live there, and add bills. Each bill is split fairly between the members, each member pays their own share, and the page shows who still owes what.

I built it for an SDE internship assignment. I kept the scope small on purpose and focused on making it correct and safe when things go wrong: invalid input, repeated requests, two requests at the same time, and a slow or failing API.

## Stack

- **API:** Hono on Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite), bound as `DB` in `api/wrangler.jsonc`
- **Web:** React, Vite and TanStack Router
- **Language:** TypeScript on both sides, in strict mode, with no `any`
- **Tests:** Vitest, running inside the Workers runtime
- **Quality:** Biome for formatting and linting, `tsc` for type checking

I added no libraries beyond the starter template. Validation, the fetch helper and the styling are plain TypeScript and CSS.

## Features

- **Homes and members:** create a home, choose its currency (INR by default), and add members. The order members join in is stored, because it decides who gets the leftover paise or cents when a bill is split.
- **Bills:** a bill is split between all members of its home. The shares are whole minor units and always add up to the bill total.
- **Payments:** each member pays their own share. Sending the same payment again is safe, and two simultaneous payments of one share cannot both succeed.
- **Balances:** each member's outstanding amount, summed across all of the home's bills.
- **Web page:** one page that shows the bills and shares of a home and lets members pay. It has clear loading, empty and error states, and it keeps working when the API is slow or returns errors.

## API

Every error response is JSON: `{ "error": "message" }`. Malformed JSON is a `400`, invalid fields are a `422`, and unknown routes are a JSON `404`. Unexpected failures return `500 { "error": "Internal server error" }`, so SQL errors and stack traces never reach the client.

Names and bill titles are trimmed, must not be empty, and can be at most 100 characters.

#### `POST /api/homes`

- Request: `{ "name": string, "currency"?: "INR" | "USD" | "EUR" | "GBP" | "AED" }`. Currency defaults to `INR`.
- Success: `201 { id, name }`
- Errors: `422` invalid name or unsupported currency

#### `GET /api/homes/:homeId`

- Success: `200 { id, name, currency }`
- Errors: `404` home not found

#### `POST /api/homes/:homeId/members`

- Request: `{ "name": string }`
- Success: `201 { id, homeId, name }`
- Errors: `404` home not found, `422` invalid name

#### `POST /api/homes/:homeId/bills`

- Request: `{ "title": string, "totalCents": number }`. `totalCents` is in minor units of the home's currency.
- Success: `201 { id, homeId, title, totalCents, shares: [{ id, memberId, amountCents, paidAt: null }] }`
- Errors: `404` home not found. `422` if the title is invalid, the total is not a positive whole number, or the home has no members.

#### `GET /api/homes/:homeId/bills`

- Success: `200 { bills: [{ id, homeId, title, totalCents, shares: [{ id, memberId, memberName, amountCents, paidAt }] }] }`, newest bill first
- Errors: `404` home not found

#### `POST /api/bills/:billId/shares/:shareId/pay`

- Request: header `Idempotency-Key`
- Success: `200 { id, memberId, amountCents, paidAt }`
- Errors:
  - `400`: the key is missing, blank or longer than 255 characters.
  - `404`: the bill or share does not exist.
  - `409`: the share was already paid with a different key, or the key was already used for another share.

#### `GET /api/homes/:homeId/balances`

- Success: `200 { balances: [{ memberId, name, outstandingCents }] }`, members in the order they joined
- Errors: `404` home not found

## Rules

- **Split:** a bill is split between all members of the home, and the shares always add up to `totalCents`. If the total does not divide evenly, the extra minor units go to members one at a time, in the order they joined. For example, 1000 between 3 members gives `334`, `333`, `333`.
- **Pay:** paying marks one share as paid and sets `paidAt`. Repeating the request with the same `Idempotency-Key` returns `200` with the same result and never pays twice. If two requests pay the same share at the same time, only one succeeds.
- **Balances:** `outstandingCents` is the sum of a member's unpaid shares across all of the home's bills.

## Edge cases

| Case                                        | What happens                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A home with no members                      | Creating a bill returns `422`. The page disables the bill form until someone is added.                                                  |
| A total that is zero, negative or not whole | `422`. Decimals are rejected, never rounded. The page also rejects more than two decimal places before sending.                         |
| A total that does not divide evenly         | The first members by join order get one extra minor unit each.                                                                          |
| The same payment sent twice                 | The second request returns `200` with the original result, and the share is paid once.                                                  |
| Two payments of one share at once           | One returns `200` and the other returns `409`, because the payment is a single conditional `UPDATE`.                                    |
| A bill or share that does not exist         | `404` with a JSON error.                                                                                                                |
| The API returns a 500 or is slow            | Requests time out after 10 seconds. The share stays unpaid, a Retry button reuses the same idempotency key, and the page never crashes. |

## Running it locally

This is a pnpm workspace. Install once at the root:

```bash
pnpm install
pnpm dev          # API on :8787 and web on :5173
```

Then open http://localhost:5173. `pnpm dev` applies the migrations to a local D1 database before it starts the API. `/api/health` returns `{ "status": "ok" }`.

```bash
pnpm test         # API and edge-case tests in api/test
pnpm check        # Biome formatting and linting
pnpm check:fix    # apply what Biome can fix
pnpm typecheck    # tsc on both packages
pnpm build        # production build of the web app
```

If pnpm says some build scripts were ignored, run `pnpm approve-builds` and allow `esbuild` and `workerd`.

After changing `api/wrangler.jsonc`, refresh the `Env` types:

```bash
pnpm --filter bill-splitter-api cf-typegen
```

## Tests

The assignment's visible tests are `homes.test.ts`, `bills.test.ts` and `payments.test.ts`, and they pass unchanged, as does `api/test/helpers.ts`. I added tests for:

- input validation and every error response;
- the split rules, including a property test on random totals;
- atomic bill creation, by forcing a failure partway through and checking that nothing was saved;
- idempotent payments, including forced-overlap concurrency tests that a naive read-then-write version fails;
- balances, the bill list, and currency support, including the `0002` migration run against existing data;
- the page's money parsing and formatting.

## Architecture

- **Web (`web/`):** React + Vite, with TanStack Router serving a single page (`src/routes/index.tsx`). All requests go through one helper in `src/lib/api.ts`. It calls relative `/api/*` URLs, which the Vite dev server proxies to the Worker. It also applies a 10-second `AbortController` timeout and checks every response body at runtime. Errors become messages the user can read.
- **API (`api/`):** a Hono app running on Cloudflare Workers (`src/index.ts`). Input validation is in `src/validation.ts` and the pure split function is in `src/split.ts`. Every error, including unknown routes and unexpected failures, is returned as `{ "error": "message" }` from `app.onError` and `app.notFound`. SQL errors and stack traces are logged, never returned.
- **Database:** Cloudflare D1 (SQLite). `api/migrations/0001_init.sql` creates the schema and `0002_home_currency.sql` adds the home currency.
- **Extra endpoint:** `GET /api/homes/:homeId` returns `{ id, name, currency }`. The page uses it to open a home by ID and to format every amount in that home's currency.
- **Extra endpoint:** `GET /api/homes/:homeId/bills` returns `{ bills: [{ id, homeId, title, totalCents, shares: [{ id, memberId, memberName, amountCents, paidAt }] }] }`. The assignment has no endpoint for reading bills back, and the page needs one to show them. The query is a single join, scoped to the home. Bills are listed newest first, with `rowid` breaking ties. Shares follow member order. A missing home returns 404.

## Currencies

Supported currencies are INR, USD, EUR, GBP and AED. Each home has exactly one currency, chosen when the home is created. Every bill, share and balance in that home uses it, and amounts are never converted between currencies.

- `POST /api/homes` accepts an optional `currency`. It is stored, but the response stays exactly the assignment's `{ id, name }`; `GET /api/homes/:homeId` returns the currency. If it is omitted, the home is INR. Anything other than an exact supported code, such as `"inr"`, `"JPY"` or `null`, is a `422`.
- Amounts are integer **minor units** of the home's currency: paise for INR, cents for USD, EUR and GBP, fils for AED. All five have two decimal places, so 1000.50 is stored as `100050`. The fields keep the names `totalCents`, `amountCents` and `outstandingCents` because the assignment's API and tests use those names.
- The page formats amounts with `Intl.NumberFormat`, using the home's stored currency and a fixed locale for each currency, for example `₹1,00,050.00` and `$100,050.00`. It never uses the browser's locale.

## Decisions

### 1. Integer minor units and a deterministic split

All money is a JavaScript safe integer of minor units in the API and an `INTEGER` in SQLite. `CHECK (typeof(...) = 'integer')` rejects anything else. The page converts typed amounts to minor units by parsing the string (`"0.29"` becomes `29`), not by multiplying a float.

`splitEvenly` computes `remainder = total % n` and `base = (total - remainder) / n`. Both are exact on integers, so there is no rounding step. The first `remainder` members, ordered by their stored `position` (insertion order), each get one extra minor unit. For example, 1000 split three ways gives 334, 333, 333.

So every share is a whole number of minor units, shares differ by at most one, and the shares always sum to the bill total. The sum is guaranteed by the algorithm and covered by unit and property tests. No database constraint enforces it.

### 2. Database constraints and atomic bill creation

The schema names every constraint, for example `bills_total_positive_integer`, `shares_bill_member_unique` and `shares_idempotency_key_unique`. A violation therefore names the rule it broke.

Shares carry `home_id` and use composite foreign keys, `(bill_id, home_id)` and `(member_id, home_id)`, which reference `UNIQUE (id, home_id)` keys. The database itself refuses a share that links a bill in one home to a member in another. `shares_paid_state_consistent` makes `paid_at` and `idempotency_key` either both set or both empty.

A bill and all of its shares are inserted in one `DB.batch()`, which D1 runs as a single transaction. If any insert fails, none are kept, so a bill can never exist with missing shares. A test injects a failing statement into the batch and checks that no rows remain.

One limitation: the member list is read just before the batch, so a member added while a bill is being created is not part of that bill.

### 3. Atomic, idempotent payments

Paying a share is one conditional statement:

```sql
UPDATE shares SET paid_at = ?, idempotency_key = ?
WHERE id = ? AND bill_id = ? AND paid_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM shares WHERE idempotency_key = ?)
RETURNING ...
```

A single statement is atomic and D1 runs statements one at a time. So when requests pay the same share concurrently, exactly one can move it from unpaid to paid. There is no separate check-then-write step for another request to slip between, and the code does not use upserts or `INSERT OR REPLACE`.

If no row changed, the API reads the stored share to decide the response:

| Stored state                      | Response                                 |
| --------------------------------- | ---------------------------------------- |
| Paid with this same key           | `200` with the original result (a retry) |
| Paid with a different key         | `409`                                    |
| Key already used on another share | `409`                                    |
| Share or bill does not exist      | `404`                                    |

The `UNIQUE` constraint on the key is a final safeguard. The concurrency tests stall every request after its first database read, so the requests are forced to overlap. A naive read-then-write version fails these tests.

On the page, each share gets one `crypto.randomUUID()` key, stored in `localStorage`. After a timeout, a network error or a 5xx, the outcome is unknown. In that case the share stays unpaid, the button changes to Retry, and the retry sends the same key, even after a page reload. The key is deleted only after a `200`, or when fresh data shows the share as paid. The page never marks a share paid until the server confirms it.

### 4. One currency per home, stored in the database

The currency is a column on `homes`. A named constraint, `homes_currency_supported`, limits it to the five supported codes. Bills, shares and balances inherit it from their home, so a home's amounts cannot mix currencies, and splitting and payments did not change.

Migration `0002` adds the column with `DEFAULT 'INR'` and then sets every existing home to `USD`. Homes created before this change were entered in dollars, so they keep that meaning instead of silently becoming rupees. A test re-runs the real migration against existing rows and checks that their bills, shares and payment state are unchanged. The migration has also been applied to a local development database that already contained data.

The page never guesses the currency. It reads it from `GET /api/homes/:homeId`, and the dashboard is keyed by home ID, so switching homes starts with fresh data. A response with an unknown currency is treated as an error instead of being shown with the wrong symbol.
