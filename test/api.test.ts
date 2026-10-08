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

test('gzips bodies over the threshold when the endpoint is /v1/scans and sends smaller bodies plain', async () => {
  const originalFetch = globalThis.fetch
  const seen: Array<{ encoding: string | null; body: unknown }> = []
  globalThis.fetch = async (_input, init) => {
    seen.push({ encoding: new Headers(init?.headers).get('content-encoding'), body: init?.body })
    return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{"plan":{}}', { gzipThresholdBytes: 4 })
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { gzipThresholdBytes: 4 })
    await scanTerraformPlan('https://api.draftt.io/ci/scanTerraformPlan', 'k', '{"plan":{}}', { gzipThresholdBytes: 4 })
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans/', 'k', '{"plan":{}}', { gzipThresholdBytes: 4 })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen[0]?.encoding, 'gzip')
  assert.equal(gunzipSync(seen[0]?.body as Buffer).toString('utf8'), '{"plan":{}}')
  assert.equal(seen[1]?.encoding, null)
  assert.equal(seen[2]?.encoding, null)
  assert.equal(seen[2]?.body, '{"plan":{}}')
  assert.equal(seen[3]?.encoding, 'gzip')
})

test('a 429 waits for Retry-After, capped at 60 s; without the header it keeps attempt * 500 ms', async () => {
  const originalFetch = globalThis.fetch
  const run = async (retryAfter: string | undefined): Promise<number[]> => {
    const sleeps: number[] = []
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls === 1) return new Response('{}', { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
      return new Response(JSON.stringify(scanResponse()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await scanTerraformPlan('https://draftt-ci.draftt.io/v1/scans', 'k', '{}', { sleep: async (ms) => { sleeps.push(ms) } })
    return sleeps
  }
  try {
    assert.deepEqual(await run('30'), [30_000])
    assert.deepEqual(await run('600'), [60_000])
    assert.deepEqual(await run(undefined), [500])
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(retryAfterMs('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 10_000)
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
