import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { parseScanResponse, type ScanResponse } from './contracts.ts'
import { isRecord } from './objects.ts'

const TOTAL_TIMEOUT_MS = 8 * 60 * 1000
const REQUEST_TIMEOUT_MS = 310 * 1000
const MAX_ATTEMPTS = 3
const GZIP_THRESHOLD_BYTES = 1024 * 1024

export async function scanTerraformPlan(apiUrl: string, apiKey: string, body: string): Promise<ScanResponse> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  const compress = Buffer.byteLength(body) > GZIP_THRESHOLD_BYTES
  const payload = compress ? gzipSync(body) : body
  // Only the status or a fixed failure kind is logged, never the backend body or the error detail.
  let lastFailure = 'Draftt scan request failed'
  let retryReason = 'Draftt request failed'
  let attempt = 0

  do {
    if (attempt > 0) {
      const wait = Math.min(attempt * 500, Math.max(0, deadline - Date.now()))
      console.info(`${retryReason}, retrying in ${Math.round(wait / 100) / 10} s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`)
      await delay(wait)
    }
    attempt += 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Draftt scan request timed out')
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          ...(compress ? { 'content-encoding': 'gzip' } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(Math.min(remaining, REQUEST_TIMEOUT_MS)),
      })
      if (response.ok) {
        let value: unknown
        try {
          value = await response.json()
        } catch {
          throw new Error('Draftt returned an invalid JSON response')
        }
        return parseScanResponse(value)
      }

      // A 4xx or 502 message names the reason (for example owner_mismatch or github_unavailable).
      // Other 5xx bodies are never read, so never echoed.
      const showsMessage = (response.status >= 400 && response.status < 500) || response.status === 502
      const serviceMessage = showsMessage ? await errorMessageOf(response) : undefined
      lastFailure = publicStatusMessage(response.status, serviceMessage)
      retryReason = `Draftt answered ${response.status}`
      if (!RETRYABLE_STATUS.has(response.status)) throw new Error(lastFailure)
    } catch (error) {
      if (error instanceof Error && !isRetryableNetworkError(error)) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      lastFailure = timedOut ? 'Draftt scan request timed out' : 'Draftt scan request failed'
      retryReason = timedOut ? 'Draftt request timed out' : 'Draftt request failed'
    }
  } while (attempt < MAX_ATTEMPTS)
  throw new Error(lastFailure)
}

// Gateway answers that a later attempt can clear. A 500 is a server fault and is not retried.
const RETRYABLE_STATUS = new Set([502, 503, 504])
const MAX_SERVICE_MESSAGE_CHARS = 300

async function errorMessageOf(response: Response): Promise<string | undefined> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.message !== 'string' || value.message.trim() === '') return undefined
  return value.message.replace(/\s+/g, ' ').trim().slice(0, MAX_SERVICE_MESSAGE_CHARS)
}

function publicStatusMessage(status: number, serviceMessage: string | undefined): string {
  if (serviceMessage !== undefined) return `Draftt answered ${status}: ${serviceMessage}`
  if (status === 400) return 'Draftt rejected the scan request'
  if (status === 401) return 'Draftt authentication failed'
  if (status === 403) return 'Draftt refused the scan: the API key is not allowed, or Draftt CI is bound to a different GitHub organization'
  if (status === 413) return 'Draftt rejected the scan request as too large'
  if (status >= 500) return 'Draftt could not complete the scan'
  return `Draftt scan request failed with HTTP ${status}`
}

function isRetryableNetworkError(error: Error): boolean {
  return error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError'
}
