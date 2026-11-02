/**
 * Typed fetch wrapper.
 * Always resolves — never throws. Returns { data } on success, { error } on failure.
 * Handles network errors, non-JSON bodies, and error JSON { "error": string }.
 */

type ApiOk<T> = { data: T; error: null }
type ApiErr = { data: null; error: string }
export type ApiResult<T> = ApiOk<T> | ApiErr

/** Safely extract `{ "error": string }` from an unknown JSON value. */
function errorFromJson(json: unknown, status: number): string {
  if (json !== null && typeof json === 'object' && 'error' in json) {
    const err = (json as { error: unknown }).error
    if (typeof err === 'string') return err
  }
  return `Request failed with HTTP ${status}`
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })

    let json: unknown
    try {
      json = await res.json()
    } catch {
      return { data: null, error: `Server returned non-JSON response (HTTP ${res.status})` }
    }

    if (!res.ok) {
      return { data: null, error: errorFromJson(json, res.status) }
    }

    return { data: json as T, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { data: null, error: msg }
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('POST', path, { body, headers }),
}
