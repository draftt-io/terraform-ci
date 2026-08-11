import type { FlaggedComponent, ScanResponse } from './contracts.ts'
import type { AnnotationLevel, CheckAnnotation } from './github-check.ts'
import type { TerraformSourceLocator } from './source-locator.ts'

const MAX_SUMMARY_LENGTH = 60_000
const MAX_ANNOTATION_MESSAGE_LENGTH = 60_000
const MAX_SECTION_ITEMS = 25
const MAX_SUMMARY_LINE_LENGTH = 500

export interface ScanReport {
  title: string
  summary: string
  annotations: CheckAnnotation[]
  violationCount: number
  warningCount: number
}

export async function buildScanReport(
  response: ScanResponse,
  locator: TerraformSourceLocator | undefined,
  annotationLevel: AnnotationLevel,
  noPoliciesSelected: boolean,
): Promise<ScanReport> {
  const annotations: CheckAnnotation[] = []
  const unresolved: FlaggedComponent[] = []
  for (const component of response.components) {
    const mapping = locator ? await locator.locate(component) : undefined
    if (!mapping || mapping.kind === 'unresolved') {
      unresolved.push(component)
      continue
    }
    annotations.push({
      path: mapping.location.path,
      start_line: mapping.location.startLine,
      end_line: mapping.location.startLine,
      annotation_level: annotationLevel,
      title: truncate(`Draftt policy violation: ${component.tfType}`, 255),
      message: truncate(formatViolation(component), MAX_ANNOTATION_MESSAGE_LENGTH),
    })
  }

  const evaluationGapCount = response.evaluation.componentsWithGaps.reduce(
    (count, component) => count + component.policyGaps.length,
    0,
  )
  const warningCount = response.evaluation.unevaluatedPolicies.length
    + evaluationGapCount
    + response.coverage.unmappedResources.length
    + (noPoliciesSelected ? 1 : 0)
  const title = response.components.length === 0
    ? 'No policy violations found'
    : `${response.components.length} ${plural(response.components.length, 'resource')} with policy violations`

  const lines = [
    `Scanned **${response.summary.managedResourcesInPlan}** managed ${plural(response.summary.managedResourcesInPlan, 'resource')}; Draftt mapped **${response.summary.componentsMapped}** ${plural(response.summary.componentsMapped, 'component')}.`,
    '',
    `Clear violations: **${response.components.length}**  `,
    `Incomplete-result warnings: **${warningCount}**  `,
    `Source annotations: **${annotations.length}**`,
  ]

  if (noPoliciesSelected) lines.push('', '> Warning: `policy-ids` selected 0 policies. No policy was evaluated by request.')
  appendViolations(lines, response.components, unresolved)
  appendEvaluationWarnings(lines, response)
  appendCoverage(lines, response)

  return {
    title,
    summary: truncate(lines.join('\n'), MAX_SUMMARY_LENGTH),
    annotations,
    violationCount: response.components.length,
    warningCount,
  }
}

function appendViolations(lines: string[], components: FlaggedComponent[], unresolved: FlaggedComponent[]): void {
  if (components.length === 0) return
  lines.push('', '### Policy violations')
  const unresolvedSet = new Set(unresolved)
  const ordered = [...unresolved, ...components.filter((component) => !unresolvedSet.has(component))]
  appendLimited(lines, ordered, (component) => `- **${inline(component.address)}:** ${inlinePolicyNames(component)}`, 'violations')
  if (unresolved.length > 0) {
    lines.push('', `${unresolved.length} ${plural(unresolved.length, 'violation')} could not be mapped to an exact editable source line. Summary-only violations are listed first.`)
  }
}

function appendEvaluationWarnings(lines: string[], response: ScanResponse): void {
  if (response.evaluation.unevaluatedPolicies.length > 0) {
    lines.push('', '### Unevaluated policies')
    appendLimited(
      lines,
      response.evaluation.unevaluatedPolicies,
      (policy) => `- ${inline(policy.name ?? `Policy ${policy.policyId}`)}: ${inline(policy.reason)}`,
      'unevaluated policies',
    )
  }
  if (response.evaluation.componentsWithGaps.length > 0) {
    lines.push('', '### Components with evaluation gaps')
    appendLimited(lines, response.evaluation.componentsWithGaps, (component) => {
      const gaps = component.policyGaps.map((gap) => `${gap.policyName} (${gap.reason})`).join(', ')
      return `- **${inline(component.address)}:** ${inline(gaps)}`
    }, 'components with gaps')
  }
}

function appendCoverage(lines: string[], response: ScanResponse): void {
  if (response.coverage.unmappedResources.length > 0) {
    lines.push('', '### Unmapped resources')
    appendLimited(
      lines,
      response.coverage.unmappedResources,
      (resource) => `- **${inline(resource.address)}:** ${inline(resource.reason)}`,
      'unmapped resources',
    )
  }
  if (response.coverage.mergedResources.length > 0 || response.coverage.skippedResources.length > 0) {
    lines.push('', '### Other coverage')
    lines.push(`Merged supporting resources: **${response.coverage.mergedResources.length}**  `)
    lines.push(`Intentionally skipped resources: **${response.coverage.skippedResources.length}**`)
  }
}

function formatViolation(component: FlaggedComponent): string {
  const lines = [`Terraform resource: ${component.address}`, `Component: ${component.technology} ${component.type}`]
  if (component.currentVersion) lines.push(`Current version: ${component.currentVersion}`)
  lines.push('')
  for (const policy of component.policyComponents) {
    const target = policy.recommendedVersion ?? policy.desiredVersion
    lines.push(`- ${policy.policyName}: ${policy.status}${target ? `; recommended ${target}` : ''}${policy.hasForceUpgrade ? '; force upgrade reported' : ''}`)
  }
  return lines.join('\n')
}

function inlinePolicyNames(component: FlaggedComponent): string {
  return inline(component.policyComponents.map((policy) => `${policy.policyName} (${policy.status})`).join(', '))
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/`/g, "'")
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 14)}\n… truncated`
}

function appendLimited<T>(lines: string[], items: T[], format: (item: T) => string, label: string): void {
  for (const item of items.slice(0, MAX_SECTION_ITEMS)) lines.push(truncate(format(item), MAX_SUMMARY_LINE_LENGTH))
  const omitted = items.length - MAX_SECTION_ITEMS
  if (omitted > 0) lines.push(`- … ${omitted} additional ${label} omitted from this summary.`)
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
