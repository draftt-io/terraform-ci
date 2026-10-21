import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseScanResponse } from '../src/contracts.ts'
import { buildScanReport, type SourceLocator } from '../src/report.ts'
import { TerraformSourceLocator } from '../src/source-locator.ts'
import { scanResponse } from './fixtures.ts'

const foundEverywhere: SourceLocator = { locate: async () => ({ kind: 'found', location: { path: 'main.tf', startLine: 1 } }) }

test('creates one plain-text source annotation per violating component', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'terraform-report-'))
  try {
    await writeFile(path.join(repository, 'main.tf'), 'resource "aws_db_instance" "primary" {}\n')
    const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
    const report = await buildScanReport({ response: scanResponse(), locator, annotationLevel: 'warning', noPoliciesSelected: false })
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

test('caps an annotation message at 60,000 UTF-8 bytes without splitting a character', async () => {
  const base = scanResponse().components[0]!
  // Far more bytes than characters: a character cap would let this message through.
  const policyComponents = Array.from({ length: 300 }, (_, index) => ({ policyName: `${index} ${'€'.repeat(199)}`, status: 'outdated' }))
  const report = await buildScanReport({
    response: scanResponse({ components: [{ ...base, policyComponents }] }),
    locator: foundEverywhere,
    annotationLevel: 'warning',
    noPoliciesSelected: false,
  })
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

test('matches every case of the parity fixture shared with ui-backend', async () => {
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
    const report = await buildScanReport({
      response: parseScanResponse(entry.response),
      annotationLevel: entry.annotationLevel,
      noPoliciesSelected: entry.noPoliciesSelected,
      ...(locator ? { locator } : {}),
      ...(entry.repository ? { repository: entry.repository } : {}),
    })
    assert.deepEqual({ title: report.title, summary: report.summary, annotations: report.annotations }, entry.expected, entry.name)
  }
})

const MARKER = '// ---- Shared renderer'

test('keeps the shared renderer block at the hash pinned in the parity fixture shared with ui-backend', () => {
  // Hashed bytes: from the start of the first line beginning with the marker to the end of report.ts.
  const source = readFileSync(new URL('../src/report.ts', import.meta.url))
  const marker = source.indexOf(`\n${MARKER}`) + 1
  assert.ok(marker > 0, 'shared renderer marker line not found in src/report.ts')
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8')) as { sharedBlockSha256: string }
  assert.equal(fixture.sharedBlockSha256, 'f76e76cd709fce972f31557005867049dcf1f3dede141b9862282186f6f2408e')
  assert.equal(
    createHash('sha256').update(source.subarray(marker)).digest('hex'),
    fixture.sharedBlockSha256,
    'report.ts shared block changed: update sharedBlockSha256 in test/fixtures/parity.json and copy both the block and parity.json to ui-backend (src/services/githubDrafttCi/report/scanReport.ts, src/__tests__/fixtures/parity.json)',
  )
})
