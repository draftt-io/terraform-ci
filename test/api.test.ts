import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { isScansEndpoint, retryAfterMs, scanTerraformPlan, ScanRequestFailure } from '../src/api.ts'
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

test('isScansEndpoint accepts /v1/scans with or without a trailing slash and nothing else', () => {
  assert.equal(isScansEndpoint('https://draftt-ci.draftt.io/v1/scans'), true)
  assert.equal(isScansEndpoint('https://draftt-ci.draftt.io/v1/scans/'), true)
  assert.equal(isScansEndpoint('https://api.draftt.io/ci/scanTerraformPlan'), false)
  assert.equal(isScansEndpoint('https://draftt-ci.draftt.io/v1/scans/extra'), false)
  assert.equal(isScansEndpoint('not a url'), false)
})

test('gzips bodies over 1 MiB when the endpoint is /v1/scans and sends smaller bodies plain', async () => {
  const originalFetch = globalThis.fetch
  const seen: Array<{ encoding: string | null; body: unknown }> = []
  globalThis.fetch = async (_input, init) => {
    seen.push({ encoding: new Headers(init?.headers).get('content-encoding'), body: init?.body })
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const large = JSON.stringify({ plan: { padding: 'x'.repeat(1024 * 1024) } })
  try {
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', large)
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{"plan":{}}')
    await scanTerraformPlan('https://api.draftt.io/ci/scanTerraformPlan', 'k', large)
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans/', 'k', large)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen[0]?.encoding, 'gzip')
  assert.ok(seen[0]?.body instanceof Buffer)
  assert.equal(gunzipSync(seen[0].body).toString('utf8'), large)
  assert.equal(seen[1]?.encoding, null)
  assert.equal(seen[1]?.body, '{"plan":{}}')
  assert.equal(seen[2]?.encoding, null)
  assert.equal(seen[2]?.body, large)
  assert.equal(seen[3]?.encoding, 'gzip')
})

test('Retry-After is read as seconds or an HTTP date and capped at 60 s', () => {
  assert.equal(retryAfterMs('0'), 0)
  assert.equal(retryAfterMs('30'), 30_000)
  assert.equal(retryAfterMs('600'), 60_000)
  // HTTP dates have whole seconds, so a date 10 s ahead is between 9 and 10 s away.
  const tenSecondsAhead = retryAfterMs(new Date(Date.now() + 10_000).toUTCString())
  assert.ok(tenSecondsAhead !== undefined && tenSecondsAhead > 8_000 && tenSecondsAhead <= 10_000, String(tenSecondsAhead))
  assert.equal(retryAfterMs(new Date(Date.now() + 3_600_000).toUTCString()), 60_000)
  assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), undefined)
  assert.equal(retryAfterMs('soon'), undefined)
  assert.equal(retryAfterMs(null), undefined)
})

test('reports a 403 owner_mismatch with the binding message and does not retry', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"code":"owner_mismatch","message":"Draftt CI is bound to a different GitHub organization"}', { status: 403, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(
      () => scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}'),
      (error: unknown) => error instanceof ScanRequestFailure && error.message === 'Draftt CI is bound to a different GitHub organization' && error.code === 'owner_mismatch' && error.status === 403,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 1)
})

test('a plain 403 is still an authentication failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('forbidden', { status: 403 })
  try {
    await assert.rejects(() => scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}'), /Draftt authentication failed/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('401 and 413 on /v1/scans are not retried and fail with their fixed messages', async () => {
  const cases = [
    { status: 401, message: 'Draftt authentication failed' },
    { status: 413, message: 'Draftt rejected the scan request as too large' },
  ]
  const originalFetch = globalThis.fetch
  try {
    for (const item of cases) {
      let calls = 0
      const sleeps: number[] = []
      globalThis.fetch = async () => {
        calls += 1
        return new Response(JSON.stringify({ code: 'backend_code', message: 'backend body text' }), { status: item.status, headers: { 'content-type': 'application/json' } })
      }
      await assert.rejects(
        () => scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } }),
        (error: unknown) => error instanceof ScanRequestFailure && error.status === item.status && error.message === item.message && error.code === undefined,
      )
      assert.equal(calls, 1, `HTTP ${item.status} must not be retried`)
      assert.deepEqual(sleeps, [], `HTTP ${item.status} must not wait for a retry`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a 429 waits its Retry-After and a 502 waits attempt * 500 ms before the next attempt', async () => {
  const originalFetch = globalThis.fetch
  const sleeps: number[] = []
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
    if (calls === 2) return new Response('{}', { status: 502 })
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } })
    assert.equal(result.summary.hasPolicyViolations, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [0, 1_000])
})

test('a network failure is retried after attempt * 500 ms', async () => {
  const originalFetch = globalThis.fetch
  const sleeps: number[] = []
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [500])
})

test('408 and 422 are not retried and report the service or the Action message', async () => {
  const cases = [
    {
      status: 408,
      body: { code: 'upload_timeout', message: 'The upload did not finish within 240 s; send the body gzip-compressed' },
      message: 'The upload did not finish within 240 s; send the body gzip-compressed',
      code: 'upload_timeout',
    },
    {
      status: 422,
      body: { code: 'too_many_scan_keys', message: 'This commit already has 50 Draftt scan keys' },
      message: 'This commit already has 50 Draftt CI scans, the most Draftt CI accepts per commit (one per terraform-root).',
      code: 'too_many_scan_keys',
    },
    { status: 422, body: { code: 'other_rule', message: 'A service sentence' }, message: 'A service sentence', code: 'other_rule' },
    { status: 408, body: 'Request Timeout', message: 'Draftt scan request failed with HTTP 408', code: undefined },
    { status: 422, body: { code: 7, message: 3 }, message: 'Draftt scan request failed with HTTP 422', code: undefined },
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
        () => scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } }),
        (error: unknown) => {
          assert.ok(error instanceof ScanRequestFailure)
          assert.deepEqual({ status: error.status, code: error.code, message: error.message }, { status: item.status, code: item.code, message: item.message })
          return true
        },
      )
      assert.equal(calls, 1, `HTTP ${item.status} must not be retried`)
      assert.deepEqual(sleeps, [])
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a backend message is never passed through for other statuses', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const status of [400, 404, 409, 413]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code: 'x', message: 'planted-backend-body' }), { status })
      await assert.rejects(
        () => scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async () => {} }),
        (error: unknown) => error instanceof Error && !error.message.includes('planted-backend-body'),
      )
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
