#!/usr/bin/env node
/**
 * scan-secrets — fail the build if any secret-shaped string appears in a CLIENT bundle.
 *
 * Hard rule: API keys and secrets must NEVER reach the frontend. This scans the web static
 * export and the desktop renderer-facing output. CI runs it after `build`; a hit exits non-zero.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

// Directories whose contents ship to / run in the client. Must contain zero secrets.
const CLIENT_DIRS = [join(root, 'apps/web/out'), join(root, 'apps/desktop/dist')];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.map']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo']);

// High-signal secret patterns (kept specific to avoid false positives on minified bundles).
const PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (TEXT_EXT.has(extname(entry.name).toLowerCase())) {
      out.push(join(dir, entry.name));
    }
  }
}

const present = CLIENT_DIRS.filter(existsSync);
if (present.length === 0) {
  console.warn('[scan-secrets] no client bundles found (build first). Skipping.');
  process.exit(0);
}

const findings = [];
for (const dir of present) {
  const files = [];
  walk(dir, files);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) {
        findings.push(`${name} in ${file.slice(root.length + 1)}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('[scan-secrets] SECRETS DETECTED IN CLIENT BUNDLE:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`[scan-secrets] OK — scanned ${present.length} client bundle(s), no secrets found.`);
