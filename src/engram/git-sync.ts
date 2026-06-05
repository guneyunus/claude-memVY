import { execFileSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

/** Run a git command, scoped to `root`, never throwing. */
function git(root: string, args: string[], timeout = 15000): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout,
    });
    return { ok: true, stdout: String(stdout).trim() };
  } catch (e: any) {
    const stderr = e?.stderr ? String(e.stderr) : '';
    const stdout = e?.stdout ? String(e.stdout) : '';
    return { ok: false, stdout: stdout.trim(), error: (stderr || e?.message || String(e)).trim() };
  }
}

export function isGitRepo(root: string): boolean {
  const r = git(root, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

export function hasRemote(root: string): boolean {
  const r = git(root, ['remote']);
  return r.ok && r.stdout.length > 0;
}

/** Pull (rebase + autostash). No remote → no-op success. Conflict → abort + non-fatal. */
export function gitPull(root: string): GitResult {
  if (!isGitRepo(root) || !hasRemote(root)) return { ok: true, stdout: 'no remote' };
  const r = git(root, ['pull', '--rebase', '--autostash'], 30000);
  if (!r.ok) git(root, ['rebase', '--abort']); // best-effort cleanup; ignore result
  return r;
}

export interface CommitResult extends GitResult { committed: boolean; }

/** Stage `paths`, commit if anything is staged. Clean tree → ok with committed:false. */
export function gitCommitPaths(root: string, paths: string[], message: string): CommitResult {
  if (!isGitRepo(root)) return { ok: false, stdout: '', error: 'not a git repo', committed: false };
  const add = git(root, ['add', ...paths]);
  if (!add.ok) return { ...add, committed: false };
  // `git diff --cached --quiet` exits 0 when nothing is staged.
  if (git(root, ['diff', '--cached', '--quiet']).ok) {
    return { ok: true, stdout: 'nothing to commit', committed: false };
  }
  const commit = git(root, ['commit', '-m', message]);
  return { ...commit, committed: commit.ok };
}

/** Push the current branch to origin. No remote → no-op success. */
export function gitPush(root: string): GitResult {
  if (!isGitRepo(root) || !hasRemote(root)) return { ok: true, stdout: 'no remote' };
  return git(root, ['push', 'origin', 'HEAD'], 30000);
}
