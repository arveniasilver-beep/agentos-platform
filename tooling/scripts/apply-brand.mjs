#!/usr/bin/env node
/**
 * apply-brand — propagate the single brand source (@agentos/brand) to non-TS surfaces.
 *
 * Surfaces that cannot import a TS constant (electron-builder config, MSIX/manifest metadata,
 * package productName, i18n defaults) read from the generated file this script emits.
 * Run after editing packages/brand to regenerate them. Source of truth stays in TS.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const distEntry = resolve(root, 'packages/brand/dist/index.mjs');

if (!existsSync(distEntry)) {
  console.error('[apply-brand] packages/brand is not built yet.');
  console.error('  Run:  pnpm --filter @agentos/brand build');
  process.exit(1);
}

const { BRAND } = await import(pathToFileURL(distEntry).href);

const derived = {
  productName: BRAND.appName,
  shortName: BRAND.appNameShort,
  appId: BRAND.appId,
  protocol: BRAND.protocol,
  assetScheme: BRAND.assetScheme,
  storageDomain: BRAND.storageDomain,
  supportEmail: BRAND.supportEmail,
  copyright: BRAND.copyright,
};

const outDir = resolve(root, 'build');
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, 'brand.generated.json'),
  JSON.stringify(derived, null, 2) + '\n',
  'utf8',
);

console.log(`[apply-brand] wrote build/brand.generated.json for "${BRAND.appName}" (${BRAND.appId})`);
