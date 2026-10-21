import { isRecord } from './objects.ts'
import type { ReportRepository } from './report.ts'

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

// Only pull_request and pull_request_target payloads carry a PR number; other events get no block.
export function buildGitHubContext(input: {
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  headSha: string
  scanKey: string
  sourceMap?: Record<string, SourceMapEntry>
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
    ...(input.sourceMap ? { sourceMap: input.sourceMap } : {}),
  }
}

// For path:line links in the report: the payload repository, else GITHUB_REPOSITORY (owner/repo).
export function repositoryFromPayload(input: {
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  headSha: string
}): ReportRepository | undefined {
  if (!input.headSha) return undefined
  const repository = isRecord(input.payload.repository) ? input.payload.repository : {}
  const owner = isRecord(repository.owner) ? repository.owner : {}
  if (nonEmpty(owner.login) && nonEmpty(repository.name)) return { owner: owner.login, repo: repository.name, headSha: input.headSha }
  const slug = input.env.GITHUB_REPOSITORY ?? ''
  const slash = slug.indexOf('/')
  if (slash <= 0 || slash === slug.length - 1) return undefined
  return { owner: slug.slice(0, slash), repo: slug.slice(slash + 1), headSha: input.headSha }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
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
