import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { inspectWorkspaceForSourceMapping } from '../src/workspace.ts'

const execFileAsync = promisify(execFile)

test('matches source mapping only to the checked-out Git commit', async () => {
  const repository = new URL('..', import.meta.url).pathname
  const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  assert.equal(await inspectWorkspaceForSourceMapping(repository, stdout.trim()), 'matched')
  assert.equal(await inspectWorkspaceForSourceMapping(repository, '0000000000000000000000000000000000000000'), 'head_mismatch')
})

test('rejects source mapping when Terraform source differs from the commit', async () => {
  const repository = await mkdtemp(path.join(tmpdir(), 'terraform-workspace-'))
  try {
    await execFileAsync('git', ['-C', repository, 'init'])
    await writeFile(path.join(repository, 'main.tf'), 'resource "aws_s3_bucket" "main" {}\n')
    await execFileAsync('git', ['-C', repository, 'add', 'main.tf'])
    await execFileAsync('git', [
      '-C', repository,
      '-c', 'user.name=Draftt Test',
      '-c', 'user.email=test@draftt.io',
      'commit', '-m', 'fixture',
    ])
    const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const sha = stdout.trim()
    assert.equal(await inspectWorkspaceForSourceMapping(repository, sha), 'matched')
    await writeFile(path.join(repository, 'main.tf'), 'resource "aws_s3_bucket" "main" {\n}\n')
    assert.equal(await inspectWorkspaceForSourceMapping(repository, sha), 'dirty_terraform')
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test('reports unavailable Git repository state', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'terraform-missing-workspace-'))
  try {
    assert.equal(
      await inspectWorkspaceForSourceMapping(
        path.join(parent, 'missing'),
        '0000000000000000000000000000000000000000',
      ),
      'git_unavailable',
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
