export type Comment = { author: { login: string } | null; body: string; updatedAt: string; url: string };
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
export type Thread = {
  id: string; isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null;
  comments: { totalCount: number; nodes: Comment[]; pageInfo?: PageInfo };
};
export type GraphQL = (query: string, variables: Record<string, string | number>, signal?: AbortSignal) => Promise<any>;
const COMMENT_FIELDS = 'author{login} body updatedAt url';
const THREAD_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
 repository(owner:$owner,name:$name){pullRequest(number:$pr){url title state
 reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line
 comments(first:1){totalCount nodes{${COMMENT_FIELDS}}}}
 pageInfo{hasNextPage endCursor}}}}}`;
const COMMENT_QUERY = `query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{
 comments(first:100,after:$cursor){totalCount nodes{${COMMENT_FIELDS}} pageInfo{hasNextPage endCursor}}}}}`;
function nextCursor(info: PageInfo, seen: Set<string>): string | undefined {
  if (!info.hasNextPage) return;
  if (!info.endCursor || seen.has(info.endCursor)) throw new Error('GitHub returned an invalid/repeated pagination cursor');
  seen.add(info.endCursor);
  return info.endCursor;
}
function checked(data: any): any {
  if (data.errors?.length) throw new Error(`GitHub GraphQL: ${data.errors.map((e: any) => e.message).join('; ')}`);
  return data.data;
}
export async function fetchReviewThreads(graphql: GraphQL, owner: string, name: string, pr: number, signal?: AbortSignal) {
  const threads: Thread[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined, pull: any;
  do {
    signal?.throwIfAborted();
    const data = checked(await graphql(THREAD_QUERY, { owner, name, pr, ...(cursor ? { cursor } : {}) }, signal));
    pull = data?.repository?.pullRequest;
    if (!pull) throw new Error(`PR #${pr} not found or inaccessible`);
    threads.push(...pull.reviewThreads.nodes);
    cursor = nextCursor(pull.reviewThreads.pageInfo, seen);
  } while (cursor);
  return { url: pull.url as string, state: pull.state as string, threads };
}
export async function fetchThreadComments(graphql: GraphQL, id: string, signal?: AbortSignal): Promise<Comment[]> {
  const comments: Comment[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const connection = checked(await graphql(COMMENT_QUERY, { id, ...(cursor ? { cursor } : {}) }, signal))?.node?.comments;
    if (!connection) throw new Error('Review thread not found or inaccessible');
    comments.push(...connection.nodes);
    cursor = nextCursor(connection.pageInfo, seen);
  } while (cursor);
  return comments;
}
export function formatThreads(pull: { url: string; state: string; threads: Thread[] }, includeResolved = false): string {
  const open = pull.threads.filter(t => !t.isResolved);
  const shown = includeResolved ? pull.threads : open;
  const lines = [`${pull.url} — ${pull.state.toLowerCase()}, ${pull.threads.length} threads (${open.length} unresolved) — fetched at ${new Date().toISOString()}`,
    'Summaries show the first comment only. Use thread_id to read the entire discussion before acting.'];
  for (const t of shown) {
    const c = t.comments.nodes[0];
    const body = (c?.body ?? '').replace(/\s+/g, ' ');
    lines.push(`- ${t.id} ${t.path ?? '?'}:${t.line ?? '?'} [${t.isResolved ? 'resolved' : 'unresolved'}${t.isOutdated ? ', outdated' : ''}] (${t.comments.totalCount} comments) @${c?.author?.login ?? 'ghost'}: ${body.slice(0, 300)}${body.length > 300 ? ' … [truncated]' : ''}${c?.url ? `\n  ${c.url}` : ''}`);
  }
  if (!shown.length) lines.push(includeResolved ? '(no review threads)' : '(no unresolved review threads)');
  return lines.join('\n');
}
