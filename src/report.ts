// Redesigned in draftt-ci Task 9b. Only the block above the "Shared renderer" marker is
// Action-specific; test/fixtures/parity.json pins the output of the rest.
import type { FlaggedComponent, PolicyHit, ScanResponse } from './contracts.ts'
import type { AnnotationLevel, CheckAnnotation } from './github-check.ts'
import type { SourceMapping, TerraformComponentReference } from './source-locator.ts'

export interface SourceLocator {
  locate(reference: TerraformComponentReference): Promise<SourceMapping>
}

// ---- Shared renderer: byte-identical in draftt-ci src/reporters/scanReport.ts and terraform-ci src/report.ts from this line down. ----

const MAX_SUMMARY_LENGTH = 60_000
const MAX_ANNOTATION_MESSAGE_LENGTH = 60_000
const MAX_SECTION_ITEMS = 25
export const MAX_SUMMARY_LINE_LENGTH = 500
export const MAX_VALUE_CHARS = 200
// The summary is built from whole lines up to this many characters. The 60,000 summary cut and the
// 65,000 comment cut are backstops only: neither can be reached, so neither can open a code span.
export const SUMMARY_BUDGET = 55_000
export const MAX_TABLE_RESOURCES = 25
export const MAX_ROWS_PER_RESOURCE = 10
// GitHub accepts at most 500 annotations per check run; the most urgent resources get them.
export const MAX_PUBLISHED_ANNOTATIONS = 500
// Room kept for the collapsed lists so a long table can never squeeze them out entirely.
const INCOMPLETE_RESERVE = 12_000
const UNCHANGED_RESERVE = 12_000
const OVERFLOW_RESERVE = 1_000
export const DOCS_URL = 'https://docs.draftt.io/ci'
const GITHUB_WEB_URL = 'https://github.com'
export const NO_VIOLATIONS_TITLE = 'No policy violations found'
export const NO_CHANGED_VIOLATIONS_TITLE = 'No policy violations on changed resources'
export const NO_POLICIES_TITLE = 'No policies evaluated'
const NO_TRACKED_RESOURCES = 'No Draftt-tracked resources in this plan.'
const DITTO = '″'
const NO_SOURCE_LINE = 'no source line found'
const NO_DATE = '9999-99-99'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/
const OTHER_STATUS_RANK = 3

export interface ScanReport {
  title: string
  summary: string
  annotations: CheckAnnotation[]
  violationCount: number
  warningCount: number
}

// Trusted context only (the resolved repository and the validated head SHA): file links are built
// from it, never from a URL in the scan response or the plan.
export interface ReportRepository {
  owner: string
  repo: string
  headSha: string
}

export interface ReportOptions {
  repository?: ReportRepository
  // Report scope 'changed' (the service only): the findings on resources the pull request leaves as they are, shown
  // collapsed and never annotated, and the number of resources the plan changes. Absent, the report is the whole plan.
  unchanged?: { components: FlaggedComponent[]; changedResourceCount: number }
}

interface SourceLocation {
  path: string
  startLine: number
}

interface ResourceEntry {
  component: FlaggedComponent
  location?: SourceLocation
  hits: PolicyHit[]
  rank: number
  sortDate: string
}

interface HitGroup {
  hit: PolicyHit
  count: number
}

const KNOWN_STATUSES = new Map<string, { label: string; rank: number }>([
  ['outdated', { label: 'Outdated', rank: 0 }],
  ['noncompliant', { label: 'Non-compliant', rank: 1 }],
  ['impending', { label: 'Impending', rank: 2 }],
])

const UNEVALUATED_REASONS = new Map<string, string>([
  ['not_found', 'This policy was not found in your organization'],
  ['inactive', 'This policy is inactive'],
  ['unsupported_policy', 'This policy type is not supported in CI scans yet'],
  ['error', 'Draftt could not evaluate this policy'],
])

const GAP_REASONS = new Map<string, string>([
  ['missing_data', 'The plan does not contain the data this policy needs'],
  ['error', 'Draftt could not evaluate this policy for this resource'],
])

const UNMAPPED_REASONS = new Map<string, string>([
  ['unknown_technology', 'Draftt does not track this resource type yet'],
  ['no_version', 'The plan has no version for this resource'],
  ['orphaned_child', 'Its parent resource is not in the plan'],
  ['unresolvable_version', 'Draftt could not resolve the version from the plan'],
])

export async function buildScanReport(
  response: ScanResponse,
  locator: SourceLocator | undefined,
  annotationLevel: AnnotationLevel,
  noPoliciesSelected: boolean,
  options: ReportOptions = {},
): Promise<ScanReport> {
  const resources = await resourceEntries(response.components, locator)
  // Never annotated and never counted as violations: the pull request does not change these resources.
  const unchangedResources = options.unchanged ? await resourceEntries(options.unchanged.components, locator) : []

  const annotations: CheckAnnotation[] = []
  let unannotated = 0
  for (const resource of resources) {
    if (!resource.location) continue
    if (annotations.length >= MAX_PUBLISHED_ANNOTATIONS) {
      unannotated += 1
      continue
    }
    annotations.push({
      path: resource.location.path,
      start_line: resource.location.startLine,
      end_line: resource.location.startLine,
      annotation_level: annotationLevel,
      title: cutOnWord(
        `${statusLabel(resource.hits[0]?.status ?? '')}: ${resource.hits.length} ${plural(resource.hits.length, 'policy violation')} on ${resource.component.tfType}`,
        255,
      ),
      message: truncateBytes(formatViolation(resource), MAX_ANNOTATION_MESSAGE_LENGTH),
    })
  }

  const gapCount = response.evaluation.componentsWithGaps.reduce((count, component) => count + component.policyGaps.length, 0)
  const incompleteCount = response.evaluation.unevaluatedPolicies.length + gapCount + response.coverage.unmappedResources.length
  const warningCount = incompleteCount + (noPoliciesSelected ? 1 : 0)
  const violationTotal = resources.reduce((count, resource) => count + resource.hits.length, 0)
  // Only when something was mapped: a plan with no Draftt-tracked resource gets the zero-violation layout.
  const noPoliciesEvaluated =
    resources.length === 0 &&
    unchangedResources.length === 0 &&
    response.summary.componentsMapped > 0 &&
    (noPoliciesSelected || response.evaluation.evaluatedPolicies?.length === 0)

  let title: string
  let head: string[]
  if (noPoliciesEvaluated) {
    title = NO_POLICIES_TITLE
    head = noPoliciesAlert(
      noPoliciesSelected ? 'none_selected' : (response.evaluation.excludedEvaluatedPolicyCount ?? 0) > 0 ? 'all_excluded' : 'none_apply',
    )
  } else if (resources.length === 0) {
    const clean = unchangedResources.length > 0 ? NO_CHANGED_VIOLATIONS_TITLE : NO_VIOLATIONS_TITLE
    title = incompleteCount > 0 ? `${clean} (${incompleteText(incompleteCount)})` : clean
    head = [checkedLine(response)]
  } else {
    const changed = options.unchanged ? 'changed ' : ''
    title = `${violationTotal} policy ${plural(violationTotal, 'violation')} on ${resources.length} ${changed}${plural(resources.length, 'resource')}`
    head = [countsLine(resources, incompleteCount)]
  }

  const note =
    unannotated > 0
      ? [
          `Not annotated in Files changed: ${unannotated} ${plural(unannotated, 'resource')} with violations (GitHub accepts at most ${MAX_PUBLISHED_ANNOTATIONS} annotations per check).`,
        ]
      : []
  const footer = [footerLine(response, resources.length > 0 ? annotations.length : undefined, options.unchanged?.changedResourceCount)]

  // Budgeted by whole lines, most important first: the table, then the resources it could not
  // hold, then the findings on unchanged resources, then the incomplete checks. Each collapsed block
  // closes its own <details>.
  const urls = policyUrls(response)
  const incomplete = incompleteSection(response, incompleteCount)
  const fixed = blockSize(head) + blockSize(note) + blockSize(footer)
  const incompleteRoom = incomplete ? Math.min(INCOMPLETE_RESERVE, blockSize(detailsBlock(incomplete, Number.MAX_SAFE_INTEGER))) : 0
  const unchangedRoom =
    unchangedResources.length > 0
      ? Math.min(UNCHANGED_RESERVE, blockSize(unchangedSection(unchangedResources, options.repository, urls, Number.MAX_SAFE_INTEGER)))
      : 0
  const overflowRoom = resources.length > 0 ? OVERFLOW_RESERVE : 0
  const table = violationTable(resources, options.repository, urls, SUMMARY_BUDGET - fixed - incompleteRoom - unchangedRoom - overflowRoom)
  const overflow = overflowBlock(
    resources.filter((resource) => !table.shown.has(resource)),
    SUMMARY_BUDGET - fixed - incompleteRoom - unchangedRoom - blockSize(table.lines),
  )
  const unchangedLines = unchangedSection(
    unchangedResources,
    options.repository,
    urls,
    SUMMARY_BUDGET - fixed - incompleteRoom - blockSize(table.lines) - blockSize(overflow),
  )
  const incompleteLines = incomplete
    ? detailsBlock(incomplete, SUMMARY_BUDGET - fixed - blockSize(table.lines) - blockSize(overflow) - blockSize(unchangedLines))
    : []

  const blocks = [head, table.lines, overflow, unchangedLines, incompleteLines, note, footer].filter((block) => block.length > 0)
  return {
    title,
    summary: truncate(blocks.map((block) => block.join('\n')).join('\n\n'), MAX_SUMMARY_LENGTH),
    annotations,
    violationCount: resources.length,
    warningCount,
  }
}

// Each component with its source location and its hits in urgency order; the most urgent resource first.
async function resourceEntries(components: FlaggedComponent[], locator: SourceLocator | undefined): Promise<ResourceEntry[]> {
  const resources: ResourceEntry[] = []
  for (const component of components) {
    const mapping = locator ? await locator.locate(component) : undefined
    const hits = [...component.policyComponents].sort(compareHits)
    const rank = Math.min(OTHER_STATUS_RANK, ...hits.map((hit) => statusRank(hit.status)))
    resources.push({
      component,
      ...(mapping?.kind === 'found' ? { location: { path: mapping.location.path, startLine: mapping.location.startLine } } : {}),
      hits,
      rank,
      // The date of the hits that set the rank: a later, less urgent hit never pulls a resource up.
      sortDate: earliestDate(hits.filter((hit) => statusRank(hit.status) === rank).map(hitDate)) ?? NO_DATE,
    })
  }
  return resources.sort(compareResources)
}

const NO_POLICIES_REASONS = {
  none_selected:
    "The workflow passes an empty `policy-ids` list. Remove the `policy-ids` input to use your organization's default policies, or list the policy IDs to enforce.",
  none_apply: 'No active Draftt policy in your organization applies to this plan.',
  all_excluded: 'Every Draftt policy that applies to this plan is excluded for this repository in the Draftt CI settings.',
} as const

function noPoliciesAlert(reason: 'none_selected' | 'none_apply' | 'all_excluded'): string[] {
  return ['> [!WARNING]', `> **No policies were evaluated.** ${NO_POLICIES_REASONS[reason]}`]
}

// policyId → the policy's page in the Draftt console. The parser keeps only trusted URLs.
function policyUrls(response: ScanResponse): ReadonlyMap<string, string> {
  const urls = new Map<string, string>()
  for (const policy of response.evaluation.evaluatedPolicies ?? []) {
    if (policy.policyUrl !== undefined) urls.set(policy.policyId, policy.policyUrl)
  }
  return urls
}

function checkedLine(response: ScanResponse): string {
  const mapped = response.summary.componentsMapped
  if (mapped === 0) return NO_TRACKED_RESOURCES
  const subject = `${mapped} ${plural(mapped, 'component')} checked`
  const policies = response.evaluation.evaluatedPolicies
  if (!policies || policies.length === 0) return `${subject}.`
  return joinWithinLine(
    `${subject} against ${policies.length} ${plural(policies.length, 'policy', 'policies')}: `,
    policies.map((policy) => markdownCode(policy.name)),
  )
}

function countsLine(resources: ResourceEntry[], incompleteCount: number): string {
  const hits = resources.flatMap((resource) => resource.hits)
  const counts = statusCounts(hits)
  const parts = counts.length > 0 ? [counts.map((entry) => `**${entry}**`).join(', ')] : []
  const due = earliestDate(hits.map(isoDueDate))
  if (due) parts.push(`earliest due ${markdownCode(due)}`)
  if (incompleteCount > 0) parts.push(incompleteText(incompleteCount))
  return parts.join(' · ')
}

function incompleteText(count: number): string {
  return `${count} ${plural(count, 'check')} incomplete`
}

// "8 outdated", "4 impending", ... in urgency order; statuses outside the known set count as "other".
function statusCounts(hits: PolicyHit[]): string[] {
  const counts: string[] = []
  for (const [key, status] of KNOWN_STATUSES) {
    const count = hits.filter((hit) => statusKey(hit.status) === key).length
    if (count > 0) counts.push(`${count} ${status.label.toLowerCase()}`)
  }
  const other = hits.filter((hit) => !KNOWN_STATUSES.has(statusKey(hit.status))).length
  if (other > 0) counts.push(`${other} other`)
  return counts
}

function footerLine(response: ScanResponse, annotated: number | undefined, changed: number | undefined): string {
  const { managedResourcesInPlan, componentsMapped } = response.summary
  const parts = [
    `${managedResourcesInPlan} ${plural(managedResourcesInPlan, 'resource')} in plan`,
    ...(changed !== undefined ? [`${changed} changed`] : []),
    `${componentsMapped} mapped to Draftt ${plural(componentsMapped, 'component')}`,
  ]
  const merged = response.coverage.mergedResources.length
  const skipped = response.coverage.skippedResources.length
  if (merged > 0) parts.push(`${merged} merged into a parent`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (annotated !== undefined) parts.push(`${annotated} ${plural(annotated, 'resource')} annotated in Files changed`)
  const excluded = response.evaluation.excludedPolicyCount ?? 0
  if (excluded > 0) parts.push(`${excluded} ${plural(excluded, 'policy', 'policies')} excluded in this repository's Draftt CI settings`)
  parts.push(`[What these statuses mean](${DOCS_URL})`)
  return `<sub>${parts.join(' · ')}</sub>`
}

// Resources whose rows do not fit (past the budget, past 25, or a row over the line limit even with
// every detail dropped) are left out of `shown` and listed in the overflow block instead.
function violationTable(
  resources: ResourceEntry[],
  repository: ReportRepository | undefined,
  urls: ReadonlyMap<string, string>,
  room: number,
): { lines: string[]; shown: Set<ResourceEntry> } {
  const lines = ['| Resource | Status | Policy | Change needed |', '|---|---|---|---|']
  const shown = new Set<ResourceEntry>()
  let used = blockSize(lines)
  for (const resource of resources) {
    if (shown.size >= MAX_TABLE_RESOURCES) break
    const rows = resourceRows(resource, repository, urls)
    if (!rows) continue
    const size = rows.reduce((total, row) => total + row.length + 1, 0)
    if (used + size > room) break
    lines.push(...rows)
    used += size
    shown.add(resource)
  }
  return shown.size === 0 ? { lines: [], shown } : { lines, shown }
}

// One row per policy hit (identical hits collapse into one row with ×N); continuation rows show ″.
// Undefined when any row cannot fit the line limit: the resource then goes to the overflow list.
function resourceRows(resource: ResourceEntry, repository: ReportRepository | undefined, urls: ReadonlyMap<string, string>): string[] | undefined {
  const named = hasDistinctNames(resource.hits)
  const groups = groupHits(resource.hits, named)
  if (groups.length === 0) {
    const row = fitRow(resourceCells(resource, repository), '—', ['—', '—', '—'], ['—', '—', '—'])
    return row === undefined ? undefined : [row]
  }
  const rows: string[] = []
  for (const [index, group] of groups.slice(0, MAX_ROWS_PER_RESOURCE).entries()) {
    const resourceCell = index === 0 ? resourceCells(resource, repository) : ([DITTO, DITTO, DITTO] as const)
    const change = changeText(group.hit, resource.component, tableCode)
    const url = group.hit.policyId === undefined ? undefined : urls.get(group.hit.policyId)
    const row = fitRow(resourceCell, statusCell(group.hit.status), policyCells(group, named, url), [change.full, change.short, '—'])
    if (row === undefined) return undefined
    rows.push(row)
  }
  const hidden = groups.slice(MAX_ROWS_PER_RESOURCE).reduce((total, group) => total + group.count, 0)
  if (hidden > 0) rows.push(`| ${DITTO} | | +${hidden} more | |`)
  return rows
}

// Rows are built from whole cells: a row past the line limit drops detail (the policy link, the source
// link, the component name, the from-version and date, the source line, then the target version)
// instead of being cut. A row that still does not fit is undefined, never cut and never an anonymous placeholder.
const ROW_STEPS: ReadonlyArray<readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]> = [
  [0, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [1, 2, 0],
  [1, 2, 1],
  [2, 2, 1],
  [2, 2, 2],
]

function fitRow(
  resource: readonly [string, string, string],
  status: string,
  policy: readonly [string, string, string],
  change: readonly [string, string, string],
): string | undefined {
  for (const [r, p, c] of ROW_STEPS) {
    const row = `| ${resource[r]} | ${status} | ${policy[p]} | ${change[c]} |`
    if (row.length <= MAX_SUMMARY_LINE_LENGTH) return row
  }
  return undefined
}

function resourceCells(resource: ResourceEntry, repository: ReportRepository | undefined): readonly [string, string, string] {
  const address = tableCode(resource.component.address)
  if (!resource.location) return [`${address}<br>${NO_SOURCE_LINE}`, `${address}<br>${NO_SOURCE_LINE}`, address]
  const where = tableCode(`${resource.location.path}:${resource.location.startLine}`)
  const plain = `${address}<br>${where}`
  const linked = repository && linkablePath(resource.location.path)
  return [linked ? `${address}<br>[${where}](${sourceUrl(repository, resource.location)})` : plain, plain, address]
}

function statusCell(status: string): string {
  return KNOWN_STATUSES.get(statusKey(status))?.label ?? tableCode(status)
}

// [linked, withName, plain]: the policy name links to its console page when the response has a URL
// for it; the component name (where names differ) and the ×N count follow the link.
function policyCells(group: HitGroup, named: boolean, url?: string): readonly [string, string, string] {
  const count = group.count > 1 ? ` ×${group.count}` : ''
  const policy = tableCode(group.hit.policyName)
  const component = named && group.hit.name ? ` · ${tableCode(group.hit.name)}` : ''
  const withName = `${policy}${component}${count}`
  const text = linkText(group.hit.policyName)
  const linked = url && text.trim() !== '' ? `[${text}](${url})${component}${count}` : withName
  return [linked, withName, `${policy}${count}`]
}

// "from → to by date, forced upgrade" from the hit; `code` is tableCode in the summary and
// plainValue in an annotation.
function changeText(hit: PolicyHit, component: FlaggedComponent, code: (value: string) => string): { full: string; short: string } {
  const target = hit.recommendedVersion ?? hit.desiredVersion
  const from = hit.currentVersion || component.currentVersion
  const parts: string[] = []
  if (target !== undefined) parts.push(from ? `${code(from)} → ${code(target)}` : `→ ${code(target)}`)
  if (hit.dueDate !== undefined) parts.push(`by ${code(hit.dueDate)}`)
  else if (hit.outdatedDate !== undefined && statusKey(hit.status) !== 'outdated') parts.push(`before ${code(hit.outdatedDate)}`)
  let full = parts.join(' ')
  if (hit.hasForceUpgrade) full = full ? `${full}, forced upgrade` : 'Forced upgrade'
  return { full: full || '—', short: target !== undefined ? `→ ${code(target)}` : '—' }
}

// Report scope 'changed': the findings on resources the pull request leaves as they are, collapsed, in the
// table's own layout and cap. Resources the table cannot hold (past 25, past `room`, or a row over the line
// limit) are counted on a closing line, a blank line below the table so GFM does not read it as a row.
function unchangedSection(
  entries: ResourceEntry[],
  repository: ReportRepository | undefined,
  urls: ReadonlyMap<string, string>,
  room: number,
): string[] {
  if (entries.length === 0) return []
  const findings = entries.reduce((count, entry) => count + entry.hits.length, 0)
  const open = [
    `<details><summary><strong>${findings} pre-existing ${plural(findings, 'finding')}</strong> on ${entries.length} unchanged ${plural(entries.length, 'resource')}</summary>`,
    '',
  ]
  const close = ['', '</details>']
  const more = (count: number) => `${count} more unchanged ${plural(count, 'resource')} not shown`
  const tableRoom = (tail: string[]) => room - [...open, ...tail, ...close].reduce((total, line) => total + line.length + 1, 0)
  // The closing line takes room only when some resource is left out.
  let table = violationTable(entries, repository, urls, tableRoom([]))
  if (table.shown.size < entries.length) table = violationTable(entries, repository, urls, tableRoom(['', more(entries.length)]))
  const hidden = entries.length - table.shown.size
  if (table.lines.length === 0) return [...open, more(hidden), ...close]
  return [...open, ...table.lines, ...(hidden > 0 ? ['', more(hidden)] : []), ...close]
}

// Resources the table could not hold: unmapped first, because they have no annotation either.
function overflowBlock(resources: ResourceEntry[], room: number): string[] {
  if (resources.length === 0) return []
  const unmapped = resources.filter((resource) => !resource.location)
  const ordered = [...unmapped, ...resources.filter((resource) => resource.location)]
  const noun = `${resources.length} more ${plural(resources.length, 'resource')} with violations`
  const summary = unmapped.length > 0 ? `${noun} (${unmapped.length} without a source line)` : noun
  const rows = ordered.map((resource) => ({ text: overflowLine(resource), entries: 1 }))
  return detailsBlock({ summary, header: [], rows, more: (count) => `- … ${count} more not shown` }, room)
}

function overflowLine(resource: ResourceEntry): string {
  const due = earliestDate(resource.hits.map(isoDueDate))
  const details = [statusCounts(resource.hits).join(', '), ...(due ? [`earliest due ${markdownCode(due)}`] : [])].join(', ')
  const where = resource.location ? '' : ` · ${NO_SOURCE_LINE}`
  const line = `- ${markdownCode(resource.component.address)}: ${details}${where}`
  // The entry is never dropped: an address too long for the line is replaced, its counts are kept.
  return line.length <= MAX_SUMMARY_LINE_LENGTH ? line : `- (address longer than the line limit): ${details}${where}`
}

interface DetailsSection {
  summary: string
  header: string[]
  rows: SectionRow[]
  more: (count: number) => string
}

// A row and the number of entries it stands for: one, or N for a "… N more <label>" row.
interface SectionRow {
  text: string
  entries: number
}

function incompleteSection(response: ScanResponse, incompleteCount: number): DetailsSection | undefined {
  if (incompleteCount === 0) return undefined
  const { unevaluatedPolicies, componentsWithGaps } = response.evaluation
  const unmapped = response.coverage.unmappedResources
  const gaps = componentsWithGaps.flatMap((component) => component.policyGaps.map((gap) => ({ address: component.address, gap })))
  const parts = [
    ...(unevaluatedPolicies.length > 0
      ? [`${unevaluatedPolicies.length} ${plural(unevaluatedPolicies.length, 'policy', 'policies')} not evaluated`]
      : []),
    ...(gaps.length > 0 ? [`${gaps.length} resource ${plural(gaps.length, 'check')} without a result`] : []),
    ...(unmapped.length > 0 ? [`${unmapped.length} ${plural(unmapped.length, 'resource')} not tracked by Draftt`] : []),
  ]
  const rows = [
    ...limitRows(
      unevaluatedPolicies.map((policy) =>
        fitLine([`| Policy ${tableCode(policy.name ?? policy.policyId)} | ${reasonText(UNEVALUATED_REASONS, policy.reason)} |`]),
      ),
      'policies',
    ),
    ...limitRows(
      gaps.map(({ address, gap }) => {
        const subject = `${tableCode(address)} · ${tableCode(gap.policyName)}`
        const reason = reasonText(GAP_REASONS, gap.reason)
        const missing = gap.reason === 'missing_data' && gap.missingAttributes && gap.missingAttributes.length > 0 ? gap.missingAttributes : undefined
        return fitLine([
          ...(missing ? [joinWithinLine(`| ${subject} | The plan does not contain `, missing.map(tableCode), ' |')] : []),
          `| ${subject} | ${reason} |`,
        ])
      }),
      'resource checks',
    ),
    ...limitRows(
      unmapped.map((resource) => fitLine([`| ${tableCode(resource.address)} | ${reasonText(UNMAPPED_REASONS, resource.reason)} |`])),
      'resources',
    ),
  ]
  return {
    summary: `<strong>${incompleteText(incompleteCount)}</strong>: ${parts.join(', ')}`,
    header: ['| Not checked | Why |', '|---|---|'],
    rows,
    more: (count) => `| … ${count} more not shown | |`,
  }
}

function limitRows(rows: string[], label: string): SectionRow[] {
  const shown = rows.slice(0, MAX_SECTION_ITEMS).map((text) => ({ text, entries: 1 }))
  const omitted = rows.length - shown.length
  return omitted > 0 ? [...shown, { text: `| … ${omitted} more ${label} | |`, entries: omitted }] : shown
}

// The first candidate within the line limit; never a cut line.
function fitLine(candidates: string[]): string {
  return (
    candidates.find((line) => line.length <= MAX_SUMMARY_LINE_LENGTH) ?? `| … entry omitted (longer than ${MAX_SUMMARY_LINE_LENGTH} characters) | |`
  )
}

function reasonText(known: Map<string, string>, reason: string): string {
  return known.get(reason) ?? tableCode(reason)
}

// A collapsed section that fits `room` characters: whole rows only, then "… N more not shown",
// and always closed with </details>. N counts entries, so a cut "… N more <label>" row adds its N.
function detailsBlock(section: DetailsSection, room: number): string[] {
  const open = [`<details><summary>${section.summary}</summary>`, '', ...section.header]
  const close = ['', '</details>']
  const lines = [...open]
  const total = section.rows.reduce((sum, row) => sum + row.entries, 0)
  let used = blockSize(open) + blockSize(close) + section.more(total).length + 1
  let shown = 0
  for (const row of section.rows) {
    if (used + row.text.length + 1 > room) break
    lines.push(row.text)
    used += row.text.length + 1
    shown += row.entries
  }
  if (shown < total) lines.push(section.more(total - shown))
  return [...lines, ...close]
}

// Annotation messages are plain text on GitHub, so values are capped and kept on one line, never fenced.
function formatViolation(resource: ResourceEntry): string {
  const total = resource.hits.length
  const named = hasDistinctNames(resource.hits)
  const lines = [`${total} policy ${plural(total, 'violation')} on ${plainValue(resource.component.address)}`]
  for (const group of groupHits(resource.hits, named)) {
    const { hit } = group
    const status = KNOWN_STATUSES.get(statusKey(hit.status))?.label ?? (hit.status.trim() ? plainValue(hit.status) : 'Unknown status')
    const policy = named && hit.name ? `${plainValue(hit.policyName)} · ${plainValue(hit.name)}` : plainValue(hit.policyName)
    lines.push('', `${status}: ${policy}${group.count > 1 ? ` ×${group.count}` : ''}`)
    const change = changeText(hit, resource.component, plainValue).full
    if (change !== '—') lines.push(`Change needed: ${change}`)
  }
  return lines.join('\n')
}

function hasDistinctNames(hits: PolicyHit[]): boolean {
  return new Set(hits.map((hit) => hit.name ?? '')).size > 1
}

function groupHits(hits: PolicyHit[], named: boolean): HitGroup[] {
  const groups = new Map<string, HitGroup>()
  for (const hit of hits) {
    const key = JSON.stringify([
      hit.policyId ?? hit.policyName,
      hit.policyName,
      statusKey(hit.status),
      named ? (hit.name ?? '') : '',
      hit.currentVersion ?? '',
      hit.recommendedVersion ?? hit.desiredVersion ?? '',
      hit.dueDate ?? '',
      hit.outdatedDate ?? '',
      hit.hasForceUpgrade === true,
    ])
    const group = groups.get(key)
    if (group) group.count += 1
    else groups.set(key, { hit, count: 1 })
  }
  return [...groups.values()]
}

function statusKey(status: string): string {
  return status.toLowerCase().replace(/[-_\s]+/g, '')
}

function statusLabel(status: string): string {
  return KNOWN_STATUSES.get(statusKey(status))?.label ?? 'Other'
}

function statusRank(status: string): number {
  return KNOWN_STATUSES.get(statusKey(status))?.rank ?? OTHER_STATUS_RANK
}

// The date a hit is due by: its due date, else when it becomes outdated, else when it became
// impending. Only ISO dates take part in sorting.
function hitDate(hit: PolicyHit): string | undefined {
  const date = hit.dueDate ?? hit.outdatedDate ?? hit.impendingDate
  return date !== undefined && ISO_DATE.test(date) ? date.slice(0, 10) : undefined
}

function isoDueDate(hit: PolicyHit): string | undefined {
  return hit.dueDate !== undefined && ISO_DATE.test(hit.dueDate) ? hit.dueDate.slice(0, 10) : undefined
}

function earliestDate(dates: Array<string | undefined>): string | undefined {
  let earliest: string | undefined
  for (const date of dates) if (date !== undefined && (earliest === undefined || date < earliest)) earliest = date
  return earliest
}

// Plain code-unit comparison, never localeCompare: the order must not depend on the runtime's ICU.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareHits(a: PolicyHit, b: PolicyHit): number {
  return (
    statusRank(a.status) - statusRank(b.status) ||
    compareText(hitDate(a) ?? NO_DATE, hitDate(b) ?? NO_DATE) ||
    compareText(a.policyName, b.policyName) ||
    compareText(a.name ?? '', b.name ?? '')
  )
}

function compareResources(a: ResourceEntry, b: ResourceEntry): number {
  return a.rank - b.rank || compareText(a.sortDate, b.sortDate) || compareText(a.component.address, b.component.address)
}

// Characters a block adds to the summary: each line and its newline, plus the blank separator line.
function blockSize(lines: string[]): number {
  return lines.length === 0 ? 0 : lines.reduce((total, line) => total + line.length + 1, 1)
}

// encodeURIComponent leaves ! ' ( ) * alone; ( and ) would end a Markdown link destination.
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

// A link is built only when every path segment, decoded, is a real name: an empty, `.` or `..` segment
// (even percent-encoded) would let the URL leave the repository's blob tree.
function linkablePath(path: string): boolean {
  return path.split('/').every((segment) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    return decoded !== '' && decoded !== '.' && decoded !== '..'
  })
}

function sourceUrl(repository: ReportRepository, location: SourceLocation): string {
  const path = location.path.split('/').map(encodeSegment).join('/')
  return `${GITHUB_WEB_URL}/${encodeSegment(repository.owner)}/${encodeSegment(repository.repo)}/blob/${encodeSegment(repository.headSha)}/${path}#L${location.startLine}`
}

// Every value that originates from the plan, fetcher or analyzer is capped and kept on one line.
function plainValue(value: string): string {
  const capped = value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value
  return capped.replace(/[\r\n]+/g, ' ')
}

// Link text from an untrusted value: capped and on one line, with every character that could end the
// link (\ [ ] ( )), open a code span or HTML (` <) or split a table cell (|) backslash-escaped. Inside a
// link GitHub turns no @mention, #ref or URL into a link of its own.
export function linkText(value: string): string {
  return plainValue(value).replace(/[\\`[\]()<|]/g, '\\$&')
}

// Every value that originates from the plan, fetcher or analyzer is rendered as a code span:
// inside backticks, @mentions, links, images, HTML and #refs are literal. Capped so one
// for_each key cannot fill the comment.
export function markdownCode(value: string): string {
  const singleLine = plainValue(value)
  // Two bare backticks are not an empty span: they would pair with the next value's opening fence.
  if (singleLine.length === 0) return '` `'
  const longestRun = Math.max(0, ...Array.from(singleLine.matchAll(/`+/g), (match) => match[0].length))
  const delimiter = '`'.repeat(longestRun + 1)
  const padding = singleLine.startsWith('`') || singleLine.endsWith('`') ? ' ' : ''
  return `${delimiter}${padding}${singleLine}${padding}${delimiter}`
}

// A code span inside a table cell. GFM splits cells on | even inside backticks, which would leave
// the span open and render the rest as Markdown; \| keeps the pipe in the cell and shows as |.
export function tableCode(value: string): string {
  return markdownCode(value).replace(/\|/g, '\\|')
}

// A line built from whole code spans: it stops before the span that would pass the line limit and
// says how many were left out, so no cut can leave a code span open.
function joinWithinLine(prefix: string, spans: string[], suffix = ''): string {
  const moreRoom = ` +${spans.length} more`.length
  let line = prefix
  for (const [index, span] of spans.entries()) {
    const candidate = index === 0 ? `${line}${span}` : `${line}, ${span}`
    const isLast = index === spans.length - 1
    if (candidate.length + suffix.length + (isLast ? 0 : moreRoom) > MAX_SUMMARY_LINE_LENGTH) {
      return `${line} +${spans.length - index} more${suffix}`
    }
    line = candidate
  }
  return `${line}${suffix}`
}

// At most `maximum` characters, cut before a space (no ellipsis); a single longer word is sliced.
export function cutOnWord(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const space = value.lastIndexOf(' ', maximum)
  const cut = space > 0 ? value.slice(0, space).trimEnd() : ''
  return cut === '' ? value.slice(0, maximum) : cut
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 14)}\n… truncated`
}

// An annotation message is capped at 60,000 UTF-8 bytes, never in the middle of a character.
function truncateBytes(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value
  const marker = '\n… truncated'
  const kept = Buffer.from(value)
    .subarray(0, maximumBytes - Buffer.byteLength(marker))
    .toString('utf8')
    .replace(/�+$/, '')
  return `${kept}${marker}`
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}
