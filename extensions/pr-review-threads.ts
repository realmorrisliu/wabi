import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchReviewThreads, fetchThreadComments, formatThreads, type GraphQL } from '../lib/pr-review-threads.ts';
const run = promisify(execFile);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'pr_review_threads', label: 'PR Review Threads',
    description: 'Read GitHub PR review threads with resolved/outdated state. All thread pages are fetched. Summaries contain only the first comment; pass thread_id to read every comment in full.',
    promptSnippet: 'Read PR review feedback and resolution status',
    promptGuidelines: ['Use pr_review_threads for review feedback; gh pr view --comments omits review threads. Read a relevant thread with thread_id before acting on its summary.'],
    parameters: Type.Object({
      pr: Type.Optional(Type.Integer({ minimum: 1, description: "PR number; defaults to the current branch's PR" })),
      include_resolved: Type.Optional(Type.Boolean({ description: 'Include resolved threads in the summary' })),
      thread_id: Type.Optional(Type.String({ minLength: 1, description: 'Thread ID from the summary; returns all comments, including replies, without body truncation' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const ghJson = async (args: string[]) => {
        const { stdout } = await run('gh', args, { cwd: ctx.cwd, signal, maxBuffer: 32 * 1024 * 1024 });
        return JSON.parse(stdout);
      };
      const graphql: GraphQL = (query, variables) => ghJson(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])]);
      const pr = params.pr ?? (await ghJson(['pr', 'view', '--json', 'number'])).number;
      const repo = await ghJson(['repo', 'view', '--json', 'owner,name']);
      const pull = await fetchReviewThreads(graphql, repo.owner.login, repo.name, pr, signal);
      let text = formatThreads(pull, params.include_resolved);
      if (params.thread_id) {
        const thread = pull.threads.find(t => t.id === params.thread_id);
        if (!thread) throw new Error(`Thread ${params.thread_id} is not in PR #${pr}`);
        const comments = await fetchThreadComments(graphql, thread.id, signal);
        text = `${pull.url}\n${thread.id} ${thread.path}:${thread.line ?? '?'} [${thread.isResolved ? 'resolved' : 'unresolved'}${thread.isOutdated ? ', outdated' : ''}] — ${comments.length} comments\n\n` + comments.map(c => `@${c.author?.login ?? 'ghost'} · ${c.updatedAt}\n${c.url}\n${c.body}`).join('\n\n---\n\n');
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}
