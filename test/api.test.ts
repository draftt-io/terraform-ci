import assert from 'node:assert/strict'
import test from 'node:test'
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
