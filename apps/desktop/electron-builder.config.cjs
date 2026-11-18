// electron-builder configuration. Brand identity is derived from @agentos/brand (the single source
// of truth) so a rename flows through automatically — no brand literals here. The desktop is a thin
// client: it bundles the web static export (served over app://) and talks to a running AgentOS API
// (origin via AGENTOS_API_ORIGIN, default http://localhost:4000).
const { BRAND } = require('@agentos/brand');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: BRAND.appId,
  productName: BRAND.appName,
  copyright: BRAND.copyright,
  // main + preload are bundled (esbuild) into dist/, so no node_modules need to be packaged.
  files: ['dist/**/*', 'package.json'],
  // The web SPA static export is shipped as a resource; main.ts loads it from resources/web.
  extraResources: [{ from: '../web/out', to: 'web' }],
  directories: { output: 'release', buildResources: 'build' },
  win: { target: ['nsis'], icon: 'build/icon.ico' },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  // Local/unsigned build by default; configure code signing in CI for distribution.
  forceCodeSigning: false,
  npmRebuild: false,
};
