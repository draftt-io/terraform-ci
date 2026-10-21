import { gzipSync } from 'node:zlib'
import * as core from '@actions/core'
import { parseScanResponse, type ScanResponse } from './contracts.ts'
import { isRecord } from './objects.ts'

const TOTAL_TIMEOUT_MS = 8 * 60 * 1000
const REQUEST_TIMEOUT_MS = 310 * 1000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

const GZIP_THRESHOLD_BYTES = 1024 * 1024
const MAX_RETRY_AFTER_MS = 60_000

// The status and the service's code let the caller tell owner_mismatch, upload_timeout and too_many_scan_keys apart; the Action has no OpError.
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

// The /ci/scans route (https://api.draftt.io/ci/scans). A trailing slash is tolerated; any other path
// (the default /ci/scanTerraformPlan) is not.
export function isScansEndpoint(apiUrl: string): boolean {
  try {
    return new URL(apiUrl).pathname.replace(/\/+$/, '').endsWith('/ci/scans')
  } catch {
    return false
  }
}

// Retry-After as delta-seconds or an HTTP date, capped so one answer cannot stall the job.
export function retryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  return Math.min(milliseconds, MAX_RETRY_AFTER_MS)
}

export async function scanTerraformPlan(
  apiUrl: string,
  apiKey: string,
  body: string,
  // Replaceable only so the tests do not wait the real backoff (up to 1.5 s per exhausted retry).
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<ScanResponse> {
  const endpoint = validateEndpoint(apiUrl)
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  let lastFailure = 'Draftt scan request failed'
  const compress = isScansEndpoint(apiUrl) && Buffer.byteLength(body) > GZIP_THRESHOLD_BYTES
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

      const error = BODY_READ_STATUS.has(response.status) ? await errorBody(response) : {}
      if (response.status === 403 && error.code === 'owner_mismatch') {
        throw new ScanRequestFailure('Draftt CI is bound to a different GitHub organization', 403, 'owner_mismatch')
      }
      if (response.status === 429) retryDelay = retryAfterMs(response.headers.get('retry-after')) ?? retryDelay
      lastFailure = publicStatusMessage(response.status, error)
      retryReason = `Draftt answered ${response.status}`
      // 408 upload_timeout and 422 too_many_scan_keys are final: neither is in RETRYABLE_STATUS.
      const code = response.status === 408 || response.status === 422 ? error.code : undefined
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) throw new ScanRequestFailure(lastFailure, response.status, code)
    } catch (error) {
      if (error instanceof Error && !isRetryableNetworkError(error)) throw error
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      lastFailure = timedOut ? 'Draftt scan request timed out' : 'Draftt scan request failed'
      retryReason = timedOut ? 'Draftt request timed out' : 'Draftt request failed'
      if (attempt === MAX_ATTEMPTS) throw new Error(lastFailure)
    }
    const wait = Math.min(retryDelay, Math.max(0, deadline - Date.now()))
    core.info(`${retryReason}, retrying in ${Math.round(wait / 100) / 10} s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`)
    await (options.sleep ?? delay)(wait)
  }
  throw new Error(lastFailure)
}

// Error bodies are read only for these statuses: 403 for owner_mismatch, 408 and 422 for their
// codes and the service message. Any other status's body is never read, so never echoed.
const BODY_READ_STATUS = new Set([403, 408, 422])
const MAX_SERVICE_MESSAGE_CHARS = 300
// The server's limit of scan keys per commit, which its 422 too_many_scan_keys enforces.
const MAX_SCANS_PER_COMMIT = 50
const TOO_MANY_SCAN_KEYS = `This commit already has ${MAX_SCANS_PER_COMMIT} Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).`

interface ErrorBody {
  code?: string
  message?: string
}

async function errorBody(response: Response): Promise<ErrorBody> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return {}
  }
  if (!isRecord(value)) return {}
  const { code, message } = value
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof message === 'string' && message.trim() !== '' ? { message: message.replace(/\s+/g, ' ').trim().slice(0, MAX_SERVICE_MESSAGE_CHARS) } : {}),
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

function publicStatusMessage(status: number, error: ErrorBody = {}): string {
  if (status === 422 && error.code === 'too_many_scan_keys') return TOO_MANY_SCAN_KEYS
  if ((status === 408 || status === 422) && error.message) return error.message
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
