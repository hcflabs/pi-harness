import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnBounded } from "@hcflabs/pi-process";
import { gitTopLevel, resolveRepoTarget } from "@hcflabs/pi-repo";
import { ROLE_TOOL_POLICY_FLAG, roleToolPolicyFromArgv } from "@hcflabs/pi-subagent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const OUTPUT_BYTES = 32 * 1024;
const TIMEOUT_MS = 30_000;
const Parameters = Type.Object({
	operation: StringEnum(["status", "diff", "show", "log", "blame", "rev-parse"]),
	mode: Type.Optional(StringEnum(["working", "staged", "committed"], { description: "Diff only; defaults to working (unstaged). Committed requires base and tip." })),
	repo: Type.Optional(Type.String({ minLength: 1, description: "Child Git repository as a path relative to the assigned cwd, such as team/service. Required when cwd is not a Git repository. Same rules as the delegate_task repo. Omit it to use cwd." })),
	base: Type.Optional(Type.String()),
	tip: Type.Optional(Type.String()),
	revision: Type.Optional(Type.String({ description: "Commit ID or named ref with optional ~N/^N ancestry; defaults to HEAD. No ranges or reflog expressions." })),
	path: Type.Optional(Type.String({ description: "One literal path relative to the selected repo, or to the assigned cwd if repo is omitted; no absolute paths, traversal, or .git paths." })),
	maxCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Log only; defaults to 20." })),
	startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000, description: "Blame only; supply both line bounds." })),
	endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
}, { additionalProperties: false });
type Params = Static<typeof Parameters>;
const Result = Type.Object({ output: Type.String(), stderr: Type.String(), truncated: Type.Boolean() });

function parse(input: unknown): Params {
	if (!Check(Parameters, input)) throw new Error("git_read requires a supported operation and valid structured parameters; arbitrary Git options are not accepted.");
	const allowed: Record<Params["operation"], string[]> = {
		status: ["repo", "path"], diff: ["repo", "mode", "base", "tip", "path"], show: ["repo", "revision", "path"],
		log: ["repo", "revision", "path", "maxCount"], blame: ["repo", "revision", "path", "startLine", "endLine"], "rev-parse": ["repo", "revision"],
	};
	for (const key of Object.keys(input)) {
		if (key !== "operation" && !allowed[input.operation].includes(key)) throw new Error(`git_read ${input.operation} does not accept ${key}.`);
	}
	for (const revision of [input.revision, input.base, input.tip]) {
		if (revision === undefined) continue;
		if (revision.length > 256 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^][0-9]*)*$/.test(revision)
			|| revision.includes("..") || revision.includes("//")) {
			throw new Error("git_read revision must be a commit ID or named ref with optional ~N/^N ancestry, not options, ranges, paths, or reflog expressions.");
		}
	}
	if (input.path !== undefined && (!input.path || input.path.length > 4096 || /^[-/]/.test(input.path)
		|| /[\\:\u0000-\u001f\u007f-\u009f]/.test(input.path)
		|| input.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git"))) {
		throw new Error("git_read path must be a literal relative path without options, traversal, control characters, or .git components.");
	}
	if (input.operation === "diff") {
		if (input.mode === "committed" ? !input.base || !input.tip : input.base !== undefined || input.tip !== undefined) {
			throw new Error("git_read committed diff requires base and tip; working/staged diff accepts neither.");
		}
	}
	if (input.operation === "blame" && (!input.path || (input.startLine === undefined) !== (input.endLine === undefined)
		|| (input.startLine !== undefined && input.endLine! < input.startLine))) {
		throw new Error("git_read blame requires path and, if supplied, ordered startLine and endLine.");
	}
	return input;
}

// No pager, optional index refresh, lazy network fetch, replacements, hooks, fsmonitor,
// signature programs, submodule recursion, external diffs, or textconv programs.
const GIT = ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs",
	"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
	"-c", "submodule.recurse=false", "-c", "log.showSignature=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--no-renames"];

async function inspect(params: Params, cwd: string, signal?: AbortSignal): Promise<Static<typeof Result>> {
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let filterOverrides: string[] = [];
	const git = async (args: string[], tail = false) => {
		const result = await spawnBounded("git", [...GIT, ...filterOverrides, ...args], {
			cwd, signal: boundedSignal, timeoutMs: TIMEOUT_MS, stdoutLimitBytes: OUTPUT_BYTES,
			...(tail ? { stdoutTailBytes: OUTPUT_BYTES } : {}), stderrLimitBytes: 8192,
		});
		if (result.killed || result.code !== 0) throw new Error(`git_read ${params.operation}: git ${args[0]} exited ${result.code}: ${result.stderr.trim() || "no diagnostic"}`);
		return result;
	};
	const resolve = async (revision = "HEAD") => (await git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).stdout.trim();
	let args: string[];
	const paths = params.path === undefined ? [] : [params.path];
	switch (params.operation) {
		case "status": args = ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all", "--", ...paths]; break;
		case "diff": args = ["diff", ...DIFF, ...(params.mode === "committed"
			? [await resolve(params.base), await resolve(params.tip)] : params.mode === "staged" ? ["--cached"] : []), "--", ...paths]; break;
		case "show": {
			const revision = await resolve(params.revision);
			args = params.path === undefined
				? ["show", ...DIFF, "--format=fuller", "--no-show-signature", revision, "--"]
				: ["show", "--no-ext-diff", "--no-textconv", `${revision}:./${params.path}`];
			break;
		}
		case "log": args = ["log", "--no-color", "--no-decorate", "--no-show-signature", "--format=fuller", `--max-count=${params.maxCount ?? 20}`, await resolve(params.revision), "--", ...paths]; break;
		case "blame": args = ["blame", "--no-textconv", "--line-porcelain", ...(params.startLine === undefined ? [] : ["-L", `${params.startLine},${params.endLine}`]), await resolve(params.revision), "--", params.path!]; break;
		case "rev-parse": return { output: `${await resolve(params.revision)}\n`, stderr: "", truncated: false };
		default: throw new Error(`Unsupported git_read operation: ${params.operation}`);
	}
	// Working-tree comparison can invoke clean/process filters even with --no-textconv.
	// Override configured filters by name rather than trusting repository attributes.
	if (params.operation === "status" || params.operation === "diff" && params.mode !== "committed") {
		const filters = await spawnBounded("git", [...GIT, "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], {
			cwd, signal: boundedSignal, timeoutMs: TIMEOUT_MS, stdoutLimitBytes: OUTPUT_BYTES, stderrLimitBytes: 8192,
		});
		if (filters.killed || filters.code !== 0 && filters.code !== 1) throw new Error(`git_read cannot inspect clean filters: ${filters.stderr.trim()}`);
		const keys = filters.stdout.split("\0").filter(Boolean);
		if (keys.some((key) => key.includes("="))) throw new Error("git_read cannot safely disable filter names containing '='.");
		filterOverrides = keys.flatMap((key) => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]);
	}
	const result = await git(args, true);
	return { output: result.stdout, stderr: result.stderr, truncated: result.stdoutTruncated === true };
}

/** Run the operation in the selected repository root. Without repo, run in cwd and name repo if cwd is not a repository. */
async function inspectIn(params: Params, cwd: string, signal?: AbortSignal): Promise<Static<typeof Result>> {
	if (params.repo !== undefined) {
		let root: string;
		try {
			root = (await resolveRepoTarget(cwd, params.repo, signal ? { signal } : {})).root;
		} catch (error) {
			throw new Error(`git_read ${params.operation} repo ${params.repo}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		return await inspect(params, root, signal);
	}
	try {
		return await inspect(params, cwd, signal);
	} catch (error) {
		// Git exit 128 is not specific to a missing repository. Ask pi-repo, which does not read Git messages.
		const outside = signal?.aborted ? false : await gitTopLevel(cwd, signal ? { signal } : {}).then((root) => root === undefined, () => false);
		if (outside) {
			throw new Error(`git_read ${params.operation}: ${cwd} is not a Git repository. Set the repo parameter to a child Git repository, as a path relative to cwd, such as team/service.`, { cause: error });
		}
		throw error;
	}
}

export default function gitRead(pi: ExtensionAPI): void {
	// Like the MCP adapter, inspect argv because Pi binds extension flags after factories load.
	if (!process.argv.includes(`--${ROLE_TOOL_POLICY_FLAG}`) || !roleToolPolicyFromArgv(process.argv).includes("git_read")) return;
	pi.registerTool({
		name: "git_read", label: "Git read",
		description: "Read bounded local Git evidence: status, working or staged diff, base-to-tip diff, show of a commit or file, log, blame, and rev-parse of a commit. The operations are fixed and read-only. The tool accepts no shell, no options, no network, no tests, and no changes. If cwd is not a Git repository, set repo to a child Git repository, as a path relative to cwd. Paths are relative to the selected repo, or to cwd if repo is omitted. The tool keeps at most the last 32 KiB of output. If the output is truncated, narrow the path, ref, or line scope. Each call has a 30-second timeout.",
		parameters: Parameters,
		outputSchema: Result,
		async execute(_id, input, signal, _update, ctx) {
			const result = await inspectIn(parse(input), ctx.cwd, signal);
			return {
				content: [{ type: "text", text: `${result.truncated ? "[TRUNCATED: only the last 32768 bytes follow; narrow the request.]\n" : ""}${result.output}${result.stderr ? `\nGit diagnostic: ${result.stderr}` : ""}` }],
				structuredContent: result, details: result,
			};
		},
	});
}
