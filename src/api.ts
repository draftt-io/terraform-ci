import { parseScanResponse, type ScanResponse } from './contracts.ts'

const TOTAL_TIMEOUT_MS = 8 * 60 * 1000
const REQUEST_TIMEOUT_MS = 310 * 1000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

export async function scanTerraformPlan(apiUrl: string, apiKey: string, body: string): Promise<ScanResponse> {
  const endpoint = validateEndpoint(apiUrl)
  const deadline = Date.now() + TOTAL_TIMEOUT_MS
  let lastFailure = 'Draftt scan request failed'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Draftt scan request timed out')
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body,
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

      lastFailure = publicStatusMessage(response.status)
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) throw new Error(lastFailure)
    } catch (error) {
      if (error instanceof Error && !isRetryableNetworkError(error)) throw error
      lastFailure = error instanceof Error && error.name === 'TimeoutError'
        ? 'Draftt scan request timed out'
        : 'Draftt scan request failed'
      if (attempt === MAX_ATTEMPTS) throw new Error(lastFailure)
    }
    await delay(attempt * 500)
  }
  throw new Error(lastFailure)
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
