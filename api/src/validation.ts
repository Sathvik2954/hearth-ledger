import { HTTPException } from 'hono/http-exception'

export const MAX_NAME_LENGTH = 100

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
