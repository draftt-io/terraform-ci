import type { CheckConclusion } from './github-check.ts'

// Draftt CI checks never fail on violations (fail-on-violations is a no-op in every flow).

// The v0.1.1 flow's own check.
export function completedConclusion(violationCount: number): 'success' | 'neutral' {
  return violationCount === 0 ? 'success' : 'neutral'
}

// The opt-in fail-on-scan-error is about scan errors, not violations, so it keeps failure.
export function scanErrorConclusion(failOnScanError: boolean): CheckConclusion {
  return failOnScanError ? 'failure' : 'neutral'
}

// The Action's own (Action) check in the server flow, posted when the server did not publish.
export function fallbackConclusion(violationCount: number): 'success' | 'neutral' {
  return violationCount === 0 ? 'success' : 'neutral'
}
