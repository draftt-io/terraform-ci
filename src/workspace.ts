import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type WorkspaceSourceStatus = 'matched' | 'head_mismatch' | 'dirty_terraform' | 'git_unavailable'

export async function inspectWorkspaceForSourceMapping(
  workspaceRoot: string,
  expectedSha: string,
): Promise<WorkspaceSourceStatus> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const actualSha = stdout.trim().toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(actualSha) || actualSha !== expectedSha.toLowerCase()) return 'head_mismatch'
    const status = await execFileAsync(
      'git',
      ['-C', workspaceRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { encoding: 'utf8' },
    )
    const dirty = status.stdout
      .split('\0')
      .filter(Boolean)
      .some((entry) => /\.(?:tf|tofu)(?:\.json)?$/.test(entry.slice(3)))
    return dirty ? 'dirty_terraform' : 'matched'
  } catch {
    return 'git_unavailable'
  }
}
