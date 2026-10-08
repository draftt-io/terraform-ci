import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGitHubContext } from '../src/request.ts'

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
