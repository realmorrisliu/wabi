import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchReviewThreads, fetchThreadComments, formatThreads, type Thread } from '../lib/pr-review-threads.ts';
const comment = { author: null, body: 'x'.repeat(500), updatedAt: '2026-09-07', url: 'https://example.test/comment' };
const thread = (id: string, isResolved = true): Thread => ({ id, isResolved, isOutdated: false, path: 'a.ts', line: 1, comments: { nodes: [comment], totalCount: 101 } });
test('includes unresolved feedback after the first 100 threads', async () => {
  const seen: unknown[] = [];
  const pull = await fetchReviewThreads(async (_, variables) => {
    seen.push(variables.cursor);
    return { data: { repository: { pullRequest: { url: 'pr', state: 'OPEN', reviewThreads: {
      nodes: variables.cursor ? [thread('last', false)] : Array.from({ length: 100 }, (_, i) => thread(String(i))),
      pageInfo: { hasNextPage: !variables.cursor, endCursor: variables.cursor ? null : 'next' },
    } } } } };
  }, 'owner', 'repo', 1);
  assert.deepEqual(seen, [undefined, 'next']);
  assert.equal(pull.threads.length, 101);
  const summary = formatThreads(pull);
  assert.match(summary, /101 threads \(1 unresolved\)/);
  assert.match(summary, /last a.ts/);
  assert.match(summary, /\[truncated\]/);
  assert.match(summary, /thread_id/);
});
test('reads replies across pages without truncating comment bodies', async () => {
  const comments = await fetchThreadComments(async (_, vars) => ({ data: { node: { comments: {
    nodes: vars.cursor ? [{ ...comment, body: 'final reply' }] : Array.from({ length: 100 }, () => comment),
    pageInfo: { hasNextPage: !vars.cursor, endCursor: vars.cursor ? null : 'next' },
  } } } }), 'thread');
  assert.equal(comments.length, 101);
  assert.equal(comments[0].body.length, 500);
  assert.equal(comments.at(-1)?.body, 'final reply');
});
test('fails on partial GraphQL errors and repeated pagination cursors', async () => {
  await assert.rejects(fetchReviewThreads(async () => ({ errors: [{ message: 'rate limited' }] }), 'o', 'r', 1), /rate limited/);
  await assert.rejects(fetchThreadComments(async () => ({ data: { node: { comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same' } } } } }), 't'), /repeated/);
});
