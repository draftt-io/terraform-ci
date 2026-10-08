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
  failOnViolations: boolean
  sourceMap?: Record<string, SourceMapEntry>
}

// Only pull_request and pull_request_target payloads carry a PR number; other events get no block.
export function buildGitHubContext(input: {
  payload: Record<string, unknown>
  env: NodeJS.ProcessEnv
  headSha: string
  failOnViolations: boolean
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
  const workflowRunUrl = input.env.GITHUB_SERVER_URL && input.env.GITHUB_REPOSITORY ? `${input.env.GITHUB_SERVER_URL}/${input.env.GITHUB_REPOSITORY}/actions/runs/${runId}` : undefined
  return {
    repositoryId,
    repositoryOwnerId,
    pullRequestNumber,
    headSha: input.headSha,
    scanKey: input.scanKey,
    runId,
    runAttempt,
    ...(workflowRunUrl ? { workflowRunUrl } : {}),
    failOnViolations: input.failOnViolations,
    ...(input.sourceMap ? { sourceMap: input.sourceMap } : {}),
  }
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : undefined
}
