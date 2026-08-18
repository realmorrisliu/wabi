// pr-review-threads — reliable PR review-comment state for the agent.
//
// Why this exists: `gh pr view --comments` only returns issue-style comments and
// says nothing about review threads or their resolution. Agents hand-rolling that
// query routinely miss feedback or read stale state. The source of truth is the
// GraphQL `reviewThreads` connection (isResolved / isOutdated / path / line).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const run = promisify(execFile);

const QUERY = `query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      url title state
      reviewThreads(first:100){
        nodes{
          isResolved isOutdated path line
          comments(first:1){ nodes{ author{login} body updatedAt } }
        }
      }
    }
  }
}`;

async function ghJson(args: string[], cwd: string, signal?: AbortSignal) {
	const { stdout } = await run("gh", args, { cwd, signal, maxBuffer: 16 * 1024 * 1024 });
	return JSON.parse(stdout);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pr_review_threads",
		label: "PR Review Threads",
		description:
			"Fetch a GitHub PR's review threads with resolved/outdated state via live GraphQL. Use this instead of hand-written gh scripts when checking PR review feedback or whether it is resolved.",
		promptSnippet: "Read GitHub PR review threads with resolved/outdated status",
		promptGuidelines: [
			"Use pr_review_threads instead of `gh pr view --comments` when checking PR review feedback: it reports each thread's path:line, author, isResolved and isOutdated from a live GraphQL query.",
		],
		parameters: Type.Object({
			pr: Type.Optional(Type.Number({ description: "PR number; defaults to the current branch's PR" })),
			include_resolved: Type.Optional(Type.Boolean({ description: "Also list resolved threads (default false)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const pr =
				params.pr ??
				(await ghJson(["pr", "view", "--json", "number"], ctx.cwd, signal)
					.then((d) => d.number as number)
					.catch(() => {
						throw new Error("no PR for the current branch; pass the pr parameter explicitly");
					}));
			const repo = await ghJson(["repo", "view", "--json", "owner,name"], ctx.cwd, signal);
			const data = await ghJson(
				[
					"api",
					"graphql",
					"-f",
					`query=${QUERY}`,
					"-F",
					`owner=${repo.owner.login}`,
					"-F",
					`name=${repo.name}`,
					"-F",
					`pr=${pr}`,
				],
				ctx.cwd,
				signal,
			);
			const pull = data.data.repository.pullRequest;
			const threads = pull.reviewThreads.nodes as Array<{
				isResolved: boolean;
				isOutdated: boolean;
				path: string | null;
				line: number | null;
				comments: { nodes: Array<{ author: { login: string } | null; body: string; updatedAt: string }> };
			}>;
			const open = threads.filter((t) => !t.isResolved);
			const shown = params.include_resolved ? threads : open;

			const lines: string[] = [
				`${pull.url} — ${pull.state.toLowerCase()}, ${threads.length} threads (${open.length} unresolved) — live at ${new Date().toISOString()}`,
			];
			for (const t of shown) {
				const c = t.comments.nodes[0];
				const body = (c?.body ?? "").replace(/\s+/g, " ").slice(0, 300);
				const flags = [t.isOutdated ? "outdated" : "", t.isResolved ? "resolved" : ""].filter(Boolean).join(",");
				lines.push(
					`- ${t.path ?? "?"}:${t.line ?? "?"} @${c?.author?.login ?? "ghost"}${flags ? ` [${flags}]` : ""}: ${body}`,
				);
			}
			if (shown.length === 0) lines.push("(no unresolved review threads)");
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});
}
