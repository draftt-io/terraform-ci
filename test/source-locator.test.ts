import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TerraformSourceLocator, type SourceMapping } from '../src/source-locator.ts'

async function withRepository(
  files: Readonly<Record<string, string>>,
  run: (repository: string) => Promise<void>,
): Promise<void> {
  const repository = await mkdtemp(path.join(tmpdir(), 'terraform-source-locator-'))
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(repository, relativePath)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
    }
    await run(repository)
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
}

function found(pathname: string, startLine: number): SourceMapping {
  return { kind: 'found', location: { path: pathname, startLine } }
}

test('maps root resources, count instances, and keyed for_each instances', async () => {
  await withRepository(
    {
      'main.tf': [
        'resource "aws_instance" "web" {}',
        '',
        'resource "aws_s3_bucket" "logs" {}',
      ].join('\n'),
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'aws_instance.web[0]' }), found('main.tf', 1))
      assert.deepEqual(await locator.locate({ address: 'aws_s3_bucket.logs["blue.prod"]' }), found('main.tf', 3))
    },
  )
})

test('follows nested local modules and ignores module instance keys', async () => {
  await withRepository(
    {
      'main.tf': 'module "environment" {\n  source = "./modules/environment"\n}\n',
      'modules/environment/main.tofu': 'module "database" {\n  source = "../database"\n}\n',
      'modules/database/database.tf': 'resource "aws_db_instance" "primary" {}\n',
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(
        await locator.locate({ address: 'module.environment["prod"].module.database[0].aws_db_instance.primary' }),
        found('modules/database/database.tf', 1),
      )
    },
  )
})

test('uses sourceAddress for derived components', async () => {
  await withRepository(
    { 'instances.tf': 'resource "aws_instance" "web" {}\n' },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(
        await locator.locate({ address: 'aws_ebs_volume.web_data', sourceAddress: 'aws_instance.web' }),
        found('instances.tf', 1),
      )
    },
  )
})

test('maps an external module finding to its editable module block', async () => {
  await withRepository(
    { 'main.tf': 'module "network" {\n  source = "hashicorp/vpc/aws"\n}\n' },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(
        await locator.locate({ address: 'module.network.aws_vpc.main' }),
        found('main.tf', 1),
      )
    },
  )
})

test('ignores fake HCL blocks in comments, strings, and heredocs', async () => {
  await withRepository(
    {
      'main.tf': [
        '# resource "aws_instance" "comment" {}',
        '// module "comment" {}',
        '/* resource "aws_instance" "block_comment" {} */',
        'locals {',
        '  text = "resource \\"aws_instance\\" \\"string\\" {}"',
        '  script = <<-EOT',
        '    resource "aws_instance" "heredoc" {}',
        '  EOT',
        '}',
        '',
        'resource "aws_instance" "real" {}',
      ].join('\n'),
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'aws_instance.real' }), found('main.tf', 11))
      assert.deepEqual(await locator.locate({ address: 'aws_instance.heredoc' }), { kind: 'unresolved', reason: 'missing_declaration' })
    },
  )
})

test('maps JSON Terraform and OpenTofu configuration files to resource property lines', async () => {
  await withRepository(
    {
      'terraform.tf.json': [
        '{',
        '  "resource": {',
        '    "aws_s3_bucket": {',
        '      "logs": {}',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'tofu.tofu.json': '{"resource":{"aws_instance":{"web":{}}}}\n',
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'aws_s3_bucket.logs' }), found('terraform.tf.json', 4))
      assert.deepEqual(await locator.locate({ address: 'aws_instance.web' }), found('tofu.tofu.json', 1))
    },
  )
})

test('follows static local modules declared in JSON', async () => {
  await withRepository(
    {
      'main.tf.json': '{"module":{"database":{"source":"./modules/database"}}}\n',
      'modules/database/main.tf.json': '{"resource":{"aws_db_instance":{"primary":{}}}}\n',
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(
        await locator.locate({ address: 'module.database.aws_db_instance.primary' }),
        found('modules/database/main.tf.json', 1),
      )
    },
  )
})

test('returns unresolved for invalid addresses, ambiguous declarations, and malformed JSON', async () => {
  await withRepository(
    {
      'a.tf': 'resource "aws_instance" "web" {}\n',
      'b.tofu': 'resource "aws_instance" "web" {}\n',
      'broken.tf.json': '{"resource":\n',
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'module' }), { kind: 'unresolved', reason: 'invalid_address' })
      assert.deepEqual(await locator.locate({ address: 'aws_instance.web' }), { kind: 'unresolved', reason: 'unreadable_configuration' })
    },
  )
})

test('returns unresolved for an ambiguous resource declaration without an unrelated parse error', async () => {
  await withRepository(
    {
      'a.tf': 'resource "aws_instance" "web" {}\n',
      'b.tofu': 'resource "aws_instance" "web" {}\n',
    },
    async (repository) => {
      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'aws_instance.web' }), { kind: 'unresolved', reason: 'ambiguous_declaration' })
    },
  )
})

test('does not map dynamic, missing, outside-repository, .terraform, or symlinked local modules', async () => {
  await withRepository(
    {
      'dynamic.tf': 'module "dynamic" {\n  source = var.module_source\n}\n',
      'missing.tf': 'module "missing" {\n  source = "./modules/missing"\n}\n',
      'outside.tf': 'module "outside" {\n  source = "../outside"\n}\n',
      'terraform-cache.tf': 'module "cache" {\n  source = "./.terraform/modules/cache"\n}\n',
      'symlink.tf': 'module "linked" {\n  source = "./modules/linked"\n}\n',
      'modules/linked/main.tf': 'resource "aws_instance" "web" {}\n',
      '.terraform/modules/cache/main.tf': 'resource "aws_instance" "web" {}\n',
    },
    async (repository) => {
      const linkPath = path.join(repository, 'modules', 'linked')
      const targetPath = path.join(repository, 'modules', 'actual')
      await mkdir(targetPath, { recursive: true })
      await writeFile(path.join(targetPath, 'main.tf'), 'resource "aws_instance" "web" {}\n')
      await rm(linkPath, { recursive: true })
      await symlink(targetPath, linkPath)

      const locator = await TerraformSourceLocator.create({ workspaceRoot: repository, terraformRoot: '.' })
      assert.deepEqual(await locator.locate({ address: 'module.dynamic.aws_instance.web' }), {
        kind: 'unresolved',
        reason: 'unsupported_module_source',
      })
      assert.deepEqual(await locator.locate({ address: 'module.missing.aws_instance.web' }), {
        kind: 'unresolved',
        reason: 'unsafe_module_source',
      })
      assert.deepEqual(await locator.locate({ address: 'module.outside.aws_instance.web' }), {
        kind: 'unresolved',
        reason: 'unsafe_module_source',
      })
      assert.deepEqual(await locator.locate({ address: 'module.cache.aws_instance.web' }), {
        kind: 'unresolved',
        reason: 'unsafe_module_source',
      })
      assert.deepEqual(await locator.locate({ address: 'module.linked.aws_instance.web' }), {
        kind: 'unresolved',
        reason: 'unsafe_module_source',
      })
    },
  )
})
