import { HTTPException } from 'hono/http-exception'

export const MAX_NAME_LENGTH = 100
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255

type JsonObject = Record<string, unknown>

// Throws 400 on malformed JSON and 422 when the body is valid JSON but not an object.
// The HTTPException message becomes the `{ error }` body via app.onError.
export async function readJsonObject(request: Request): Promise<JsonObject> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HTTPException(400, { message: 'Request body must be valid JSON' })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HTTPException(422, { message: 'Request body must be a JSON object' })
  }
  return body as JsonObject
}

// Returns the trimmed string, or throws 422.
export function requireText(body: JsonObject, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new HTTPException(422, { message: `${field} must be a string` })
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new HTTPException(422, { message: `${field} must not be empty` })
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new HTTPException(422, {
      message: `${field} must be at most ${MAX_NAME_LENGTH} characters`,
    })
  }
  return trimmed
}

// Returns a positive whole number of cents, or throws 422. Decimals are rejected, never
// rounded. Unsafe integers are rejected because JSON parsing may already have lost precision.
export function requirePositiveCents(body: JsonObject, field: string): number {
  const value = body[field]
  if (typeof value !== 'number') {
    throw new HTTPException(422, { message: `${field} must be a number` })
  }
  if (!Number.isSafeInteger(value)) {
    throw new HTTPException(422, { message: `${field} must be a whole number of cents` })
  }
  if (value <= 0) {
    throw new HTTPException(422, { message: `${field} must be greater than zero` })
  }
  return value
}

// Must match the homes_currency_supported CHECK in migrations/0002_home_currency.sql.
export const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED'] as const
export type Currency = (typeof SUPPORTED_CURRENCIES)[number]
export const DEFAULT_CURRENCY: Currency = 'INR'

function isCurrency(value: unknown): value is Currency {
  return SUPPORTED_CURRENCIES.some((code) => code === value)
}

// Optional: an omitted currency is INR. Anything else must be an exact supported code
// (case-sensitive, as ISO 4217 codes are), or the request is a 422.
export function optionalCurrency(body: JsonObject, field: string): Currency {
  const value = body[field]
  if (value === undefined) return DEFAULT_CURRENCY
  if (!isCurrency(value)) {
    throw new HTTPException(422, {
      message: `${field} must be one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    })
  }
  return value
}

// The key is an opaque client token: returned unchanged (never trimmed or replaced),
// but a missing, blank or oversized key is a 400.
export function requireIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new HTTPException(400, { message: 'Idempotency-Key header is required' })
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new HTTPException(400, {
      message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    })
  }
  return value
}
