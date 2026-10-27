import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverRepos } from "@hcflabs/pi-repo";
import { Type } from "typebox";

const OUTPUT_REPOS = 200;

const Parameters = Type.Object({
	path: Type.Optional(Type.String({ minLength: 1, description: "Directory to search, relative to the Pi working directory. The default is the Pi working directory." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Directory levels to search below path. The default is 3." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OUTPUT_REPOS, description: `Maximum repositories to return. The default is ${OUTPUT_REPOS}.` })),
}, { additionalProperties: false });

/** Register the read-only `subagent_repos` tool. It lists child repositories and the `repo` selector for each. */
export function registerRepoDiscovery(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_repos",
		label: "Subagent Repos",
		description: "List the child Git repositories below the Pi working directory, with the repo selector that delegate_task accepts. The tool changes no files and no Git state. It does not follow symlinks. It lists repositories inside repositories, such as submodules, and marks linked worktrees and submodules.",
		promptSnippet: "List child Git repositories and their repo selectors for delegate_task",
		promptGuidelines: [
			"When the Pi working directory holds several repositories, use subagent_repos to find the repo selector, then set repo on delegate_task. Never guess a selector, and never select a repository the user did not name or authorize.",
		],
		parameters: Parameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const found = await discoverRepos(ctx.cwd, {
				...(params.path === undefined ? {} : { path: params.path }),
				...(params.maxDepth === undefined ? {} : { maxDepth: params.maxDepth }),
				limit: params.limit ?? OUTPUT_REPOS,
				...(signal ? { signal } : {}),
			});
			const lines = [
				`${found.repos.length} repositories below ${found.base}${found.truncated ? " (truncated: a depth, directory, repository, or time limit stopped the search, so some directories were not examined)" : ""}.`,
				...found.repos.map(({ repo, linkedWorktree, submodule }) => `${repo}${linkedWorktree ? " (linked worktree)" : submodule ? " (submodule)" : ""}`),
				...(found.issues.length ? ["Issues:", ...found.issues.slice(0, 20).map(({ path, reason }) => `${path}: ${reason}`)] : []),
				...(found.issues.length > 20 ? [`${found.issues.length - 20} more issues omitted.`] : []),
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: found };
		},
	});
}
