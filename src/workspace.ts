import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function workspaceMatchesCommit(workspaceRoot: string, expectedSha: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const actualSha = stdout.trim().toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(actualSha) || actualSha !== expectedSha.toLowerCase()) return false
    const status = await execFileAsync(
      'git',
      ['-C', workspaceRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { encoding: 'utf8' },
    )
    return !status.stdout
      .split('\0')
      .filter(Boolean)
      .some((entry) => /\.(?:tf|tofu)(?:\.json)?$/.test(entry.slice(3)))
  } catch {
    return false
  }
}
