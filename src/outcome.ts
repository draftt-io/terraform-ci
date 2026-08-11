import type { CheckConclusion } from './github-check.ts'

export function completedConclusion(violationCount: number, failOnViolations: boolean): CheckConclusion {
  if (violationCount === 0) return 'success'
  return failOnViolations ? 'failure' : 'neutral'
}

export function scanErrorConclusion(failOnScanError: boolean): CheckConclusion {
  return failOnScanError ? 'failure' : 'neutral'
}
