import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { ScanResponse } from '../src/contracts.ts'
import { isRecord } from '../src/objects.ts'
import { buildScanSource } from '../src/request.ts'
import { run, type ActionContext } from '../src/run.ts'
import { scanResponse } from './fixtures.ts'

const execFileAsync = promisify(execFile)
const HEAD_SHA = '1111111111111111111111111111111111111111'
const RUN_URL = 'https://github.com/o/r/runs/1'
let workspace = ''
let commitSha = ''

// One checked-out repository for every scenario: main.tf at HEAD and an untracked plan.json beside it.
test.before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'terraform-run-'))
  await writeFile(path.join(workspace, 'main.tf'), 'resource "aws_db_instance" "primary" {}\nresource "aws_instance" "gone" {}\n')
  await execFileAsync('git', ['-C', workspace, 'init'])
  await execFileAsync('git', ['-C', workspace, 'add', 'main.tf'])
  await execFileAsync('git', ['-C', workspace, '-c', 'user.name=Draftt Test', '-c', 'user.email=test@draftt.io', 'commit', '-m', 'fixture'])
  commitSha = (await execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim()
  const change = (actions: string[]) => ({ actions, before: null, after: {}, after_unknown: {}, before_sensitive: false, after_sensitive: false })
  await writeFile(path.join(workspace, 'plan.json'), JSON.stringify({
    format_version: '1.2',
    resource_changes: [
      { address: 'aws_db_instance.primary', mode: 'managed', type: 'aws_db_instance', name: 'primary', change: change(['create']) },
      { address: 'aws_instance.gone', mode: 'managed', type: 'aws_instance', name: 'gone', change: change(['delete']) },
    ],
  }))
})

test.after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function actionContext(input: { payload?: Record<string, unknown>; inputs?: Record<string, string> } = {}): Promise<ActionContext> {
  const values: Record<string, string> = {
    'plan-json': 'plan.json', 'api-url': 'https://ci.example.test/ci/scans', 'api-key': 'draftt-key', 'terraform-root': '.', 'fail-on-scan-error': 'false',
    ...input.inputs,
  }
  const eventPath = path.join(workspace, 'event.json')
  if (input.payload) await writeFile(eventPath, JSON.stringify(input.payload))
  return {
    inputs: { getInput: (name: string) => values[name] ?? '' },
    ...(input.payload ? { eventPath } : {}),
    env: { GITHUB_RUN_ID: '1', GITHUB_SHA: commitSha },
    workspaceRoot: workspace,
    serverUrl: 'https://github.com',
  }
}

function pullRequest(headSha: string): Record<string, unknown> {
  return { pull_request: { number: 1, head: { sha: headSha } }, repository: { id: 10, owner: { id: 20 } } }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function uploadedBody(fetchMock: { mock: { calls: Array<{ arguments: unknown[] }> } }): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.arguments[1]
  return isRecord(init) ? JSON.parse(String(init.body)) : {}
}

test('a pull request from an external fork is skipped without uploading', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, scanResponse()))
  const fork = { pull_request: { number: 1, head: { repo: { full_name: 'fork/infra' } }, base: { repo: { full_name: 'draftt-io/infra' } } } }
  const result = await run(await actionContext({ payload: fork }))
  assert.equal(fetchMock.mock.callCount(), 0)
  assert.equal(result.outputs.status, 'skipped')
})

test('a pull request upload carries the scan key and the source map of the changed resources, and reports the check the App published', async (t) => {
  const response: ScanResponse = {
    ...scanResponse(),
    evaluation: { unevaluatedPolicies: [{ policyId: '10', reason: 'inactive' }], componentsWithGaps: [{ policyGaps: [{}, {}] }] },
    checkRunUrl: RUN_URL,
    annotationCount: 4,
    publishError: { code: 'comment', message: 'comment failed' },
  }
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, response))
  const result = await run(await actionContext({ payload: pullRequest(commitSha) }))
  const body = uploadedBody(fetchMock)
  assert.deepEqual(body.sourceMap, { 'aws_db_instance.primary': { path: 'main.tf', startLine: 1 } })
  assert.equal(isRecord(body.source) && body.source.scanKey, '.')
  assert.deepEqual(result.outputs, { status: 'completed', violations: 1, warnings: 3, annotations: 4, checkRunUrl: RUN_URL })
  assert.equal(result.failure, undefined)
})

test('a pull request whose head is not checked out is uploaded without a source map', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, scanResponse()))
  const result = await run(await actionContext({ payload: pullRequest(HEAD_SHA) }))
  assert.equal(uploadedBody(fetchMock).sourceMap, undefined)
  assert.equal(result.outputs.status, 'completed')
})

test('a push event is scanned without a source, and an off-host check run url is not reported', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { ...scanResponse(), checkRunUrl: 'https://evil.test/x' }))
  const result = await run(await actionContext())
  assert.equal(uploadedBody(fetchMock).source, undefined)
  assert.deepEqual(result.outputs, { status: 'completed', violations: 1, warnings: 0, annotations: 0, checkRunUrl: '' })
  assert.ok(result.summary.includes('- Check run: none published'))
})

test('a scan error is reported in the summary and fails the step only with fail-on-scan-error', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(403, { status: 403, message: 'owner_mismatch' }))
  const failOpen = await run(await actionContext())
  assert.equal(failOpen.outputs.status, 'error')
  assert.equal(failOpen.failure, undefined)
  assert.equal(failOpen.summary, '## Draftt Terraform Policy Scan\n\nScan error: Draftt answered 403: owner_mismatch')

  const enforced = await run(await actionContext({ inputs: { 'fail-on-scan-error': 'true', 'policy-ids': 'not-json' } }))
  assert.equal(enforced.outputs.status, 'error')
  assert.equal(enforced.failure, 'policy-ids must be a JSON array of decimal-string ids')
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('the github source is built from a pull_request payload, and not for other events or a missing, zero or non-decimal id', () => {
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'draftt-io/infra' }
  const payload = { pull_request: { number: 7 }, repository: { id: 10, owner: { id: 20 } } }
  const base = { env, headSha: HEAD_SHA, scanKey: 'modules/eks' }
  assert.deepEqual(buildScanSource({ ...base, payload }), {
    provider: 'github', repositoryId: 10, ownerId: 20, pullRequestNumber: 7, commitSha: HEAD_SHA, scanKey: 'modules/eks', runId: 42, runAttempt: 2,
    runUrl: 'https://github.com/draftt-io/infra/actions/runs/42',
  })
  const invalid = [
    { repository: payload.repository },
    { merge_group: { head_sha: HEAD_SHA }, repository: payload.repository },
    { pull_request: { number: 7 } },
    { ...payload, pull_request: { number: 0 } },
    { ...payload, repository: { id: 0, owner: { id: 20 } } },
  ]
  for (const bad of invalid) assert.equal(buildScanSource({ ...base, payload: bad }), undefined, JSON.stringify(bad))
  for (const runId of ['0', ' 42 ', '0x2a', '42.0', '']) assert.equal(buildScanSource({ ...base, env: { ...env, GITHUB_RUN_ID: runId }, payload }), undefined, runId)
})
