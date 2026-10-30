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

test('a 500 answer is final and its body is never shown', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{"message":"sensitive backend detail"}', { status: 500 })
  }
  try {
    await assert.rejects(
      () => scanTerraformPlan('https://api.draftt.io/ci/scans', 'key', '{}'),
      (error: unknown) => error instanceof Error && error.message === 'Draftt could not complete the scan',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 1)
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

test('a 503 answer and a network failure are retried until the third attempt succeeds', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return new Response('Service Unavailable', { status: 503 })
    if (calls === 2) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{}')
    assert.equal(result.components.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls, 3)
})

test('4xx and 502 answers pass the service message through, or name the status without one; only 502 is retried', async () => {
  const cases = [
    { status: 400, body: { status: 400, message: 'invalid_json' }, message: 'Draftt answered 400: invalid_json', calls: 1 },
    { status: 403, body: { status: 403, message: 'owner_mismatch' }, message: 'Draftt answered 403: owner_mismatch', calls: 1 },
    { status: 413, body: { status: 413, message: 'payload_too_large: the request body exceeds 50 MiB' }, message: 'Draftt answered 413: payload_too_large: the request body exceeds 50 MiB', calls: 1 },
    { status: 422, body: { message: 'Validation Failed', details: { 'body.plan': {} } }, message: 'Draftt answered 422: Validation Failed', calls: 1 },
    { status: 422, body: { message: 3 }, message: 'Draftt scan request failed with HTTP 422', calls: 1 },
    { status: 502, body: { status: 502, message: 'github_unavailable' }, message: 'Draftt answered 502: github_unavailable', calls: 3 },
  ]
  const originalFetch = globalThis.fetch
  try {
    for (const item of cases) {
      let calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return new Response(typeof item.body === 'string' ? item.body : JSON.stringify(item.body), { status: item.status })
      }
      await assert.rejects(
        () => scanTerraformPlan('https://ci.example.test/ci/scans', 'k', '{}'),
        (error: unknown) => error instanceof Error && error.message === item.message,
      )
      assert.equal(calls, item.calls, `HTTP ${item.status} is sent ${item.calls} time(s)`)
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
