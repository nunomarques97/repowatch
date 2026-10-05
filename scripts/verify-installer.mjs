#!/usr/bin/env node
// Verifies the Windows installer built by `npm run build:installer`.
//
// Reads the file only; the installer is never run. Checks that:
//   - it exists where the Tauri bundler writes it
//     (target/release/bundle/nsis/<productName>_<version>_<arch>-setup.exe)
//     and that folder is ignored by git,
//   - it is a valid Windows GUI executable (MZ and PE headers, sections),
//   - its version resource names the product, version and copyright from
//     src-tauri/tauri.conf.json,
//   - it is per-user: its manifest asks for no elevation (asInvoker),
//   - it carries the app icon (an image of src-tauri/icons/icon.ico),
//   - it is unsigned (no Authenticode certificate table),
//   - it is smaller than 15 MB,
//   - the bundle config declares the MIT licence and the LICENSE file.
//
// Usage: npm run verify:installer [-- <path-to-setup.exe>]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 15 * 1024 * 1024;

const RT_ICON = 3;
const RT_VERSION = 16;
const RT_MANIFEST = 24;
const DIR_RESOURCE = 2;
const DIR_SECURITY = 4;
const SUBSYSTEM_WINDOWS_GUI = 2;
const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' };

const failures = [];
const passes = [];

function check(ok, message) {
  (ok ? passes : failures).push(message);
  return ok;
}

function fail(message) {
  console.error(`verify-installer: ${message}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const { productName, version } = config;
const bundle = config.bundle ?? {};

const installer = process.argv[2] ? path.resolve(process.argv[2]) : findInstaller();
if (!fs.existsSync(installer)) {
  fail(`installer not found: ${shown(installer)}\n  Build it first with: npm run build:installer`);
}
const stat = fs.statSync(installer);
if (!stat.isFile()) {
  fail(`not a file: ${installer}`);
}

console.log(`Installer: ${shown(installer)}`);
const bytes = fs.readFileSync(installer);

verifyConfig();
if (isInsideRepo(installer)) {
  check(isIgnored(installer), 'installer folder is ignored by git');
}
check(stat.size < MAX_BYTES, `size ${mb(stat.size)} is under ${mb(MAX_BYTES)}`);
try {
  verifyExecutable(bytes);
} catch (error) {
  // A truncated or corrupt file makes a header or resource read run past the end.
  check(false, `malformed executable (${error.message})`);
}

for (const message of passes) {
  console.log(`  ok   ${message}`);
}
for (const message of failures) {
  console.log(`  FAIL ${message}`);
}
if (failures.length > 0) {
  console.error(`verify-installer: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`verify-installer: all ${passes.length} checks passed`);

/** The bundler's output path for this version; the arch follows the build host. */
function findInstaller() {
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
  const dir = path.join(targetDir, 'release', 'bundle', 'nsis');
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64';
  const expected = path.join(dir, `${productName}_${version}_${arch}-setup.exe`);
  if (!fs.existsSync(expected) && fs.existsSync(dir)) {
    const others = fs.readdirSync(dir).filter((name) => name.endsWith('-setup.exe'));
    if (others.length > 0) {
      console.error(`verify-installer: found other installers in ${path.relative(root, dir)}: ${others.join(', ')}`);
    }
  }
  return expected;
}

function isInsideRepo(file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function shown(file) {
  return isInsideRepo(file) ? path.relative(root, file) : file;
}

function isIgnored(file) {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', path.relative(root, file)], { cwd: root });
  return result.status === 0;
}

function verifyConfig() {
  check(bundle.license === 'MIT', 'bundle licence is MIT');
  const licenseFile = bundle.licenseFile ? path.resolve(root, 'src-tauri', bundle.licenseFile) : '';
  const licenseText = licenseFile && fs.existsSync(licenseFile) ? fs.readFileSync(licenseFile, 'utf8') : '';
  check(licenseText.startsWith('MIT License'), 'bundle licence file is the MIT LICENSE (shown by the installer)');
  check(bundle.windows?.nsis?.installMode === 'currentUser', 'NSIS install mode is currentUser');
  const signing = bundle.windows ?? {};
  check(!signing.certificateThumbprint && !signing.signCommand, 'no signing configured');
}

function verifyExecutable(buf) {
  if (!check(buf.length > 0x40 && buf.toString('latin1', 0, 2) === 'MZ', 'DOS header (MZ)')) {
    return;
  }
  const pe = buf.readUInt32LE(0x3c);
  if (!check(pe + 24 <= buf.length && buf.toString('latin1', pe, pe + 4) === 'PE\0\0', 'PE signature')) {
    return;
  }
  const machine = buf.readUInt16LE(pe + 4);
  const sectionCount = buf.readUInt16LE(pe + 6);
  const optionalSize = buf.readUInt16LE(pe + 20);
  const optional = pe + 24;
  check(machine in MACHINES, `machine type ${MACHINES[machine] ?? `0x${machine.toString(16)}`}`);
  const magic = buf.readUInt16LE(optional);
  if (!check(magic === 0x10b || magic === 0x20b, 'optional header (PE32 or PE32+)')) {
    return;
  }
  const subsystem = buf.readUInt16LE(optional + 68);
  check(subsystem === SUBSYSTEM_WINDOWS_GUI, 'Windows GUI subsystem');
  const dataDirs = optional + (magic === 0x20b ? 112 : 96);
  const dataDir = (index) => ({
    rva: buf.readUInt32LE(dataDirs + index * 8),
    size: buf.readUInt32LE(dataDirs + index * 8 + 4),
  });

  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const at = sectionTable + i * 40;
    sections.push({
      virtualSize: buf.readUInt32LE(at + 8),
      rva: buf.readUInt32LE(at + 12),
      rawSize: buf.readUInt32LE(at + 16),
      rawOffset: buf.readUInt32LE(at + 20),
    });
  }
  const valid = sections.length > 0 && sections.every((s) => s.rawOffset + s.rawSize <= buf.length);
  if (!check(valid, `${sections.length} section(s) within the file`)) {
    return;
  }

  const security = dataDir(DIR_SECURITY);
  check(security.rva === 0 && security.size === 0, 'unsigned (no Authenticode signature)');

  const resources = readResources(buf, dataDir(DIR_RESOURCE), sections);
  if (!check(resources !== null, 'resource section')) {
    return;
  }
  verifyVersion(resources.get(RT_VERSION) ?? []);
  verifyManifest(resources.get(RT_MANIFEST) ?? []);
  verifyIcon(resources.get(RT_ICON) ?? []);
}

/** Maps resource type id to the data blobs of every name and language. */
function readResources(buf, dir, sections) {
  if (dir.rva === 0) {
    return null;
  }
  const toOffset = (rva) => {
    const s = sections.find((x) => rva >= x.rva && rva < x.rva + Math.max(x.virtualSize, x.rawSize));
    return s ? rva - s.rva + s.rawOffset : -1;
  };
  const base = toOffset(dir.rva);
  if (base < 0) {
    return null;
  }
  const entries = (offset) => {
    const at = base + offset;
    const count = buf.readUInt16LE(at + 12) + buf.readUInt16LE(at + 14);
    return Array.from({ length: count }, (_, i) => ({
      name: buf.readUInt32LE(at + 16 + i * 8),
      target: buf.readUInt32LE(at + 20 + i * 8),
    }));
  };
  const isDir = (target) => (target & 0x80000000) !== 0;
  const leaves = (target, out) => {
    if (isDir(target)) {
      for (const entry of entries(target & 0x7fffffff)) {
        leaves(entry.target, out);
      }
    } else {
      const at = base + target;
      const start = toOffset(buf.readUInt32LE(at));
      const size = buf.readUInt32LE(at + 4);
      if (start >= 0 && start + size <= buf.length) {
        out.push(buf.subarray(start, start + size));
      }
    }
    return out;
  };
  const byType = new Map();
  for (const type of entries(0)) {
    if ((type.name & 0x80000000) === 0) {
      byType.set(type.name, leaves(type.target, []));
    }
  }
  return byType;
}

function verifyVersion(blobs) {
  if (!check(blobs.length > 0, 'version resource present')) {
    return;
  }
  const info = parseVersionBlock(blobs[0], 0);
  const fixed = info.value;
  if (check(fixed.length >= 52 && fixed.readUInt32LE(0) === 0xfeef04bd, 'fixed file info')) {
    const fileVersion = versionOf(fixed.readUInt32LE(8), fixed.readUInt32LE(12));
    const productVersion = versionOf(fixed.readUInt32LE(16), fixed.readUInt32LE(20));
    check(fileVersion.startsWith(`${version}`), `file version ${fileVersion} matches ${version}`);
    check(productVersion.startsWith(`${version}`), `product version ${productVersion} matches ${version}`);
  }
  const strings = new Map();
  const stringInfo = info.children.find((child) => child.key === 'StringFileInfo');
  for (const table of stringInfo?.children ?? []) {
    for (const entry of table.children) {
      strings.set(entry.key, entry.text);
    }
  }
  check(strings.get('ProductName') === productName, `ProductName is "${strings.get('ProductName')}"`);
  check(
    (strings.get('ProductVersion') ?? '').startsWith(version),
    `ProductVersion string is "${strings.get('ProductVersion')}"`,
  );
  check(
    strings.get('LegalCopyright') === bundle.copyright,
    `LegalCopyright is "${strings.get('LegalCopyright')}"`,
  );
}

function versionOf(ms, ls) {
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
}

/** Parses one VS_VERSIONINFO-style block (length, value length, type, key, value, children). */
function parseVersionBlock(buf, start) {
  const length = buf.readUInt16LE(start);
  const valueLength = buf.readUInt16LE(start + 2);
  const isText = buf.readUInt16LE(start + 4) === 1;
  const end = Math.min(start + length, buf.length);
  let at = start + 6;
  let key = '';
  while (at + 1 < end) {
    const unit = buf.readUInt16LE(at);
    at += 2;
    if (unit === 0) {
      break;
    }
    key += String.fromCharCode(unit);
  }
  at = align4(at);
  const valueBytes = isText ? valueLength * 2 : valueLength;
  const value = buf.subarray(at, Math.min(at + valueBytes, end));
  const text = isText ? value.toString('utf16le').replace(/\0+$/, '') : '';
  at = align4(at + valueBytes);
  const children = [];
  while (at + 6 <= end) {
    const child = parseVersionBlock(buf, at);
    if (child.length === 0) {
      break;
    }
    children.push(child);
    at = align4(at + child.length);
  }
  return { length, key, value, text, children };
}

function align4(n) {
  return (n + 3) & ~3;
}

function verifyManifest(blobs) {
  if (!check(blobs.length > 0, 'application manifest present')) {
    return;
  }
  const manifest = blobs[0].toString('utf8');
  const level = /requestedExecutionLevel\s+level="([^"]+)"/.exec(manifest)?.[1];
  check(level === 'asInvoker', `per-user install, no elevation (requestedExecutionLevel ${level ?? 'missing'})`);
}

function verifyIcon(blobs) {
  const ico = fs.readFileSync(path.join(root, 'src-tauri', 'icons', 'icon.ico'));
  const images = [];
  for (let i = 0; i < ico.readUInt16LE(4); i += 1) {
    const size = ico.readUInt32LE(6 + i * 16 + 8);
    const offset = ico.readUInt32LE(6 + i * 16 + 12);
    images.push(ico.subarray(offset, offset + size));
  }
  const matches = blobs.filter((blob) => images.some((image) => image.equals(blob))).length;
  check(matches > 0, `app icon embedded (${matches} of ${images.length} icon.ico images)`);
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
