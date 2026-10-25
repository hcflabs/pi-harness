import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildContextInjection,
	CONTEXT_FILE_BYTE_CAP,
	createContextInjectionCache,
	readFileSafe,
	scanDirContext,
} from "../extensions/add-dir-helpers.ts";

const contextNames = ["AGENTS.md", ".pi/AGENTS.md", "CLAUDE.md", ".pi/CLAUDE.md"];

test("the injection cache does not read unchanged context files again", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cache-"));
	try {
		await mkdir(join(dir, ".pi"));
		for (const name of contextNames) await writeFile(join(dir, name), `Instructions from ${name}.\n`);
		const reads: string[] = [];
		const cachedInjection = createContextInjectionCache({
			readFile(filePath) {
				reads.push(filePath);
				return readFileSafe(filePath);
			},
		});
		const added = [{ absolutePath: dir, label: "external" }];
		const first = cachedInjection(added);
		assert.equal(first, buildContextInjection(added));
		assert.deepEqual(reads, contextNames.map((name) => join(dir, name)));
		assert.equal(cachedInjection(added.map((entry) => ({ ...entry }))), first);
		assert.equal(reads.length, 4);

		// Skills do not change the injection or require context reads.
		await mkdir(join(dir, ".pi", "skills", "demo"), { recursive: true });
		await writeFile(join(dir, ".pi", "skills", "demo", "SKILL.md"), "Skill instructions.\n");
		assert.equal(cachedInjection(added), buildContextInjection(added));
		assert.equal(reads.length, 4);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("each context file change invalidates the injection cache", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cache-"));
	try {
		await mkdir(join(dir, ".pi"));
		const cachedInjection = createContextInjectionCache();
		const added = [{ absolutePath: dir, label: "external" }];
		let previous = cachedInjection(added);
		for (const name of contextNames) {
			const filePath = join(dir, name);
			await writeFile(filePath, `New instructions from ${name}.\n`);
			const created = cachedInjection(added);
			assert.notEqual(created, previous);
			assert.equal(created, buildContextInjection(added));
			await writeFile(filePath, `Changed instructions from ${name}.\n`);
			const changed = cachedInjection(added);
			assert.notEqual(changed, created);
			assert.equal(changed, buildContextInjection(added));
			await rm(filePath);
			previous = cachedInjection(added);
			assert.notEqual(previous, changed);
			assert.equal(previous, buildContextInjection(added));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the injection cache includes directory paths, labels, order, and count", () => {
	let reads = 0;
	const readFile = (filePath: string) => { reads += 1; return filePath; };
	const statFile = () => ({ size: 10, mtimeMs: 20, ctimeMs: 30, dev: 40, ino: 50 });
	const cachedInjection = createContextInjectionCache({ readFile, statFile });
	const first = { absolutePath: "/first", label: "first" };
	const second = { absolutePath: "/second", label: "second" };
	const variants = [[first], [second], [{ ...second, label: "renamed" }], [first, second], [second, first], []];
	let previous = "";
	for (const dirs of variants) {
		const before = reads;
		const injection = cachedInjection(dirs);
		assert.equal(reads - before, dirs.length * 4);
		assert.notEqual(injection, previous);
		assert.equal(injection, buildContextInjection(dirs, (filePath) => filePath));
		previous = injection;
	}
});

test("each stat field invalidates the injection cache", () => {
	let content = "initial";
	const stat = { size: 10, mtimeMs: 20, ctimeMs: 30, dev: 40, ino: 50 };
	const cachedInjection = createContextInjectionCache({ readFile: () => content, statFile: () => stat });
	const dirs = [{ absolutePath: "/external", label: "external" }];
	let previous = cachedInjection(dirs);
	for (const field of ["size", "mtimeMs", "ctimeMs", "dev", "ino"] as const) {
		stat[field] += 1;
		content = field;
		const injection = cachedInjection(dirs);
		assert.notEqual(injection, previous);
		assert.equal(injection, buildContextInjection(dirs, () => content));
		previous = injection;
	}
});

test("stat errors other than ENOENT bypass the injection cache", () => {
	for (const code of ["EACCES", "ENOTDIR", "ELOOP"]) {
		let reads = 0;
		const cachedInjection = createContextInjectionCache({
			readFile: () => { reads += 1; return "instructions"; },
			statFile: () => { throw Object.assign(new Error("Cannot inspect the file."), { code }); },
		});
		const dirs = [{ absolutePath: "/external", label: "external" }];
		assert.equal(cachedInjection(dirs), cachedInjection(dirs));
		assert.equal(reads, 8, code);
	}
});

test("a failed read or a change during the build does not remain cached", () => {
	let content: string | null = null;
	let reads = 0;
	const stat = { size: 10, mtimeMs: 20, ctimeMs: 30, dev: 40, ino: 50 };
	const cachedInjection = createContextInjectionCache({
		readFile: () => { reads += 1; return content; },
		statFile: () => stat,
	});
	const dirs = [{ absolutePath: "/external", label: "external" }];
	const failed = cachedInjection(dirs);
	content = "Recovered instructions.";
	assert.notEqual(cachedInjection(dirs), failed);
	assert.equal(reads, 8);
	cachedInjection(dirs);
	assert.equal(reads, 8);

	const changingInjection = createContextInjectionCache({
		readFile: () => { stat.ctimeMs += 1; reads += 1; return content; },
		statFile: () => stat,
	});
	changingInjection(dirs);
	changingInjection(dirs);
	assert.equal(reads, 16);
});

test("context reads preserve files at or under 64 KiB", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cap-"));
	try {
		const filePath = join(dir, "AGENTS.md");
		for (const content of ["", "Instructions: café.\r\n😀\n", "x".repeat(CONTEXT_FILE_BYTE_CAP), Buffer.from([0x61, 0xe2, 0x82])]) {
			await writeFile(filePath, content);
			assert.equal(readFileSafe(filePath), fs.readFileSync(filePath, "utf8"));
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("large context files read at most 64 KiB and end at a UTF-8 boundary", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cap-"));
	const originalRead = fs.readSync;
	let totalBytes = 0;
	let requestedBytes = 0;
	try {
		t.mock.method(fs, "readSync", (...args: Parameters<typeof originalRead>) => {
			requestedBytes += args[3] as number;
			const count = originalRead(...args);
			totalBytes += count;
			return count;
		});
		syncBuiltinESMExports();
		await mkdir(join(dir, ".pi"));
		const asciiPath = join(dir, "AGENTS.md");
		const asciiPrefix = "x".repeat(CONTEXT_FILE_BYTE_CAP);
		await writeFile(asciiPath, `${asciiPrefix}z`);
		assert.equal(readFileSafe(asciiPath), `${asciiPrefix}\n\n[pi-add-dir truncated ${asciiPath} at the 64 KiB (65536 bytes) cap.]`);
		for (const name of contextNames) {
			const filePath = join(dir, name);
			for (const character of ["é", "€", "😀"]) {
				for (let partial = 1; partial < Buffer.byteLength(character); partial += 1) {
					const prefix = "x".repeat(CONTEXT_FILE_BYTE_CAP - partial);
					await writeFile(filePath, `${prefix}${character}${"z".repeat(CONTEXT_FILE_BYTE_CAP)}`);
					totalBytes = 0;
					requestedBytes = 0;
					const content = readFileSafe(filePath);
					assert.equal(content, `${prefix}\n\n[pi-add-dir truncated ${filePath} at the 64 KiB (65536 bytes) cap.]`);
					assert.equal(totalBytes, CONTEXT_FILE_BYTE_CAP);
					assert.equal(requestedBytes, CONTEXT_FILE_BYTE_CAP);
				}
			}
		}
		assert.match(scanDirContext(dir).agentsMd!, /64 KiB \(65536 bytes\) cap/);
		assert.match(buildContextInjection([{ absolutePath: dir, label: "external" }]), /64 KiB \(65536 bytes\) cap/);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a new symlink target invalidates the cache when size and timestamps stay equal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cache-retarget-"));
	try {
		await mkdir(join(dir, ".pi"));
		const firstTarget = join(dir, "first.md");
		const secondTarget = join(dir, "other.md");
		await writeFile(firstTarget, "First instructions.\n");
		await writeFile(secondTarget, "Other instructions.\n");
		const timestamp = new Date("2020-01-01T00:00:00.000Z");
		fs.utimesSync(firstTarget, timestamp, timestamp);
		fs.utimesSync(secondTarget, timestamp, timestamp);
		const firstStat = fs.statSync(firstTarget);
		const secondStat = fs.statSync(secondTarget);
		assert.equal(firstStat.size, secondStat.size);
		assert.equal(firstStat.mtimeMs, secondStat.mtimeMs);
		assert.notDeepEqual([firstStat.dev, firstStat.ino], [secondStat.dev, secondStat.ino]);

		// utimesSync cannot set ctime. Keep it equal through the stat seam.
		const statFile = (filePath: string) => ({ ...fs.statSync(filePath), ctimeMs: firstStat.ctimeMs });
		const dirs = [{ absolutePath: dir, label: "external" }];
		for (const name of contextNames) {
			const contextPath = join(dir, name);
			await symlink(firstTarget, contextPath);
			let reads = 0;
			const cachedInjection = createContextInjectionCache({
				statFile,
				readFile(filePath) {
					reads += 1;
					return readFileSafe(filePath);
				},
			});
			const firstFingerprint = statFile(contextPath);
			const first = cachedInjection(dirs);
			assert.equal(cachedInjection(dirs), first);
			assert.equal(reads, 4);

			await rm(contextPath);
			await symlink(secondTarget, contextPath);
			const secondFingerprint = statFile(contextPath);
			assert.deepEqual(
				[firstFingerprint.size, firstFingerprint.mtimeMs, firstFingerprint.ctimeMs],
				[secondFingerprint.size, secondFingerprint.mtimeMs, secondFingerprint.ctimeMs],
			);
			assert.notDeepEqual(
				[firstFingerprint.dev, firstFingerprint.ino],
				[secondFingerprint.dev, secondFingerprint.ino],
			);
			const changed = cachedInjection(dirs);
			assert.notEqual(changed, first);
			assert.equal(changed, buildContextInjection(dirs));
			assert.match(changed, /Other instructions/);
			assert.equal(reads, 8);
			assert.equal(cachedInjection(dirs), changed);
			assert.equal(reads, 8);
			await rm(contextPath);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the injection cache follows context file symbolic links", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-add-dir-cache-link-"));
	try {
		const target = join(dir, "instructions.md");
		await writeFile(target, "First instructions.\n");
		await symlink(target, join(dir, "AGENTS.md"));
		const dirs = [{ absolutePath: dir, label: "external" }];
		const cachedInjection = createContextInjectionCache();
		const first = cachedInjection(dirs);
		await writeFile(target, "Changed target instructions.\n");
		assert.notEqual(cachedInjection(dirs), first);
		assert.equal(cachedInjection(dirs), buildContextInjection(dirs));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
