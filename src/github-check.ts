// GitHub's official toolkit provides authenticated REST clients and workflow context.
import { context, getOctokit } from '@actions/github'

export const CHECK_NAME = 'Draftt Terraform Policy Scan'
// The server flow's own check, posted only when the Draftt CI App did not publish.
export const FALLBACK_CHECK_NAME = 'Draftt Terraform Policy Scan (Action)'

export type CheckConclusion = 'success' | 'neutral' | 'failure' | 'skipped'
export type AnnotationLevel = 'notice' | 'warning' | 'failure'

export interface CheckAnnotation {
  path: string
  start_line: number
  end_line: number
  annotation_level: AnnotationLevel
  message: string
  title: string
}

export class CheckPublisher {
  readonly #octokit: ReturnType<typeof getOctokit>
  readonly #owner: string
  readonly #repo: string
  readonly #headSha: string
  readonly #name: string
  #checkRunId: number | undefined
  #checkRunUrl: string | undefined
  #publishedAnnotations = 0

  constructor(token: string, headSha = getHeadSha(), name = CHECK_NAME) {
    this.#octokit = getOctokit(token)
    const repository = context.repo
    this.#owner = repository.owner
    this.#repo = repository.repo
    this.#headSha = headSha
    this.#name = name
  }

  get annotationCount(): number {
    return this.#publishedAnnotations
  }

  get checkRunUrl(): string | undefined {
    return this.#checkRunUrl
  }

  async start(): Promise<void> {
    const response = await this.#octokit.rest.checks.create({
      owner: this.#owner,
      repo: this.#repo,
      name: this.#name,
      head_sha: this.#headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      output: {
        title: this.#name,
        summary: 'Scanning Terraform policy compliance with Draftt.',
      },
    })
    this.#checkRunId = response.data.id
    this.#checkRunUrl = response.data.html_url ?? undefined
  }

  async publishAnnotations(annotations: CheckAnnotation[]): Promise<void> {
    const checkRunId = this.#requireCheckRunId()
    for (const batch of annotationBatches(annotations)) {
      await this.#octokit.rest.checks.update({
        owner: this.#owner,
        repo: this.#repo,
        check_run_id: checkRunId,
        output: {
          title: this.#name,
          summary: 'Publishing Terraform policy findings.',
          annotations: batch,
        },
      })
      this.#publishedAnnotations += batch.length
    }
  }

  async finish(conclusion: CheckConclusion, title: string, summary: string): Promise<void> {
    await this.#octokit.rest.checks.update({
      owner: this.#owner,
      repo: this.#repo,
      check_run_id: this.#requireCheckRunId(),
      status: 'completed',
      conclusion,
      completed_at: new Date().toISOString(),
      output: { title, summary },
    })
  }

  // One check created directly as completed (server-mode fallback and error checks); later
  // annotation batches repeat the same title and summary.
  async publishCompleted(conclusion: CheckConclusion, title: string, summary: string, annotations: CheckAnnotation[]): Promise<void> {
    const [first = [], ...rest] = annotationBatches(annotations)
    const now = new Date().toISOString()
    const response = await this.#octokit.rest.checks.create({
      owner: this.#owner,
      repo: this.#repo,
      name: this.#name,
      head_sha: this.#headSha,
      status: 'completed',
      conclusion,
      started_at: now,
      completed_at: now,
      output: { title, summary, annotations: first },
    })
    this.#checkRunId = response.data.id
    this.#checkRunUrl = response.data.html_url ?? undefined
    this.#publishedAnnotations += first.length
    for (const batch of rest) {
      await this.#octokit.rest.checks.update({
        owner: this.#owner,
        repo: this.#repo,
        check_run_id: response.data.id,
        output: { title, summary, annotations: batch },
      })
      this.#publishedAnnotations += batch.length
    }
  }

  #requireCheckRunId(): number {
    if (this.#checkRunId === undefined) throw new Error('GitHub Check Run has not been created')
    return this.#checkRunId
  }
}

export function getHeadSha(): string {
  const pullRequest = context.payload.pull_request
  if (pullRequest && typeof pullRequest === 'object' && 'head' in pullRequest) {
    const head = pullRequest.head
    if (head && typeof head === 'object' && 'sha' in head && typeof head.sha === 'string') return head.sha
  }
  if (!context.sha) throw new Error('GitHub commit SHA is unavailable')
  return context.sha
}

export function isExternalFork(): boolean {
  return isExternalForkPayload(context.payload)
}

export function isExternalForkPayload(payload: Record<string, unknown>): boolean {
  const pullRequest = payload.pull_request
  if (!pullRequest || typeof pullRequest !== 'object' || !('head' in pullRequest) || !('base' in pullRequest)) return false
  const headName = repositoryFullName(pullRequest.head)
  const baseName = repositoryFullName(pullRequest.base)
  return headName !== undefined && baseName !== undefined && headName !== baseName
}

export function annotationBatches(annotations: CheckAnnotation[]): CheckAnnotation[][] {
  const batches: CheckAnnotation[][] = []
  for (let index = 0; index < annotations.length; index += 50) batches.push(annotations.slice(index, index + 50))
  return batches
}

function repositoryFullName(reference: unknown): string | undefined {
  if (!reference || typeof reference !== 'object' || !('repo' in reference)) return undefined
  const repository = reference.repo
  if (!repository || typeof repository !== 'object' || !('full_name' in repository)) return undefined
  return typeof repository.full_name === 'string' ? repository.full_name : undefined
}
