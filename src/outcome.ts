import type { ScanMode, ScanResponse } from './contracts.ts'
import type { CheckConclusion } from './github-check.ts'

// The v0.1.1 flow, where fail-on-violations still decides.
export function completedConclusion(violationCount: number, failOnViolations: boolean): CheckConclusion {
  if (violationCount === 0) return 'success'
  return failOnViolations ? 'failure' : 'neutral'
}

export function scanErrorConclusion(failOnScanError: boolean): CheckConclusion {
  return failOnScanError ? 'failure' : 'neutral'
}

// The Action's own (Action) check in the server flow, posted when the server did not publish:
// failure only in blocking mode; no mode (an older service) is advisory.
export function fallbackConclusion(mode: ScanMode | undefined, violationCount: number): CheckConclusion {
  if (violationCount === 0) return 'success'
  return mode === 'blocking' ? 'failure' : 'neutral'
}

// The conclusion the server flow ends up with; the job fails exactly when it is failure. With a
// published check the server is the authority, in either mode; a checkRunUrl without conclusion
// (an older service) gives undefined, which never fails the job. Without one, the fallback rule.
export function serverJobConclusion(
  response: Pick<ScanResponse, 'checkRunUrl' | 'mode' | 'conclusion'>,
  violationCount: number,
): CheckConclusion | undefined {
  if (response.checkRunUrl) return response.conclusion
  return fallbackConclusion(response.mode, violationCount)
}
