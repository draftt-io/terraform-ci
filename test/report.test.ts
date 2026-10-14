import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseScanResponse } from '../src/contracts.ts'
import { buildScanReport, markdownCode, MAX_SUMMARY_LINE_LENGTH, MAX_VALUE_CHARS, SUMMARY_BUDGET, tableCode, type SourceLocator } from '../src/report.ts'
import { TerraformSourceLocator } from '../src/source-locator.ts'
import { scanResponse } from './fixtures.ts'

const HOSTILE = '@octocat [click](https://evil.test) ![x](https://evil.test/i.png) <img src=x onerror=1> #1 `tick` | pipe \\| pipe'
const stripCodeSpans = (markdown: string): string => markdown.replace(/(`+)[\s\S]*?\1/g, '')
const cellDelimiters = (row: string): number => row.match(/(?<!\\)\|/g)?.length ?? 0
const tableRows = (summary: string): string[] => summary.split('\n').filter((line) => line.startsWith('| '))
const foundEverywhere: SourceLocator = { locate: async () => ({ kind: 'found', location: { path: 'main.tf', startLine: 1 } }) }

test('creates one plain-text source annotation per violating component', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'terraform-report-'))
  try {
    await writeFile(path.join(repository, 'main.tf'), 'resource "aws_db_instance" "primary" {}\n')
    const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
    const report = await buildScanReport(scanResponse(), locator, 'warning', false)
    assert.equal(report.violationCount, 1)
    assert.equal(report.annotations.length, 1)
    assert.deepEqual(report.annotations[0], {
      path: 'main.tf',
      start_line: 1,
      end_line: 1,
      annotation_level: 'warning',
      title: 'Outdated: 1 policy violation on aws_db_instance',
      message: ['1 policy violation on aws_db_instance.primary', '', 'Outdated: Supported version', 'Change needed: 14 → 16'].join('\n'),
    })
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test('puts the due date in the change needed line of the annotation', async () => {
  const response = scanResponse()
  const policy = response.components[0]?.policyComponents[0]
  assert.ok(policy)
  policy.impendingDate = '2026-09-01'
  policy.outdatedDate = '2027-01-01'
  policy.dueDate = '2027-03-01'
  const report = await buildScanReport(response, foundEverywhere, 'warning', false)
  assert.match(report.annotations[0]?.message ?? '', /^Change needed: 14 → 16 by 2027-03-01$/m)
})

test('lists each policy hit under its status in the annotation message', async () => {
  const policies = ['tf-e2e-s3-public-access-blocked-v1', 'tf-e2e-s3-versioning-enabled-v1'].map((policyName) => ({ policyName, status: 'Non-Compliant' }))
  const response = scanResponse({
    components: [{ address: 'aws_s3_bucket.open', tfType: 'aws_s3_bucket', technology: 'aws-s3-bucket', type: 'aws-s3-bucket', currentVersion: '', policyComponents: policies }],
  })
  const report = await buildScanReport(response, foundEverywhere, 'warning', false)
  assert.equal(
    report.annotations[0]?.message,
    [
      '2 policy violations on aws_s3_bucket.open',
      '',
      'Non-compliant: tf-e2e-s3-public-access-blocked-v1',
      '',
      'Non-compliant: tf-e2e-s3-versioning-enabled-v1',
    ].join('\n'),
  )
})

test('leads with the no-policies warning and counts incomplete checks', async () => {
  const response = scanResponse({
    summary: { managedResourcesInPlan: 2, componentsMapped: 1, hasPolicyViolations: false },
    components: [],
    evaluation: {
      unevaluatedPolicies: [{ policyId: '11', reason: 'unsupported_policy' }],
      componentsWithGaps: [{ address: 'aws_db_instance.primary', policyGaps: [{ policyName: 'Version', reason: 'missing_data' }] }],
    },
    coverage: { unmappedResources: [{ address: 'custom_widget.example', reason: 'unknown_technology' }], mergedResources: [], skippedResources: [] },
  })
  const report = await buildScanReport(response, undefined, 'warning', true)
  assert.equal(report.title, 'No policies evaluated')
  assert.equal(report.warningCount, 4)
  assert.match(report.summary, /^> \[!WARNING\]\n> \*\*No policies were evaluated\.\*\* The workflow passes an empty `policy-ids` list\./)
  assert.match(report.summary, /<strong>3 checks incomplete<\/strong>: 1 policy not evaluated, 1 resource check without a result, 1 resource not tracked by Draftt/)
})

test('keeps 25 resources in the table and collapses the rest, unmapped first', async () => {
  const components = Array.from({ length: 150 }, (_, index) => ({ ...scanResponse().components[0]!, address: `module.application["${index}"].aws_db_instance.primary` }))
  const report = await buildScanReport(scanResponse({ summary: { managedResourcesInPlan: 150, componentsMapped: 150, hasPolicyViolations: true }, components }), undefined, 'warning', false)
  assert.equal(report.title, '150 policy violations on 150 resources')
  assert.match(report.summary, /<details><summary>125 more resources with violations \(125 without a source line\)<\/summary>/)
  assert.ok(report.summary.length <= SUMMARY_BUDGET)
})

test('renders every untrusted value as a code span so mentions, links, images, HTML and table pipes cannot fire', async () => {
  const base = scanResponse().components[0]!
  const response = scanResponse({
    components: [{ ...base, address: `module.a["${HOSTILE}"].aws_db_instance.primary`, policyComponents: [{ policyName: `Supported ${HOSTILE}`, status: 'outdated' }] }],
    evaluation: {
      unevaluatedPolicies: [{ policyId: '12', name: `Latest ${HOSTILE}`, reason: 'unsupported_policy' }],
      componentsWithGaps: [{ address: 'aws_db_instance.replica', policyGaps: [{ policyName: `Encrypted ${HOSTILE}`, reason: 'missing_data' }] }],
    },
    coverage: { unmappedResources: [{ address: `aws_s3_bucket.b["${HOSTILE}"]`, reason: 'unknown_technology' }], mergedResources: [], skippedResources: [] },
  })
  const report = await buildScanReport(response, undefined, 'warning', false)
  const rendered = stripCodeSpans(report.summary)
  for (const fragment of ['@octocat', '[click](', '![x](', '<img', 'pipe', '`']) assert.equal(rendered.includes(fragment), false, fragment)
  for (const row of tableRows(report.summary)) assert.ok([3, 5].includes(cellDelimiters(row)), row)
})

test('caps each rendered value at 200 characters', async () => {
  const long = 'x'.repeat(500)
  const report = await buildScanReport(
    scanResponse({ coverage: { unmappedResources: [{ address: long, reason: 'no_version' }], mergedResources: [], skippedResources: [] } }),
    undefined,
    'warning',
    false,
  )
  assert.ok(report.summary.includes('x'.repeat(MAX_VALUE_CHARS - 1) + '…'))
  assert.equal(report.summary.includes('x'.repeat(MAX_VALUE_CHARS + 1)), false)
})

test('drops row detail instead of cutting a span when a violation row passes the line limit', async () => {
  const base = scanResponse().components[0]!
  const component = {
    ...base,
    address: 'a'.repeat(190),
    currentVersion: 'v'.repeat(190),
    policyComponents: [{ policyName: 'p'.repeat(60), status: 'outdated', recommendedVersion: 'w'.repeat(100), dueDate: '2027-01-01' }],
  }
  const locator: SourceLocator = { locate: async () => ({ kind: 'found', location: { path: `${'d'.repeat(150)}/main.tf`, startLine: 12 } }) }
  const report = await buildScanReport(scanResponse({ components: [component] }), locator, 'warning', false, {
    repository: { owner: 'draftt-io', repo: 'terraform-demo', headSha: '3f9c2a17be0d44a1c9e8f0a6d2b5e7c1a4f60d9b' },
  })
  const row = tableRows(report.summary).find((candidate) => candidate.startsWith(`| \`${'a'.repeat(190)}\``)) ?? ''
  assert.ok(row.length > 0 && row.length <= MAX_SUMMARY_LINE_LENGTH)
  assert.equal(row.includes('main.tf'), false)
  assert.ok(row.includes(`| → \`${'w'.repeat(100)}\` |`))
  assert.equal(cellDelimiters(row), 5)
})

test('markdownCode fences backtick runs and pads edge backticks; tableCode also escapes pipes', () => {
  assert.equal(markdownCode('a`b'), '``a`b``')
  assert.equal(markdownCode('`x'), '`` `x ``')
  assert.equal(markdownCode('line\nbreak'), '`line break`')
  assert.equal(markdownCode(''), '` `')
  assert.equal(tableCode('a|b'), '`a\\|b`')
})

test('caps an annotation message at 60,000 UTF-8 bytes without splitting a character', async () => {
  const base = scanResponse().components[0]!
  // Far more bytes than characters: a character cap would let this message through.
  const policyComponents = Array.from({ length: 300 }, (_, index) => ({ policyName: `${index} ${'€'.repeat(199)}`, status: 'outdated' }))
  const report = await buildScanReport(scanResponse({ components: [{ ...base, policyComponents }] }), foundEverywhere, 'warning', false)
  const message = report.annotations[0]?.message ?? ''
  assert.ok(Buffer.byteLength(message) <= 60_000)
  assert.ok(message.endsWith('\n… truncated'))
  assert.equal(message.includes('�'), false)
})

interface ParityCase {
  name: string
  response: unknown
  sourceMap?: Record<string, { path: string; startLine: number }>
  repository?: { owner: string; repo: string; headSha: string }
  annotationLevel: 'warning' | 'failure'
  noPoliciesSelected: boolean
  expected: unknown
}

test('matches every case of the parity fixture shared with draftt-ci', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8')) as { cases: ParityCase[] }
  assert.deepEqual(
    fixture.cases.map((entry) => entry.name),
    [
      'violations',
      'no policies selected',
      'twelve violations with mixed statuses',
      'zero violations with warnings',
      'no policies evaluated',
      'overflow above the table budget',
      'no Draftt-tracked resources',
      'row over the line limit',
      'exclusions footer',
      'every evaluated policy excluded',
      'excluded policy not evaluated',
    ],
  )
  for (const entry of fixture.cases) {
    // The service's sourceMapLocator, rebuilt here: the Action itself has no address map locator.
    const sourceMap = entry.sourceMap
    const locator: SourceLocator | undefined = sourceMap
      ? {
          async locate(reference) {
            const key = reference.sourceAddress ?? reference.address
            const location = Object.hasOwn(sourceMap, key) ? sourceMap[key] : undefined
            return location ? { kind: 'found', location } : { kind: 'unresolved', reason: 'missing_declaration' }
          },
        }
      : undefined
    // The service renders the ui-backend-shaped response after parseScanResponse; so does this test.
    const report = await buildScanReport(
      parseScanResponse(entry.response),
      locator,
      entry.annotationLevel,
      entry.noPoliciesSelected,
      entry.repository ? { repository: entry.repository } : {},
    )
    assert.deepEqual({ title: report.title, summary: report.summary, annotations: report.annotations }, entry.expected, entry.name)
  }
})

test('parity pin equals e36bf9a3…948e', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8')) as { sharedBlockSha256: string }
  assert.equal(fixture.sharedBlockSha256, 'e36bf9a38decba0d720f3668ad79c31b6154fea8dfabb31f176db519ebba948e')
})
