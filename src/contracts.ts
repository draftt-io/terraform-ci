import { isRecord } from './objects.ts'

// The parts of the Draftt CI scan answer the Action reports: the flagged components, the checks that could not
// run, and what the Draftt CI App published on the pull request. Everything else in the answer is ignored.
export interface ScanResponse {
  components: unknown[]
  evaluation: {
    unevaluatedPolicies: unknown[]
    componentsWithGaps: Array<{ policyGaps: unknown[] }>
  }
  coverage: {
    unmappedResources: unknown[]
  }
  checkRunUrl?: string
  annotationCount?: number
  publishError?: { code: string; message: string }
}

export function parseScanResponse(value: unknown): ScanResponse {
  const response = requireObject(value, 'root')
  const evaluation = requireObject(response.evaluation, 'evaluation')
  const coverage = requireObject(response.coverage, 'coverage')
  const checkRunUrl = typeof response.checkRunUrl === 'string' ? response.checkRunUrl : undefined
  const annotationCount = optionalCount(response.annotationCount)
  // The server sends publishError: null when publishing succeeded; only a well-formed object is an error.
  const publishError = isRecord(response.publishError) && typeof response.publishError.code === 'string' && typeof response.publishError.message === 'string'
    ? { code: response.publishError.code, message: response.publishError.message }
    : undefined
  return {
    components: array(response.components, 'components'),
    evaluation: {
      unevaluatedPolicies: array(evaluation.unevaluatedPolicies, 'evaluation.unevaluatedPolicies'),
      componentsWithGaps: array(evaluation.componentsWithGaps, 'evaluation.componentsWithGaps').map((item, index) => ({
        policyGaps: array(requireObject(item, `evaluation.componentsWithGaps.${index}`).policyGaps, `evaluation.componentsWithGaps.${index}.policyGaps`),
      })),
    },
    coverage: {
      unmappedResources: array(coverage.unmappedResources, 'coverage.unmappedResources'),
    },
    ...(checkRunUrl ? { checkRunUrl } : {}),
    ...(annotationCount === undefined ? {} : { annotationCount }),
    ...(publishError ? { publishError } : {}),
  }
}

// An optional count: anything but a non-negative safe integer is dropped.
function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponseError(field)
  return value
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponseError(field)
  return value
}

function invalidResponseError(field: string): Error {
  return new Error(`Invalid API response: ${field}`)
}
