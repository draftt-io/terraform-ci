import assert from 'node:assert/strict'
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MAX_PLAN_BYTES, MAX_PLAN_FILE_BYTES, readAndSanitizePlan, sanitizePlan, serializeScanRequest } from '../src/plan.ts'

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

test('scrubs provider-marked sensitive fields from real aws, random, helm, and mq resources', () => {
  const plan = basePlan()
  const resource = (plan.resource_changes as Array<Record<string, unknown>>)[0]
  assert.ok(resource)
  const change = resource.change as Record<string, unknown>
  change.before = null
  change.after = {
    secret_string_wo: 'write-only secret',
    secret_binary_wo: 'd3JpdGUtb25seQ==',
    result: 'generated-password',
    repository_password: 'helm-repo-password',
    user: [{ username: 'mq-admin', password: 'mq-password' }],
    engine_type: 'ActiveMQ',
  }
  change.before_sensitive = false
  change.after_sensitive = {
    secret_string_wo: true,
    secret_binary_wo: true,
    result: true,
    repository_password: true,
    user: [true],
  }

  const sanitized = sanitizePlan(plan)
  const projected = sanitized.resource_changes[0]?.change as Record<string, Record<string, unknown>>
  assert.deepEqual(projected.after, { engine_type: 'ActiveMQ' })
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
  const body = JSON.parse(serializeScanRequest(sanitizePlan(basePlan()), []).body) as Record<string, unknown>
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
    await file.truncate(MAX_PLAN_FILE_BYTES + 1)
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

test('serializeScanRequest drops the source map first when the body would exceed the request limit', () => {
  // A plan just under the 49 MiB plan cap: the plan alone fits, the plan plus a 1.3 MB map does not.
  const plan = { format_version: '1.2', resource_changes: [{ padding: 'x'.repeat(MAX_PLAN_BYTES - 50_000) }] }
  const sourceMap = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`r.${i}`, { path: 'x'.repeat(100), startLine: 1 }]))
  const github = { repositoryId: 1, repositoryOwnerId: 2, pullRequestNumber: 3, headSha: 'a'.repeat(40), scanKey: '.', runId: 1, runAttempt: 1, sourceMap }
  const { body, sourceMapDropped } = serializeScanRequest(plan, undefined, github)
  assert.equal(sourceMapDropped, true)
  assert.equal(JSON.parse(body).github.sourceMap, undefined)
  assert.equal(JSON.parse(body).github.scanKey, '.')

  const small = { format_version: '1.2', resource_changes: [{ address: 'a.b', change: { after: { name: 'café "q" \\' } } }] }
  const smallGithub = { ...github, sourceMap: { 'a.b': { path: 'a.tf', startLine: 1 } } }
  assert.deepEqual(serializeScanRequest(small, ['1'], smallGithub), { body: JSON.stringify({ plan: small, policyIds: ['1'], github: smallGithub }), sourceMapDropped: false })
})

test('refuses a serialized plan over 49 MiB, and a request over 50 MiB even when the plan fits', () => {
  const oversizedPlan = { format_version: '1.2', resource_changes: [{ padding: 'x'.repeat(Math.round(49.5 * 1024 * 1024)) }] }
  assert.throws(
    () => serializeScanRequest(oversizedPlan, undefined),
    (error: unknown) => error instanceof Error && error.message === 'The Terraform plan is larger than 49 MiB, the most Draftt CI accepts. Scan a smaller root module with terraform-root, or split the plan.',
  )
  const plan = { format_version: '1.2', resource_changes: [{ padding: 'x'.repeat(MAX_PLAN_BYTES - 50_000) }] }
  // About 1.3 MB of policy ids push the request over 50 MiB; there is no source map to drop.
  const policyIds = Array.from({ length: 100_000 }, (_, i) => String(1_000_000_000 + i))
  assert.throws(() => serializeScanRequest(plan, policyIds), /Scrubbed scan request exceeds the 50 MiB request limit/)
})

test('strips assume_role_policy when marked sensitive', () => {
  const trustPolicy = '{"Statement":[{"Action":"sts:AssumeRole","Principal":{"Service":"ec2.amazonaws.com"}}]}'
  const role = { address: 'aws_iam_role.app', mode: 'managed', type: 'aws_iam_role', name: 'app' }
  const plan = {
    format_version: '1.2',
    resource_changes: [{
      ...role,
      change: {
        actions: ['create'],
        before: null,
        after: { name: 'app', assume_role_policy: trustPolicy, max_session_duration: 3600 },
        before_sensitive: false,
        after_sensitive: { assume_role_policy: true },
        after_unknown: { arn: true, assume_role_policy: false },
      },
    }],
    configuration: { root_module: { resources: [{ ...role, expressions: { name: { constant_value: 'app' }, assume_role_policy: { constant_value: trustPolicy } } }] } },
  }

  const serialized = JSON.stringify(sanitizePlan(plan))
  assert.equal(serialized.includes('assume_role_policy'), false)
  assert.equal(serialized.includes('sts:AssumeRole'), false)
  assert.ok(serialized.includes('"max_session_duration":3600'))
})
