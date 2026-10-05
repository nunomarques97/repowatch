#!/usr/bin/env node
// Runs a command (cargo or the Tauri CLI) with a usable MSVC build environment.
//
// On Windows, rustc picks the newest Visual Studio installation. When that
// installation lacks the C++ x64/arm64 libraries (for example a partial
// Visual Studio install next to complete Build Tools), linking fails with
// "cannot open file 'msvcrt.lib'". This script detects that case and loads the
// environment of the newest complete installation through its vcvars batch
// file. Everywhere else it runs the command unchanged.
//
// Usage: node scripts/msvc-env.mjs <cargo|tauri> [args...]

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: node scripts/msvc-env.mjs <cargo|tauri> [args...]');
  process.exit(2);
}

const env = { ...process.env, ...msvcEnvironment() };
const [file, fileArgs] = resolveCommand(command, args);
const result = spawnSync(file, fileArgs, { stdio: 'inherit', env });
if (result.error) {
  console.error(`msvc-env: could not run ${command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

function resolveCommand(name, rest) {
  if (name === 'tauri') {
    // Run the project-local Tauri CLI through node; .cmd shims need a shell.
    const require = createRequire(import.meta.url);
    return [process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...rest]];
  }
  return [name, rest];
}

/** Returns extra environment variables, or {} when none are needed. */
function msvcEnvironment() {
  if (process.platform !== 'win32' || process.env.VCINSTALLDIR) {
    return {};
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const installs = visualStudioInstalls();
  if (installs.length === 0 || hasCrtLibs(installs[0], arch)) {
    return {};
  }
  const complete = installs.find((dir) => hasCrtLibs(dir, arch));
  if (!complete) {
    return {};
  }
  const bat = path.join(complete, 'VC', 'Auxiliary', 'Build', `vcvars${arch === 'x64' ? '64' : 'arm64'}.bat`);
  if (!existsSync(bat)) {
    return {};
  }
  const out = spawnSync('cmd.exe', ['/d', '/s', '/c', `"call "${bat}" >nul 2>&1 && set"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  if (out.status !== 0) {
    return {};
  }
  const vars = {};
  for (const line of out.stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      vars[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return vars;
}

/** Visual Studio installation paths, newest first, via vswhere. */
function visualStudioInstalls() {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) {
    return [];
  }
  const out = spawnSync(vswhere, ['-all', '-products', '*', '-sort', '-property', 'installationPath', '-utf8'], {
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    return [];
  }
  return out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** True when some MSVC toolset in the installation ships the CRT import libraries. */
function hasCrtLibs(installDir, arch) {
  const msvc = path.join(installDir, 'VC', 'Tools', 'MSVC');
  if (!existsSync(msvc)) {
    return false;
  }
  return readdirSync(msvc).some((version) => existsSync(path.join(msvc, version, 'lib', arch, 'msvcrt.lib')));
}
