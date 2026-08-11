import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildScanReport } from '../src/report.ts'
import { TerraformSourceLocator } from '../src/source-locator.ts'
import { scanResponse } from './fixtures.ts'

test('creates one source annotation per violating component', async () => {
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
      title: 'Draftt policy violation: aws_db_instance',
      message: [
        'Terraform resource: aws_db_instance.primary',
        'Component: RDS postgres',
        'Current version: 14',
        '',
        '- Supported version: outdated; recommended 16',
      ].join('\n'),
    })
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test('includes available lifecycle dates in violation annotations', async () => {
  const response = scanResponse()
  const component = response.components[0]
  assert.ok(component)
  const policy = component.policyComponents[0]
  assert.ok(policy)
  policy.impendingDate = '2026-09-01'
  policy.outdatedDate = '2027-01-01'
  policy.dueDate = '2027-03-01'

  const repository = await mkdtemp(path.join(tmpdir(), 'terraform-report-dates-'))
  try {
    await writeFile(path.join(repository, 'main.tf'), 'resource "aws_db_instance" "primary" {}\n')
    const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
    const annotated = await buildScanReport(response, locator, 'warning', false)
    assert.match(annotated.annotations[0]?.message ?? '', /impending date 2026-09-01/)
    assert.match(annotated.annotations[0]?.message ?? '', /outdated date 2027-01-01/)
    assert.match(annotated.annotations[0]?.message ?? '', /due date 2027-03-01/)
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test('warns for incomplete results and an explicit empty policy selection', async () => {
  const response = scanResponse({
    summary: { managedResourcesInPlan: 2, componentsMapped: 1, hasPolicyViolations: false },
    components: [],
    evaluation: {
      unevaluatedPolicies: [{ policyId: '11', reason: 'unsupported_policy' }],
      componentsWithGaps: [{
        address: 'aws_db_instance.primary',
        policyGaps: [{ policyName: 'Version', reason: 'missing_data' }],
      }],
    },
    coverage: {
      unmappedResources: [{ address: 'custom_widget.example', reason: 'unknown_technology' }],
      mergedResources: [],
      skippedResources: [],
    },
  })
  const report = await buildScanReport(response, undefined, 'warning', true)
  assert.equal(report.warningCount, 4)
  assert.match(report.summary, /selected 0 policies/)
  assert.match(report.summary, /Unmapped resources/)
})

test('bounds long summary sections and reports omitted findings', async () => {
  const components = Array.from({ length: 150 }, (_, index) => ({
    ...scanResponse().components[0]!,
    address: `module.application["${index}"].aws_db_instance.primary`,
  }))
  const response = scanResponse({
    summary: { managedResourcesInPlan: 150, componentsMapped: 150, hasPolicyViolations: true },
    components,
  })
  const report = await buildScanReport(response, undefined, 'warning', false)
  assert.match(report.summary, /125 additional violations omitted/)
  assert.ok(report.summary.length <= 60_000)
})
