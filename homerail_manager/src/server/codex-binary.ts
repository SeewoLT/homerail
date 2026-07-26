import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_CODEX_BIN = "codex";

export interface CodexBinaryResolution {
  command: string;
  requested: string;
  needsShell: boolean;
}

export interface CodexBinaryResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fileExists?: (filePath: string) => boolean;
  readDirNames?: (directoryPath: string) => string[];
}

export interface CodexCommandRunOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  spawnSyncImpl?: typeof spawnSync;
}

export interface CodexCommandEnvironmentOptions {
  platform?: NodeJS.Platform;
  nodeExecPath?: string;
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function pathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return isWindows(platform) ? path.win32 : path.posix;
}

function isPathLike(command: string, platform: NodeJS.Platform): boolean {
  return pathApi(platform).isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function windowsCommandNeedsShell(command: string, platform = process.platform): boolean {
  return isWindows(platform) && /\.(cmd|bat)$/i.test(command);
}

function windowsExecutableNames(command: string, platform: NodeJS.Platform): string[] {
  if (!isWindows(platform)) return [command];
  if (/\.(exe|cmd|bat)$/i.test(command)) return [command];
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function pathCandidates(command: string, platform: NodeJS.Platform): string[] {
  if (!isWindows(platform)) return [command];
  const paths = pathApi(platform);
  const parsed = paths.parse(command);
  if (/\.(exe|cmd|bat)$/i.test(parsed.base)) return [command];
  return windowsExecutableNames(parsed.base, platform).map((name) => paths.join(parsed.dir, name));
}

function existingFile(filePath: string, fileExists: (filePath: string) => boolean): string | null {
  try {
    return fileExists(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function defaultFileExists(filePath: string, platform: NodeJS.Platform): boolean {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  if (!isWindows(platform)) fs.accessSync(filePath, fs.constants.X_OK);
  return true;
}

function defaultReadDirNames(directoryPath: string): string[] {
  return fs.readdirSync(directoryPath);
}

function existingDirectoryEntries(
  directoryPath: string,
  readDirNames: (directoryPath: string) => string[],
): string[] {
  try {
    return readDirNames(directoryPath)
      .slice(0, 64)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function findExecutableOnPath(command: string, options: Required<CodexBinaryResolveOptions>): string | null {
  const pathEnv = options.env.PATH ?? options.env.Path ?? options.env.path ?? "";
  const paths = pathApi(options.platform);
  const names = windowsExecutableNames(command, options.platform);
  for (const rawDir of pathEnv.split(paths.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const name of names) {
      const candidate = paths.join(dir, name);
      const found = existingFile(candidate, options.fileExists);
      if (found) return found;
    }
  }
  return null;
}

function codexCandidatesInDirectory(
  directoryPath: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (!directoryPath) return [];
  const paths = pathApi(platform);
  if (!paths.isAbsolute(directoryPath)) return [];
  return pathCandidates(paths.join(directoryPath, DEFAULT_CODEX_BIN), platform);
}

function versionedCodexCandidates(
  root: string,
  childPath: string[],
  options: Required<CodexBinaryResolveOptions>,
): string[] {
  const paths = pathApi(options.platform);
  return existingDirectoryEntries(root, options.readDirNames).flatMap((version) => (
    codexCandidatesInDirectory(paths.join(root, version, ...childPath), options.platform)
  ));
}

function commonCodexCandidates(options: Required<CodexBinaryResolveOptions>): string[] {
  const paths = pathApi(options.platform);
  const home = options.homeDir;
  const candidates: string[] = [];

  const addDirectory = (directoryPath: string | undefined): void => {
    candidates.push(...codexCandidatesInDirectory(directoryPath, options.platform));
  };

  addDirectory(paths.join(home, ".codex", "bin"));
  addDirectory(paths.join(home, ".local", "bin"));
  addDirectory(paths.join(home, ".npm-global", "bin"));
  addDirectory(paths.join(home, ".volta", "bin"));
  addDirectory(paths.join(home, ".bun", "bin"));
  addDirectory(paths.join(home, ".asdf", "shims"));
  addDirectory(paths.join(home, ".local", "share", "pnpm"));

  addDirectory(options.env.NVM_BIN);
  addDirectory(options.env.PNPM_HOME);
  addDirectory(options.env.VOLTA_HOME ? paths.join(options.env.VOLTA_HOME, "bin") : undefined);
  addDirectory(options.env.BUN_INSTALL ? paths.join(options.env.BUN_INSTALL, "bin") : undefined);
  const npmPrefix = options.env.npm_config_prefix ?? options.env.NPM_CONFIG_PREFIX;
  addDirectory(npmPrefix
    ? paths.join(npmPrefix, isWindows(options.platform) ? "" : "bin")
    : undefined);

  if (isWindows(options.platform)) {
    const appData = options.env.APPDATA;
    const localAppData = options.env.LOCALAPPDATA;
    if (appData) addDirectory(paths.join(appData, "npm"));
    if (localAppData) {
      addDirectory(paths.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
      addDirectory(paths.join(localAppData, "Microsoft", "WindowsApps"));
      addDirectory(paths.join(localAppData, "pnpm"));
      addDirectory(paths.join(localAppData, "Volta", "bin"));
    }
    addDirectory(paths.join(home, ".volta", "bin"));
  } else {
    if (options.platform === "darwin") {
      addDirectory(paths.join(home, "Library", "pnpm"));
      candidates.push(
        paths.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
        paths.join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
        "/Applications/Codex.app/Contents/Resources/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
      );
    }
    candidates.push("/usr/local/bin/codex", "/usr/bin/codex");
    candidates.push(
      ...versionedCodexCandidates(paths.join(home, ".nvm", "versions", "node"), ["bin"], options),
      ...versionedCodexCandidates(
        paths.join(home, ".local", "share", "fnm", "node-versions"),
        ["installation", "bin"],
        options,
      ),
      ...versionedCodexCandidates(
        paths.join(home, ".local", "share", "mise", "installs", "node"),
        ["bin"],
        options,
      ),
      ...versionedCodexCandidates(paths.join(home, ".asdf", "installs", "nodejs"), ["bin"], options),
    );
    if (options.platform === "darwin") {
      candidates.push(...versionedCodexCandidates(
        paths.join(home, "Library", "Application Support", "fnm", "node-versions"),
        ["installation", "bin"],
        options,
      ));
    }
  }

  return Array.from(new Set(candidates));
}

function resolveOptions(options: CodexBinaryResolveOptions): Required<CodexBinaryResolveOptions> {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? os.homedir(),
    fileExists: options.fileExists ?? ((filePath) => defaultFileExists(filePath, platform)),
    readDirNames: options.readDirNames ?? defaultReadDirNames,
  };
}

function requestedCodexBinary(options: Required<CodexBinaryResolveOptions>, requested?: string): string {
  const values = [requested, options.env.HOMERAIL_CODEX_BIN, options.env.CODEX_BIN_PATH];
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? DEFAULT_CODEX_BIN;
}

export function resolveCodexBinary(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): CodexBinaryResolution | null {
  const options = resolveOptions(resolveOptionsInput);
  const trimmed = requestedCodexBinary(options, requested);

  if (isPathLike(trimmed, options.platform)) {
    for (const candidate of pathCandidates(trimmed, options.platform)) {
      const found = existingFile(candidate, options.fileExists);
      if (found) return { command: found, requested: trimmed, needsShell: windowsCommandNeedsShell(found, options.platform) };
    }
    return null;
  }

  const fromPath = findExecutableOnPath(trimmed, options);
  if (fromPath) {
    return {
      command: fromPath,
      requested: trimmed,
      needsShell: windowsCommandNeedsShell(fromPath, options.platform),
    };
  }

  if (trimmed !== DEFAULT_CODEX_BIN) {
    return null;
  }

  for (const candidate of commonCodexCandidates(options)) {
    const found = existingFile(candidate, options.fileExists);
    if (found) return { command: found, requested: trimmed, needsShell: windowsCommandNeedsShell(found, options.platform) };
  }
  return null;
}

export function redactCodexDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .replace(/([?&](?:access_token|api[_-]?key|password|token)=)[^&\s]+/gi, "$1[REDACTED]");
}

export function codexBinaryDisplayPath(
  command: string,
  resolveOptionsInput: Pick<CodexBinaryResolveOptions, "platform" | "homeDir"> = {},
): string {
  const platform = resolveOptionsInput.platform ?? process.platform;
  const homeDir = resolveOptionsInput.homeDir ?? os.homedir();
  const paths = pathApi(platform);
  let display = command;
  if (paths.isAbsolute(command)) {
    const relative = paths.relative(homeDir, command);
    if (relative && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
      display = `~${paths.sep}${relative}`;
    }
  }
  return redactCodexDiagnosticText(display).slice(0, 512);
}

export function codexBinaryNotFoundMessage(
  requested?: string,
  resolveOptionsInput: CodexBinaryResolveOptions = {},
): string {
  const options = resolveOptions(resolveOptionsInput);
  const trimmed = requestedCodexBinary(options, requested);
  if (isPathLike(trimmed, options.platform)) {
    return `Codex binary not found at: ${codexBinaryDisplayPath(trimmed, options)}. Install codex or set HOMERAIL_CODEX_BIN.`;
  }
  return "Codex binary not found. Install codex or set HOMERAIL_CODEX_BIN.";
}

export function codexCommandEnvironment(
  command: string,
  source: NodeJS.ProcessEnv = process.env,
  options: CodexCommandEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const paths = pathApi(platform);
  const existingPath = source.PATH ?? source.Path ?? source.path ?? "";
  const directories = [
    isPathLike(command, platform) ? paths.dirname(command) : undefined,
    paths.dirname(options.nodeExecPath ?? process.execPath),
    ...existingPath.split(paths.delimiter),
  ].filter((directory): directory is string => Boolean(directory));
  const seen = new Set<string>();
  const normalized = directories.filter((directory) => {
    const key = isWindows(platform) ? directory.toLowerCase() : directory;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const env: NodeJS.ProcessEnv = { ...source };
  if (isWindows(platform)) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key];
    }
  }
  env.PATH = normalized.join(paths.delimiter);
  return env;
}

function failedSpawnResult(error: unknown): SpawnSyncReturns<string> {
  const message = error instanceof Error ? error.message : String(error);
  const result: SpawnSyncReturns<string> = {
    pid: 0,
    output: [null, "", message],
    stdout: "",
    stderr: message,
    status: null,
    signal: null,
  };
  if (error instanceof Error) result.error = error;
  return result;
}

export function runCodexCommandSync(
  command: string,
  args: string[],
  optionsOrTimeout: number | CodexCommandRunOptions = 5_000,
): SpawnSyncReturns<string> {
  const options: CodexCommandRunOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  try {
    return (options.spawnSyncImpl ?? spawnSync)(command, args, {
      timeout: options.timeoutMs ?? 5_000,
      encoding: "utf-8",
      env: codexCommandEnvironment(command, options.env ?? process.env, {
        platform: options.platform,
        nodeExecPath: options.nodeExecPath,
      }),
      shell: windowsCommandNeedsShell(command, options.platform ?? process.platform),
      windowsHide: true,
    });
  } catch (error) {
    return failedSpawnResult(error);
  }
}
