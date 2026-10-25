import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface AddedDir {
	absolutePath: string;
	label: string;
}

export interface DirContext {
	agentsMd: string | null;
	claudeMd: string | null;
	skills: string[];
}

const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const SKILL_DIRS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;
const SKIPPED_SEARCH_DIRS = new Set([".git", "node_modules"]);
export const CONTEXT_FILE_BYTE_CAP = 65_536;

type ContextFileReader = (filePath: string) => string | null;
type ContextFileStat = (filePath: string) => { size: number; mtimeMs: number; ctimeMs: number };

export function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function expandUserPath(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) return path.join(homedir(), input.slice(2));
	return input;
}

export function resolveDir(input: string, cwd: string): string {
	const expanded = expandUserPath(input);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isMissingPathError(error)) return path.resolve(resolved);
		throw error;
	}
}

export function dirExists(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

export function readFileSafe(filePath: string): string | null {
	try {
		const fd = openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(CONTEXT_FILE_BYTE_CAP);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
				if (count === 0) break;
				bytesRead += count;
			}
			const bytes = buffer.subarray(0, bytesRead);
			if (fstatSync(fd).size <= bytesRead) return bytes.toString("utf8");
			// The decoder excludes an incomplete UTF-8 character at the cap.
			const text = new StringDecoder("utf8").write(bytes);
			return `${text}\n\n[pi-add-dir truncated ${filePath} at the 64 KiB (65536 bytes) cap.]`;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

function contextFilePaths(dir: string, name: (typeof CONTEXT_FILES)[number]): string[] {
	return [path.join(dir, name), path.join(dir, ".pi", name)];
}

function readContextFile(
	dir: string,
	name: (typeof CONTEXT_FILES)[number],
	readFile: ContextFileReader = readFileSafe,
): string | null {
	const contents = contextFilePaths(dir, name).map(readFile).filter((content): content is string => content !== null);
	return contents.length > 0 ? contents.join("\n\n") : null;
}

function skillFiles(dir: string): Array<{ name: string; path: string }> {
	const files: Array<{ name: string; path: string }> = [];
	const names = new Set<string>();

	for (const skillDir of SKILL_DIRS) {
		const fullSkillDir = path.join(dir, skillDir);
		try {
			for (const entry of readdirSync(fullSkillDir, { withFileTypes: true })) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const skillPath = path.join(fullSkillDir, entry.name, "SKILL.md");
				try {
					if (statSync(skillPath).isFile() && !names.has(entry.name)) {
						names.add(entry.name);
						files.push({ name: entry.name, path: skillPath });
					}
				} catch {
					// Skill may disappear while resources are being discovered.
				}
			}
		} catch {
			// Skip unreadable skill directories.
		}
	}

	return files;
}

export function scanDirContext(dir: string): DirContext {
	return {
		agentsMd: readContextFile(dir, "AGENTS.md"),
		claudeMd: readContextFile(dir, "CLAUDE.md"),
		skills: skillFiles(dir).map(({ name }) => name),
	};
}

export function collectSkillPaths(dirs: AddedDir[]): string[] {
	const paths: string[] = [];
	const names = new Set<string>();
	for (const dir of dirs) {
		for (const skill of skillFiles(dir.absolutePath)) {
			if (names.has(skill.name)) continue;
			names.add(skill.name);
			paths.push(skill.path);
		}
	}
	return paths;
}

export function buildContextInjection(dirs: AddedDir[], readFile: ContextFileReader = readFileSafe): string {
	const sections = [
		"\n\n## External Directories (added via pi-add-dir)",
		`\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} included in this session. You can read, edit, and write files in these directories using absolute paths.\n`,
	];

	for (const dir of dirs) {
		sections.push(`### ${dir.label} - \`${dir.absolutePath}\``);

		const agentsMd = readContextFile(dir.absolutePath, "AGENTS.md", readFile);
		if (agentsMd) sections.push(`\n#### AGENTS.md (from ${dir.label})\n${agentsMd}`);
		const claudeMd = readContextFile(dir.absolutePath, "CLAUDE.md", readFile);
		if (claudeMd) sections.push(`\n#### CLAUDE.md (from ${dir.label})\n${claudeMd}`);
	}

	return sections.join("\n");
}

export function createContextInjectionCache(
	options: { readFile?: ContextFileReader; statFile?: ContextFileStat } = {},
): (dirs: AddedDir[]) => string {
	const readFile = options.readFile ?? readFileSafe;
	const statFile = options.statFile ?? statSync;
	let cached: { key: string; injection: string } | undefined;

	function fingerprint(dirs: AddedDir[]): string | undefined {
		try {
			const inputs = dirs.map(({ absolutePath, label }) => ({
				absolutePath,
				label,
				files: CONTEXT_FILES.flatMap((name) => contextFilePaths(absolutePath, name)).map((filePath) => {
					try {
						const { size, mtimeMs, ctimeMs } = statFile(filePath);
						return `${size}:${mtimeMs}:${ctimeMs}`;
					} catch (error) {
						if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
						throw error;
					}
				}),
			}));
			// Skills do not affect the injection. Pi discovers them separately.
			return JSON.stringify(inputs);
		} catch {
			// Other stat errors bypass the cache.
			return undefined;
		}
	}

	return (dirs) => {
		const key = fingerprint(dirs);
		if (key !== undefined && cached?.key === key) return cached.injection;
		let readFailed = false;
		const injection = buildContextInjection(dirs, (filePath) => {
			const content = readFile(filePath);
			if (content === null) {
				try {
					statFile(filePath);
					readFailed = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") readFailed = true;
				}
			}
			return content;
		});
		// Do not cache failed reads or files that changed during the build.
		cached = key !== undefined && !readFailed && fingerprint(dirs) === key ? { key, injection } : undefined;
		return injection;
	};
}

function normalizePattern(pattern: string): string {
	let normalized = pattern.trim();
	if (path.sep === "\\") normalized = normalized.replaceAll("/", "\\");
	const prefix = `.${path.sep}`;
	if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
	return normalized;
}

export async function findFiles(
	root: string,
	pattern: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<string[]> {
	const normalizedPattern = normalizePattern(pattern);
	if (!normalizedPattern) throw new Error("File pattern must not be blank.");

	const matchPath = normalizedPattern.includes(path.sep);
	const results: string[] = [];

	const directories = [root];
	while (directories.length > 0) {
		const dir = directories.pop()!;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			signal?.throwIfAborted();
			if (!isMissingPathError(error)) throw error;
			continue;
		}
		signal?.throwIfAborted();
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;

			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_SEARCH_DIRS.has(entry.name)) directories.push(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;

			const candidate = matchPath ? path.relative(root, fullPath) : entry.name;
			if (!path.matchesGlob(candidate, normalizedPattern)) continue;
			results.push(fullPath);
			if (results.length >= maxResults) return results;
		}
	}

	return results;
}
