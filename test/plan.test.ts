import assert from 'node:assert/strict'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_PLAN_BYTES, readAndSanitizePlan, sanitizePlan, serializeScanRequest } from '../src/plan.ts'

function basePlan(): Record<string, unknown> {
  return {
    format_version: '1.2',
    terraform_version: '1.12.0',
    planned_values: { root_module: { resources: [{ values: { password: 'planned-secret' } }] } },
    prior_state: { values: { password: 'prior-secret' } },
    output_changes: { password: { after: 'output-secret' } },
    checks: [{ secret: 'check-secret' }],
    resource_changes: [
      {
        address: 'aws_db_instance.primary',
        mode: 'managed',
        type: 'aws_db_instance',
        name: 'primary',
        change: {
          actions: ['update'],
          before: {
            identifier: 'database',
            password: 'before-secret',
            kms_key_id: 'arn:aws:kms:us-east-1:111111111111:key/example',
            cluster_identifier: 'cluster',
          },
          after: {
            identifier: 'database',
            password: 'after-secret',
            kms_key_id: 'arn:aws:kms:us-east-1:111111111111:key/example',
            cluster_identifier: 'cluster',
            endpoint: 'known-later',
          },
          before_sensitive: { password: true },
          after_sensitive: { password: true },
          after_unknown: { endpoint: true },
        },
      },
      {
        address: 'custom_widget.example',
        mode: 'managed',
        type: 'custom_widget',
        name: 'example',
        change: {
          actions: ['create'],
          before: null,
          after: { display_name: 'widget', client_secret: 'unmarked-secret' },
          before_sensitive: false,
          after_sensitive: false,
          after_unknown: {},
        },
      },
      {
        address: 'data.aws_caller_identity.current',
        mode: 'data',
        type: 'aws_caller_identity',
        name: 'current',
        change: {
          actions: ['read'],
          before: null,
          after: { account_id: '111111111111' },
          before_sensitive: false,
          after_sensitive: false,
          after_unknown: {},
        },
      },
      {
        address: 'data.aws_region.current',
        mode: 'data',
        type: 'aws_region',
        name: 'current',
        change: { actions: ['read'], after: { name: 'us-east-1' }, after_unknown: {} },
      },
    ],
    configuration: {
      provider_config: {
        aws: {
          expressions: {
            region: { references: ['var.aws_region'] },
            access_key: { constant_value: 'provider-access-key' },
            secret_key: { constant_value: 'provider-secret-key' },
            assume_role: [{
              role_arn: { references: ['var.aws_role_arn'] },
              external_id: { constant_value: 'provider-external-id' },
            }],
          },
        },
      },
      root_module: {
        resources: [
          {
            address: 'aws_db_instance.primary',
            mode: 'managed',
            type: 'aws_db_instance',
            name: 'primary',
            provider_config_key: 'aws',
            expressions: {
              identifier: { constant_value: 'database' },
              password: { constant_value: 'configuration-secret' },
              cluster_identifier: { references: ['aws_rds_cluster.primary.id'] },
              kms_key_id: { constant_value: 'arn:aws:kms:us-east-1:111111111111:key/example' },
            },
          },
          {
            address: 'custom_widget.example',
            mode: 'managed',
            type: 'custom_widget',
            name: 'example',
            provider_config_key: 'aws',
            expressions: { display_name: { constant_value: 'widget' } },
          },
          {
            address: 'data.aws_caller_identity.current',
            mode: 'data',
            type: 'aws_caller_identity',
            name: 'current',
            provider_config_key: 'aws',
          },
          {
            address: 'data.aws_region.current',
            mode: 'data',
            type: 'aws_region',
            name: 'current',
            provider_config_key: 'aws',
          },
        ],
      },
    },
    variables: {
      aws_region: { value: 'us-east-1' },
      aws_role_arn: { value: 'arn:aws:iam::111111111111:role/terraform' },
      database_password: { value: 'variable-secret' },
      unused_region: { value: 'eu-west-1' },
    },
  }
}

test('projects only Fetcher inputs and removes sensitive values without removing mapping evidence', () => {
  const sanitized = sanitizePlan(basePlan())
  const serialized = JSON.stringify(sanitized)

  assert.deepEqual(Object.keys(sanitized), ['format_version', 'resource_changes', 'configuration', 'variables'])
  for (const secret of [
    'planned-secret',
    'prior-secret',
    'output-secret',
    'check-secret',
    'before-secret',
    'after-secret',
    'unmarked-secret',
    'configuration-secret',
    'provider-access-key',
    'provider-secret-key',
    'provider-external-id',
    'variable-secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`)
  }

  assert.equal(sanitized.resource_changes.length, 3)
  const rds = sanitized.resource_changes[0]
  assert.ok(rds)
  const rdsChange = rds.change as Record<string, Record<string, unknown>>
  const before = rdsChange.before
  const after = rdsChange.after
  const afterUnknown = rdsChange.after_unknown
  assert.ok(before)
  assert.ok(after)
  assert.ok(afterUnknown)
  assert.equal('password' in before, false)
  assert.equal('password' in after, false)
  assert.equal(afterUnknown.endpoint, true)
  assert.equal(after.kms_key_id, 'arn:aws:kms:us-east-1:111111111111:key/example')
  assert.equal(after.cluster_identifier, 'cluster')

  assert.deepEqual(sanitized.variables, {
    aws_region: { value: 'us-east-1' },
    aws_role_arn: { value: 'arn:aws:iam::111111111111:role/terraform' },
  })
  assert.equal(serialized.includes('data.aws_region.current'), false)
})

test('uses the union of before and after sensitive mirrors on both update values', () => {
  const plan = basePlan()
  const resource = (plan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(resource)
  const change = resource.change as Record<string, unknown>
  change.before = { password: 'before', username: 'admin', nested: { client_secret: 'remove', second: 'keep' } }
  change.after = { password: 'after', username: 'admin', nested: { client_secret: 'remove', second: 'keep' } }
  change.before_sensitive = { nested: { client_secret: true } }
  change.after_sensitive = { password: true }

  const sanitized = sanitizePlan(plan)
  const projected = sanitized.resource_changes[0]?.change as Record<string, Record<string, unknown>>
  assert.deepEqual(projected.before, { username: 'admin', nested: { second: 'keep' } })
  assert.deepEqual(projected.after, { username: 'admin', nested: { second: 'keep' } })
})

test('rejects marked sensitive fields that could be policy evidence', () => {
  const plan = basePlan()
  const resource = (plan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(resource)
  const change = resource.change as Record<string, unknown>
  change.before = { values: ['first', 'secret', 'third'] }
  change.after = { values: ['first', 'secret', 'third'] }
  change.before_sensitive = { values: [false, true, false] }
  change.after_sensitive = {}
  assert.throws(() => sanitizePlan(plan), /unsupported sensitive field at before_sensitive\.values\.1/)
})

test('rejects an unmarked recognized credential left in a retained field', () => {
  const plan = basePlan()
  const resource = (plan.resource_changes as Array<Record<string, unknown>>)[1]
  assert.ok(resource)
  const change = resource.change as Record<string, unknown>
  change.after = { description: 'credential AKIA1234567890ABCDEF' }
  assert.throws(() => sanitizePlan(plan), /recognized AWS access key at plan\.resource_changes/)
})

test('serializes explicit empty policy selection', () => {
  const body = JSON.parse(serializeScanRequest(sanitizePlan(basePlan()), [])) as Record<string, unknown>
  assert.deepEqual(body.policyIds, [])
})

test('removes named secret fields from unknown-value mirrors', () => {
  const plan = basePlan()
  const resource = (plan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(resource)
  const change = resource.change as Record<string, unknown>
  change.after_unknown = { endpoint: true, password: true }
  const sanitized = sanitizePlan(plan)
  const projected = sanitized.resource_changes[0]?.change as Record<string, Record<string, unknown>>
  assert.deepEqual(projected.after_unknown, { endpoint: true })
})

test('rejects oversized and outside-workspace plan files before parsing', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'terraform-plan-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'terraform-plan-outside-'))
  try {
    const oversizedPath = path.join(workspace, 'oversized.json')
    const file = await open(oversizedPath, 'w')
    await file.truncate(MAX_PLAN_BYTES + 1)
    await file.close()
    await assert.rejects(() => readAndSanitizePlan('oversized.json', workspace), /50 MiB input limit/)

    const outsidePlan = path.join(outside, 'plan.json')
    await writeFile(outsidePlan, JSON.stringify({ format_version: '1.2', resource_changes: [] }))
    await symlink(outsidePlan, path.join(workspace, 'linked.json'))
    await assert.rejects(() => readAndSanitizePlan('linked.json', workspace), /could not be read/)
    await assert.rejects(() => readAndSanitizePlan('../plan.json', workspace), /must stay inside the workspace/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('rejects unsupported plan shapes without including plan contents in the error', () => {
  const secret = 'do-not-echo-this-secret'
  assert.throws(
    () => sanitizePlan({ format_version: '2.0', resource_changes: [], secret }),
    (error: unknown) => error instanceof Error && !error.message.includes(secret) && error.message.includes('unsupported format_version'),
  )
})

test('rejects malformed actions and mirrors before serialization', () => {
  const invalidActionPlan = basePlan()
  const actionResource = (invalidActionPlan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(actionResource)
  ;(actionResource.change as Record<string, unknown>).actions = ['send-secret']
  assert.throws(() => sanitizePlan(invalidActionPlan), /invalid actions/)

  const invalidMirrorPlan = basePlan()
  const mirrorResource = (invalidMirrorPlan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(mirrorResource)
  ;(mirrorResource.change as Record<string, unknown>).after_unknown = { metadata: 'unrecognized-plain-secret' }
  assert.throws(
    () => sanitizePlan(invalidMirrorPlan),
    (error: unknown) => error instanceof Error && error.message.includes('invalid value mirror') && !error.message.includes('unrecognized-plain-secret'),
  )
})
