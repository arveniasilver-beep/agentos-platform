// Static file server for the AgentOS static-export SPA (apps/web/out). SPA fallback to index.html.
// Used by scripts/up.ps1 so the web app has a durable host instead of `next dev` (which exits under a
// non-TTY background process). Reads files per-request, so a fresh `next build` is served with no restart.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps', 'web', 'out'));
const PORT = Number(process.argv[3] || 3000);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};
http
  .createServer((req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      let fp = path.join(ROOT, p);
      if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        if (fs.existsSync(fp + '.html')) fp = fp + '.html';
        else fp = path.join(ROOT, 'index.html'); // SPA client-side routing fallback
      }
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(PORT, () => console.log('AgentOS static web on http://localhost:' + PORT + ' (root=' + ROOT + ')'));
