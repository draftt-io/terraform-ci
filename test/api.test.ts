import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { retryAfterMs, scanTerraformPlan } from '../src/api.ts'
import { scanResponse } from './fixtures.ts'

test('sends the scrubbed request with bearer authentication and parses the response', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody: string | undefined
  let capturedAuthorization: string | null | undefined
  globalThis.fetch = async (_input, init) => {
    capturedBody = typeof init?.body === 'string' ? init.body : undefined
    capturedAuthorization = new Headers(init?.headers).get('authorization')
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await scanTerraformPlan('https://api.draftt.io/ci/scanTerraformPlan', 'secret-key', '{"plan":{}}')
    assert.equal(result.summary.hasPolicyViolations, true)
    assert.equal(capturedBody, '{"plan":{}}')
    assert.equal(capturedAuthorization, 'Bearer secret-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects insecure or credential-bearing API URLs before making a request', async () => {
  await assert.rejects(() => scanTerraformPlan('http://api.draftt.io/ci/scanTerraformPlan', 'key', '{}'), /must use HTTPS/)
  await assert.rejects(() => scanTerraformPlan('https://user:password@api.draftt.io/ci/scanTerraformPlan', 'key', '{}'), /must not contain credentials/)
})

test('does not include a backend response body in an HTTP error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"message":"sensitive backend detail"}', { status: 400 })
  try {
    await assert.rejects(
      () => scanTerraformPlan('https://api.draftt.io/ci/scanTerraformPlan', 'key', '{}'),
      (error: unknown) => error instanceof Error && error.message === 'Draftt rejected the scan request',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('gzips bodies over 1 MiB when the endpoint is /ci/scans and sends smaller bodies plain', async () => {
  const originalFetch = globalThis.fetch
  const seen: Array<{ encoding: string | null; body: unknown }> = []
  globalThis.fetch = async (_input, init) => {
    seen.push({ encoding: new Headers(init?.headers).get('content-encoding'), body: init?.body })
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const large = JSON.stringify({ plan: { padding: 'x'.repeat(1024 * 1024) } })
  try {
    await scanTerraformPlan('https://ci.example.test/ci/scans', 'k', large)
    await scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{"plan":{}}')
    await scanTerraformPlan('https://api.draftt.io/ci/scanTerraformPlan', 'k', large)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen[0]?.encoding, 'gzip')
  assert.ok(seen[0]?.body instanceof Buffer)
  assert.equal(gunzipSync(seen[0].body).toString('utf8'), large)
  assert.deepEqual(seen.slice(1), [{ encoding: null, body: '{"plan":{}}' }, { encoding: null, body: large }])
})

test('Retry-After is read as seconds or an HTTP date and capped at 60 s', () => {
  assert.equal(retryAfterMs('30'), 30_000)
  assert.equal(retryAfterMs('600'), 60_000)
  assert.equal(retryAfterMs(new Date(Date.now() + 3_600_000).toUTCString()), 60_000)
  for (const value of ['soon', null, new Date(Date.now() - 60_000).toUTCString()]) assert.equal(retryAfterMs(value), undefined, String(value))
})

test('a 429 waits its Retry-After and a network failure waits attempt * 500 ms before the next attempt', async () => {
  const originalFetch = globalThis.fetch
  const sleeps: number[] = []
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
    if (calls === 2) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } })
    assert.equal(result.summary.hasPolicyViolations, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [0, 1_000])
})

test('client errors are not retried: fixed messages for 401, a plain 403 and 413; a 422 passes the service sentence through or names the status', async () => {
  const planted = { code: 'backend_code', message: 'planted-backend-body' }
  const cases = [
    { status: 401, body: planted, message: 'Draftt authentication failed' },
    { status: 403, body: 'forbidden', message: 'Draftt authentication failed' },
    { status: 413, body: planted, message: 'Draftt rejected the scan request as too large' },
    { status: 422, body: { code: 'other_rule', message: 'A service sentence' }, message: 'A service sentence' },
    { status: 422, body: { code: 7, message: 3 }, message: 'Draftt scan request failed with HTTP 422' },
  ]
  const originalFetch = globalThis.fetch
  try {
    for (const item of cases) {
      let calls = 0
      const sleeps: number[] = []
      globalThis.fetch = async () => {
        calls += 1
        return new Response(typeof item.body === 'string' ? item.body : JSON.stringify(item.body), { status: item.status })
      }
      await assert.rejects(
        () => scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } }),
        (error: unknown) => error instanceof Error && error.message === item.message,
      )
      assert.equal(calls, 1, `HTTP ${item.status} must not be retried`)
      assert.deepEqual(sleeps, [])
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
