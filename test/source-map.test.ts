import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceLocator } from '../src/report.ts'
import { buildSourceMap, MAX_SOURCE_MAP_ENTRIES } from '../src/source-map.ts'

const locator: SourceLocator = {
  async locate(reference) {
    const known: Record<string, { path: string; startLine: number }> = {
      'module.a["k"].aws_s3_bucket.b[0]': { path: 'modules/a/main.tf', startLine: 3 },
      'aws_instance.web': { path: 'ec2.tf', startLine: 10 },
    }
    const location = known[reference.address]
    return location ? { kind: 'found', location } : { kind: 'unresolved', reason: 'missing_declaration' }
  },
}

test('keys are exact plan addresses of retained managed resources being created, updated or kept', async () => {
  const plan = {
    format_version: '1.2',
    resource_changes: [
      { address: 'module.a["k"].aws_s3_bucket.b[0]', mode: 'managed', change: { actions: ['create'] } },
      { address: 'aws_instance.web', mode: 'managed', change: { actions: ['no-op'] } },
      { address: 'aws_instance.gone', mode: 'managed', change: { actions: ['delete'] } },
      { address: 'data.aws_caller_identity.me', mode: 'data', change: { actions: ['read'] } },
      { address: 'aws_db_instance.unknown', mode: 'managed', change: { actions: ['update'] } },
    ],
  }
  const { sourceMap, capped } = await buildSourceMap(plan, locator)
  assert.equal(capped, false)
  assert.deepEqual(sourceMap, {
    'module.a["k"].aws_s3_bucket.b[0]': { path: 'modules/a/main.tf', startLine: 3 },
    'aws_instance.web': { path: 'ec2.tf', startLine: 10 },
  })
})

test("stops at the server's source-map entry limit and reports the cap", async () => {
  const resourceChanges = Array.from({ length: MAX_SOURCE_MAP_ENTRIES + 1 }, (_, index) => ({ address: `aws_instance.web_${index}`, mode: 'managed', change: { actions: ['create'] } }))
  const everyAddress: SourceLocator = { locate: async () => ({ kind: 'found', location: { path: 'ec2.tf', startLine: 1 } }) }
  const { sourceMap, capped } = await buildSourceMap({ format_version: '1.2', resource_changes: resourceChanges }, everyAddress)
  assert.equal(capped, true)
  assert.equal(Object.keys(sourceMap).length, MAX_SOURCE_MAP_ENTRIES)
})
