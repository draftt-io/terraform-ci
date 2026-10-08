import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { CheckAnnotation } from '../src/github-check.ts'

interface RecordedRequest {
  method: string
  url: string
  body: Record<string, unknown>
}

// @actions/github fixes its API base URL when the module loads, so this file points it at a
// local server before importing the publisher. Each test file runs in its own process.
const requests: RecordedRequest[] = []
const server = createServer((request, response) => {
  void readBody(request).then((body) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', body })
    response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: 77, html_url: 'https://github.com/o/r/runs/77' }))
  })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) delete process.env[name]
process.env.GITHUB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
process.env.GITHUB_REPOSITORY = 'o/r'
const { CheckPublisher, FALLBACK_CHECK_NAME } = await import('../src/github-check.ts')

test.after(() => {
  server.close()
})

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
}

function annotations(count: number): CheckAnnotation[] {
  return Array.from({ length: count }, (_, index) => ({
    path: 'main.tf',
    start_line: index + 1,
    end_line: index + 1,
    annotation_level: 'failure',
    message: `Finding ${index}`,
    title: 'Draftt policy violation',
  }))
}

test('publishCompleted creates one completed check under its name, then sends the remaining annotation batches', async () => {
  requests.length = 0
  const publisher = new CheckPublisher('token', 'a'.repeat(40), FALLBACK_CHECK_NAME)
  await publisher.publishCompleted('failure', 'One violation', 'Summary', annotations(51))

  assert.deepEqual(requests.map((r) => [r.method, r.url]), [['POST', '/repos/o/r/check-runs'], ['PATCH', '/repos/o/r/check-runs/77']])
  const [create, update] = requests
  assert.ok(create && update)
  assert.equal(create.body.name, 'Draftt Terraform Policy Scan (Action)')
  assert.equal(create.body.head_sha, 'a'.repeat(40))
  assert.equal(create.body.status, 'completed')
  assert.equal(create.body.conclusion, 'failure')
  const createOutput = create.body.output as { title: string; summary: string; annotations: unknown[] }
  assert.deepEqual([createOutput.title, createOutput.summary, createOutput.annotations.length], ['One violation', 'Summary', 50])
  const updateOutput = update.body.output as { title: string; summary: string; annotations: unknown[] }
  assert.deepEqual([updateOutput.title, updateOutput.summary, updateOutput.annotations.length], ['One violation', 'Summary', 1])
  assert.equal(update.body.status, undefined)
  assert.equal(publisher.annotationCount, 51)
  assert.equal(publisher.checkRunUrl, 'https://github.com/o/r/runs/77')
})

test('publishCompleted with no annotations is a single create, and start keeps the in-progress v0.1.1 shape', async () => {
  requests.length = 0
  const errorCheck = new CheckPublisher('token', 'b'.repeat(40), FALLBACK_CHECK_NAME)
  await errorCheck.publishCompleted('neutral', 'Terraform policy scan could not complete', 'Error', [])
  assert.equal(requests.length, 1)
  assert.deepEqual((requests[0]?.body.output as { annotations: unknown[] }).annotations, [])
  assert.equal(errorCheck.annotationCount, 0)

  requests.length = 0
  const legacy = new CheckPublisher('token', 'c'.repeat(40))
  await legacy.start()
  assert.equal(requests[0]?.body.name, 'Draftt Terraform Policy Scan')
  assert.equal(requests[0]?.body.status, 'in_progress')
  assert.equal(legacy.checkRunUrl, 'https://github.com/o/r/runs/77')
})
