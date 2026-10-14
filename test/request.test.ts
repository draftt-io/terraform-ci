import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGitHubContext, repositoryFromPayload } from '../src/request.ts'

const SHA = 'a'.repeat(40)
const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'draftt-io/infra' }
const pullRequestPayload = { pull_request: { number: 7, head: { sha: SHA } }, repository: { id: 10, owner: { id: 20 } } }

test('builds the github block from a pull_request payload', () => {
  const block = buildGitHubContext({ payload: pullRequestPayload, env, headSha: SHA, failOnViolations: true, scanKey: 'modules/eks', sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } } })
  assert.deepEqual(block, {
    repositoryId: 10,
    repositoryOwnerId: 20,
    pullRequestNumber: 7,
    headSha: SHA,
    scanKey: 'modules/eks',
    runId: 42,
    runAttempt: 2,
    workflowRunUrl: 'https://github.com/draftt-io/infra/actions/runs/42',
    failOnViolations: true,
    sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } },
  })
})

test('falls back to GITHUB_REPOSITORY_ID and GITHUB_REPOSITORY_OWNER_ID and defaults the run attempt', () => {
  const { GITHUB_RUN_ATTEMPT: _attempt, ...withoutAttempt } = env
  const block = buildGitHubContext({ payload: { pull_request: { number: 7 } }, env: { ...withoutAttempt, GITHUB_REPOSITORY_ID: '10', GITHUB_REPOSITORY_OWNER_ID: '20' }, headSha: SHA, failOnViolations: false, scanKey: '.' })
  assert.equal(block?.repositoryId, 10)
  assert.equal(block?.repositoryOwnerId, 20)
  assert.equal(block?.runAttempt, 1)
  assert.equal(block?.sourceMap, undefined)
})

test('returns undefined on push, merge_group and workflow_dispatch payloads and without ids', () => {
  for (const payload of [{ repository: { id: 10, owner: { id: 20 } } }, { merge_group: { head_sha: SHA }, repository: { id: 10, owner: { id: 20 } } }, { inputs: {} }]) {
    assert.equal(buildGitHubContext({ payload, env, headSha: SHA, failOnViolations: false, scanKey: '.' }), undefined)
  }
  assert.equal(buildGitHubContext({ payload: { pull_request: { number: 7 } }, env, headSha: SHA, failOnViolations: false, scanKey: '.' }), undefined)
})

test('rejects a zero pull request number or zero ids, and non-decimal env ids', () => {
  const base = { env, headSha: SHA, failOnViolations: false, scanKey: '.' }
  assert.equal(buildGitHubContext({ ...base, payload: { ...pullRequestPayload, pull_request: { number: 0 } } }), undefined)
  assert.equal(buildGitHubContext({ ...base, payload: { pull_request: { number: 7 }, repository: { id: 0, owner: { id: 20 } } } }), undefined)
  assert.equal(buildGitHubContext({ ...base, payload: { pull_request: { number: 7 }, repository: { id: 10, owner: { id: 0 } } } }), undefined)
  assert.equal(buildGitHubContext({ ...base, env: { ...env, GITHUB_RUN_ID: '0' }, payload: pullRequestPayload }), undefined)
  for (const runId of [' 42 ', '0x2a', '4.2e1', '42.0', '']) {
    assert.equal(buildGitHubContext({ ...base, env: { ...env, GITHUB_RUN_ID: runId }, payload: pullRequestPayload }), undefined, runId)
  }
  assert.equal(buildGitHubContext({ ...base, env: { ...env, GITHUB_RUN_ATTEMPT: '0x2' }, payload: pullRequestPayload })?.runAttempt, 1)
})

test('omits workflowRunUrl unless it is https', () => {
  const block = buildGitHubContext({ payload: pullRequestPayload, env: { ...env, GITHUB_SERVER_URL: 'http://ghe.local' }, headSha: SHA, failOnViolations: false, scanKey: '.' })
  assert.ok(block)
  assert.equal('workflowRunUrl' in block, false)
  assert.equal(block.runId, 42)
})

test('repositoryFromPayload reads owner and name from the payload repository', () => {
  const payload = { repository: { name: 'infra', owner: { login: 'draftt-io' } } }
  assert.deepEqual(repositoryFromPayload({ payload, env: { GITHUB_REPOSITORY: 'other/repo' }, headSha: SHA }), { owner: 'draftt-io', repo: 'infra', headSha: SHA })
})

test('repositoryFromPayload falls back to GITHUB_REPOSITORY split on the first slash', () => {
  assert.deepEqual(repositoryFromPayload({ payload: {}, env: { GITHUB_REPOSITORY: 'draftt-io/infra' }, headSha: SHA }), { owner: 'draftt-io', repo: 'infra', headSha: SHA })
  assert.deepEqual(repositoryFromPayload({ payload: { repository: { name: 'infra' } }, env: { GITHUB_REPOSITORY: 'draftt-io/infra' }, headSha: SHA }), { owner: 'draftt-io', repo: 'infra', headSha: SHA })
})

test('repositoryFromPayload is undefined without an owner, a repo or a head SHA', () => {
  for (const GITHUB_REPOSITORY of [undefined, '', 'draftt-io', '/infra', 'draftt-io/']) {
    assert.equal(repositoryFromPayload({ payload: {}, env: { GITHUB_REPOSITORY }, headSha: SHA }), undefined, String(GITHUB_REPOSITORY))
  }
  assert.equal(repositoryFromPayload({ payload: { repository: { name: '', owner: { login: '' } } }, env: {}, headSha: SHA }), undefined)
  assert.equal(repositoryFromPayload({ payload: { repository: { name: 'infra', owner: { login: 'draftt-io' } } }, env: {}, headSha: '' }), undefined)
})
