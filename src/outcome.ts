import type { CheckConclusion } from './github-check.ts'

// The Action's checks in every flow never fail on violations (fail-on-violations is a no-op).
export function violationConclusion(violationCount: number): 'success' | 'neutral' {
  return violationCount === 0 ? 'success' : 'neutral'
}

// The opt-in fail-on-scan-error is about scan errors, not violations, so it keeps failure.
export function scanErrorConclusion(failOnScanError: boolean): CheckConclusion {
  return failOnScanError ? 'failure' : 'neutral'
}
