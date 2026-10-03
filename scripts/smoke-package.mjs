import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PI_VERSION = manifest.devDependencies["@earendil-works/pi-coding-agent"];
// Guard: extension entry points must exist and ship in the tarball; a missing file breaks the installed extension silently.
for (const entry of manifest.pi?.extensions ?? []) {
	const rel = entry.replace(/^\.\//, "");
	if (!existsSync(join(root, rel))) throw new Error(`pi.extensions entry missing on disk: ${rel}`);
	if (!manifest.files.includes(rel) && !manifest.files.includes(rel.split("/")[0])) {
		throw new Error(`package.json files does not ship ${rel}`);
	}
}
const workspace = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
const packDirectory = join(workspace, "pack");
const hostDirectory = join(workspace, "host");
mkdirSync(packDirectory, { recursive: true });
mkdirSync(hostDirectory, { recursive: true });

try {
	const packOutput = run("npm", ["pack", "--json", "--pack-destination", packDirectory], root, true);
	const [{ filename }] = JSON.parse(packOutput);
	const tarball = join(packDirectory, filename);

	writeFileSync(
		join(hostDirectory, "package.json"),
		`${JSON.stringify({ name: "pi-package-smoke-host", private: true, type: "module" }, null, 2)}\n`,
	);
	run(
		"npm",
		["install", "--no-audit", "--no-fund", "--omit=dev", `@earendil-works/pi-coding-agent@${PI_VERSION}`, tarball],
		hostDirectory,
	);

	const installedPackage = join(hostDirectory, "node_modules", ...manifest.name.split("/"));
	if (!existsSync(installedPackage)) throw new Error(`Packed package was not installed: ${installedPackage}`);

	const piBinary = join(hostDirectory, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	const output = run(
		piBinary,
		[
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-approve",
			"--no-session",
			"-e",
			installedPackage,
			"--mode",
			"rpc",
		],
		hostDirectory,
		true,
		'{"id":"smoke","type":"get_commands"}\n',
	);
	const records = output
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const response = records.find((record) => record.type === "response" && record.id === "smoke");
	if (!response?.success || !response.data?.commands?.some((command) => command.name === "goal")) {
		throw new Error(`Packed extension did not register /goal: ${output}`);
	}
	if (records.some((record) => record.type === "extension_error")) {
		throw new Error(`Packed extension runtime error: ${output}`);
	}
	console.log(`Packed runtime smoke passed: ${manifest.name} with Pi ${PI_VERSION} on Node ${process.versions.node}`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

function run(command, args, cwd, capture = false, input) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", PI_CODING_AGENT_DIR: join(workspace, "agent") },
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		...(input ? { input, stdio: ["pipe", "pipe", "inherit"] } : {}),
		timeout: 120_000,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown"}`);
	return result.stdout ?? "";
}
