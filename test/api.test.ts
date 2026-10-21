import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { scanTerraformPlan } from '../src/api.ts'
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
    const result = await scanTerraformPlan('https://api.draftt.io/ci/scans', 'secret-key', '{"plan":{}}')
    assert.equal(result.components.length, 1)
    assert.equal(capturedBody, '{"plan":{}}')
    assert.equal(capturedAuthorization, 'Bearer secret-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('does not include a backend response body in an HTTP error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"message":"sensitive backend detail"}', { status: 400 })
  try {
    await assert.rejects(
      () => scanTerraformPlan('https://api.draftt.io/ci/scans', 'key', '{}'),
      (error: unknown) => error instanceof Error && error.message === 'Draftt rejected the scan request',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('gzips bodies over 1 MiB and sends smaller bodies plain', async () => {
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
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen[0]?.encoding, 'gzip')
  assert.ok(seen[0]?.body instanceof Buffer)
  assert.equal(gunzipSync(seen[0].body).toString('utf8'), large)
  assert.deepEqual(seen.slice(1), [{ encoding: null, body: '{"plan":{}}' }])
})

test('a 5xx answer and a network failure each wait attempt * 500 ms before the next attempt', async () => {
  const originalFetch = globalThis.fetch
  const sleeps: number[] = []
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return new Response('{"status":500,"message":"internal error"}', { status: 500 })
    if (calls === 2) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } })
    assert.equal(result.components.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [500, 1_000])
})

test('client errors are not retried: 401, 403, 413 and 422 pass the service message through, or name the status without one', async () => {
  const cases = [
    { status: 401, body: { status: 401, message: 'invalid api key' }, message: 'Draftt answered 401: invalid api key' },
    { status: 403, body: { status: 403, message: 'owner_mismatch' }, message: 'Draftt answered 403: owner_mismatch' },
    { status: 413, body: { status: 413, message: 'payload_too_large: plan' }, message: 'Draftt answered 413: payload_too_large: plan' },
    { status: 422, body: { status: 422, message: 'invalid_request: github.headSha' }, message: 'Draftt answered 422: invalid_request: github.headSha' },
    { status: 422, body: { message: 3 }, message: 'Draftt scan request failed with HTTP 422' },
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
