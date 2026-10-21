import { isRecord } from './objects.ts'

export interface SourceMapEntry {
  path: string
  startLine: number
}

export interface GitHubScanContext {
  repositoryId: number
  repositoryOwnerId: number
  pullRequestNumber: number
  headSha: string
  scanKey: string
  runId: number
  runAttempt: number
  workflowRunUrl?: string
  sourceMap?: Record<string, SourceMapEntry>
}

// Only pull_request and pull_request_target payloads carry a PR number; other events get no block,
// and Draftt CI then scans without publishing to GitHub.
export function buildGitHubContext(input: {
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  headSha: string
  scanKey: string
}): GitHubScanContext | undefined {
  const pullRequest = isRecord(input.payload.pull_request) ? input.payload.pull_request : undefined
  const pullRequestNumber = positiveInteger(pullRequest?.number)
  if (pullRequestNumber === undefined) return undefined
  const repository = isRecord(input.payload.repository) ? input.payload.repository : {}
  const owner = isRecord(repository.owner) ? repository.owner : {}
  const repositoryId = positiveInteger(repository.id) ?? positiveInteger(input.env.GITHUB_REPOSITORY_ID)
  const repositoryOwnerId = positiveInteger(owner.id) ?? positiveInteger(input.env.GITHUB_REPOSITORY_OWNER_ID)
  const runId = positiveInteger(input.env.GITHUB_RUN_ID)
  if (repositoryId === undefined || repositoryOwnerId === undefined || runId === undefined) return undefined
  const runAttempt = positiveInteger(input.env.GITHUB_RUN_ATTEMPT) ?? 1
  const workflowRunUrl = buildWorkflowRunUrl(input.env, runId)
  return {
    repositoryId,
    repositoryOwnerId,
    pullRequestNumber,
    headSha: input.headSha,
    scanKey: input.scanKey,
    runId,
    runAttempt,
    ...(workflowRunUrl ? { workflowRunUrl } : {}),
  }
}

// The pull request head when the event carries one, else the commit the workflow runs on.
export function headShaOf(input: { payload: Record<string, unknown>; env: NodeJS.ProcessEnv }): string {
  const pullRequest = isRecord(input.payload.pull_request) ? input.payload.pull_request : {}
  const head = isRecord(pullRequest.head) ? pullRequest.head : {}
  if (typeof head.sha === 'string') return head.sha
  if (!input.env.GITHUB_SHA) throw new Error('GitHub commit SHA is unavailable')
  return input.env.GITHUB_SHA
}

// A pull request from another repository: GitHub withholds repository secrets, so there is no Draftt key.
export function isExternalFork(payload: Record<string, unknown>): boolean {
  const pullRequest = isRecord(payload.pull_request) ? payload.pull_request : {}
  const headName = repositoryFullName(pullRequest.head)
  const baseName = repositoryFullName(pullRequest.base)
  return headName !== undefined && baseName !== undefined && headName !== baseName
}

function repositoryFullName(reference: unknown): string | undefined {
  const repository = isRecord(reference) && isRecord(reference.repo) ? reference.repo : {}
  return typeof repository.full_name === 'string' ? repository.full_name : undefined
}

// The server rejects a non-https workflowRunUrl with 422 (validation); it is optional, so omit it rather than fail the upload.
function buildWorkflowRunUrl(env: NodeJS.ProcessEnv, runId: number): string | undefined {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY) return undefined
  const url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`
  return url.startsWith('https://') ? url : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : undefined) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined
}
