import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGitHubContext } from '../src/request.ts'

const SHA = 'a'.repeat(40)
const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'draftt-io/infra' }
const pullRequestPayload = { pull_request: { number: 7, head: { sha: SHA } }, repository: { id: 10, owner: { id: 20 } } }

test('builds the github block from a pull_request payload', () => {
  const block = buildGitHubContext({ payload: pullRequestPayload, env, headSha: SHA, scanKey: 'modules/eks', sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } } })
  assert.deepEqual(block, {
    repositoryId: 10, repositoryOwnerId: 20, pullRequestNumber: 7, headSha: SHA, scanKey: 'modules/eks', runId: 42, runAttempt: 2,
    workflowRunUrl: 'https://github.com/draftt-io/infra/actions/runs/42',
    sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } },
  })
})

test('sends no github block for a non-pull-request event or a missing, zero or non-decimal id', () => {
  const base = { env, headSha: SHA, scanKey: '.' }
  const payloads = [
    { repository: { id: 10, owner: { id: 20 } } },
    { merge_group: { head_sha: SHA }, repository: { id: 10, owner: { id: 20 } } },
    { pull_request: { number: 7 } },
    { ...pullRequestPayload, pull_request: { number: 0 } },
    { pull_request: { number: 7 }, repository: { id: 0, owner: { id: 20 } } },
  ]
  for (const payload of payloads) assert.equal(buildGitHubContext({ ...base, payload }), undefined, JSON.stringify(payload))
  for (const runId of ['0', ' 42 ', '0x2a', '42.0', '']) {
    assert.equal(buildGitHubContext({ ...base, env: { ...env, GITHUB_RUN_ID: runId }, payload: pullRequestPayload }), undefined, runId)
  }
})
