import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

function findRepoRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

const REPO_ROOT = findRepoRoot();
const CONTENT_ROOT = 'docs/src/content/docs';

function normalizePath(path: string): string {
  if (isAbsolute(path)) return relative(REPO_ROOT, path).replace(/\\/g, '/');

  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.startsWith('docs/') ? normalized : `docs/${normalized}`;
}

export function getContentCommitDates(): Map<string, Date> {
  const result = spawnSync(
    'git',
    ['log', '--format=t:%ct', '--name-status', '--', CONTENT_ROOT],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error || result.status !== 0) return new Map();

  let currentTimestamp = 0;
  const dates = new Map<string, Date>();

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('t:')) {
      currentTimestamp = Number.parseInt(line.slice(2), 10) * 1000;
      continue;
    }

    const lastTab = line.lastIndexOf('\t');
    if (lastTab === -1 || currentTimestamp === 0) continue;

    const filePath = line.slice(lastTab + 1);
    if (!dates.has(filePath)) dates.set(filePath, new Date(currentTimestamp));
  }

  return dates;
}

export function getContentCommitDate(dates: Map<string, Date>, filePath: string): Date | undefined {
  return dates.get(normalizePath(filePath));
}
