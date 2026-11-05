// GitHub client with rate-limit handling (throttling + retry plugins) and a small
// per-run cache, so several KRs that read the same pull requests cost one set of calls.

import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';

const PulseOctokit = Octokit.plugin(throttling, retry);
export type GH = InstanceType<typeof PulseOctokit>;

export function createClient(token: string | undefined, log: (m: string) => void = console.warn): GH {
  return new PulseOctokit({
    auth: token,
    userAgent: 'okr-pulse',
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        log(`Rate limit hit for ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < 2;
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        log(`Secondary rate limit for ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < 2;
      },
    },
  });
}

export interface PullSummary {
  number: number;
  title: string;
  url: string;
  base: string;
  createdAt: string;
  mergedAt: string | null;
  labels: string[];
  author: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Memoises async lookups for the lifetime of one collector run. */
export class RunCache {
  private map = new Map<string, Promise<unknown>>();
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.map.has(key)) this.map.set(key, load());
    return this.map.get(key) as Promise<T>;
  }
}

export function listPulls(gh: GH, ref: RepoRef, cache: RunCache): Promise<PullSummary[]> {
  return cache.get('pulls', async () => {
    const items = await gh.paginate(gh.rest.pulls.list, { ...ref, state: 'all', per_page: 100 });
    return items.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.html_url,
      base: p.base.ref,
      createdAt: p.created_at,
      mergedAt: p.merged_at,
      labels: p.labels.map((l) => l.name ?? '').filter(Boolean),
      author: p.user?.login ?? '',
    }));
  });
}

export function listReviews(gh: GH, ref: RepoRef, cache: RunCache, pull: number) {
  return cache.get(`reviews:${pull}`, () =>
    gh.paginate(gh.rest.pulls.listReviews, { ...ref, pull_number: pull, per_page: 100 }).then((rs) =>
      rs.map((r) => ({ state: r.state, login: r.user?.login ?? '' })),
    ),
  );
}

export function listPullFiles(gh: GH, ref: RepoRef, cache: RunCache, pull: number): Promise<string[]> {
  return cache.get(`files:${pull}`, () =>
    gh.paginate(gh.rest.pulls.listFiles, { ...ref, pull_number: pull, per_page: 100 }).then((fs) => fs.map((f) => f.filename)),
  );
}

export function listPullCommitMessages(gh: GH, ref: RepoRef, cache: RunCache, pull: number): Promise<string[]> {
  return cache.get(`commits:${pull}`, () =>
    gh.paginate(gh.rest.pulls.listCommits, { ...ref, pull_number: pull, per_page: 100 }).then((cs) => cs.map((c) => c.commit.message)),
  );
}

/** Minimal glob: `**` any path, `*` any segment chars, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const AI_TRAILER = /^co-authored-by:.*\b(claude|anthropic|copilot|openai|chatgpt|gpt|gemini|cursor|codex)\b/im;
export const hasAiTrailer = (message: string) => AI_TRAILER.test(message);
