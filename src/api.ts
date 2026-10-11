import { gzipSync } from 'node:zlib'
// GitHub's official toolkit writes the job log.
import * as core from '@actions/core'
import { parseScanResponse, type ScanResponse } from './contracts.ts'

const TOTAL_TIMEOUT_MS = 8 * 60 * 1000
const REQUEST_TIMEOUT_MS = 310 * 1000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

export const GZIP_THRESHOLD_BYTES = 1024 * 1024
export const MAX_RETRY_AFTER_MS = 60_000

export class ScanRequestFailure extends Error {
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(message: string, status?: number, code?: string) {
    super(message)
    this.name = 'ScanRequestFailure'
    this.status = status
    this.code = code
  }
}

// The draftt-ci route. A trailing slash is tolerated; any other path (the ui-backend route) is not.
export function isScansEndpoint(apiUrl: string): boolean {
  try {
    return new URL(apiUrl).pathname.replace(/\/+$/, '').endsWith('/v1/scans')
  } catch {
    return false
  }
}

// Retry-After as delta-seconds or an HTTP date, capped so one answer cannot stall the job.
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS)
}

export async function scanTerraformPlan(
  apiUrl: string,
  apiKey: string,
  body: string,
  options: { gzipThresholdBytes?: number; sleep?: (ms: number) => Promise<void>; info?: (message: string) => void } = {},
): Promise<ScanResponse> {
  const endpoint = validateEndpoint(apiUrl)
  const info = options.info ?? core.info
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  let lastFailure = 'Draftt scan request failed'
  const compress = isScansEndpoint(apiUrl) && Buffer.byteLength(body) > (options.gzipThresholdBytes ?? GZIP_THRESHOLD_BYTES)
  const payload = compress ? gzipSync(body) : body

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let retryDelay = attempt * 500
    // Only the status or a fixed failure kind is logged, never the backend body or the error detail.
    let retryReason = 'Draftt request failed'
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Draftt scan request timed out')
    try {
      const response = await fetch(endpoint, {
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

      if (response.status === 403 && (await errorCode(response)) === 'owner_mismatch') {
        throw new ScanRequestFailure('Draftt CI is bound to a different GitHub organization', 403, 'owner_mismatch')
      }
      if (response.status === 429) retryDelay = retryAfterMs(response.headers.get('retry-after')) ?? retryDelay
      lastFailure = publicStatusMessage(response.status)
      retryReason = `Draftt answered ${response.status}`
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) throw new ScanRequestFailure(lastFailure, response.status)
    } catch (error) {
      if (error instanceof Error && !isRetryableNetworkError(error)) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      lastFailure = timedOut ? 'Draftt scan request timed out' : 'Draftt scan request failed'
      retryReason = timedOut ? 'Draftt request timed out' : 'Draftt request failed'
      if (attempt === MAX_ATTEMPTS) throw new Error(lastFailure)
    }
    const wait = Math.min(retryDelay, Math.max(0, deadline - Date.now()))
    info(`${retryReason}, retrying in ${Math.round(wait / 100) / 10} s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`)
    await (options.sleep ?? delay)(wait)
  }
  throw new Error(lastFailure)
}

// Reads only the code field of an error body; the message is never surfaced except for owner_mismatch.
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string' ? (value as { code: string }).code : undefined
  } catch {
    return undefined
  }
}

function validateEndpoint(value: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('api-url must be a valid URL')
  }
  if (endpoint.protocol !== 'https:') throw new Error('api-url must use HTTPS')
  if (endpoint.username || endpoint.password) throw new Error('api-url must not contain credentials')
  return endpoint
}

function publicStatusMessage(status: number): string {
  if (status === 400) return 'Draftt rejected the scan request'
  if (status === 401 || status === 403) return 'Draftt authentication failed'
  if (status === 413) return 'Draftt rejected the scan request as too large'
  if (status === 429) return 'Draftt rate limited the scan request'
  if (status >= 500) return 'Draftt could not complete the scan'
  return `Draftt scan request failed with HTTP ${status}`
}

function isRetryableNetworkError(error: Error): boolean {
  return error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
