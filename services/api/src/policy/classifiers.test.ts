import { describe, it, expect } from 'vitest';
import { classifyShell, classifyFilePath, classifyUrl, classifyBrowser, isBlockedHost, classifyCodingEdit, classifyDeploy } from './classifiers';

describe('classifyCodingEdit (TICKET-CODING)', () => {
  const max = 400;
  it('allows a normal code edit', () => {
    expect(classifyCodingEdit('src/app.ts', 'write', 5, max).effect).toBe('allow');
  });
  it('denies traversal and absolute (workspace escape)', () => {
    expect(classifyCodingEdit('../escape.ts', 'write', 1, max).effect).toBe('deny');
    expect(classifyCodingEdit('/etc/passwd', 'write', 1, max).effect).toBe('deny');
  });
  it('elevates secret files', () => {
    expect(classifyCodingEdit('.env', 'write', 1, max).effect).toBe('require_elevated_approval');
    expect(classifyCodingEdit('certs/server.key', 'write', 1, max).effect).toBe('require_elevated_approval');
  });
  it('elevates lockfiles / migrations / prisma schema', () => {
    expect(classifyCodingEdit('pnpm-lock.yaml', 'write', 1, max).effect).toBe('require_elevated_approval');
    expect(classifyCodingEdit('prisma/migrations/001/migration.sql', 'write', 1, max).effect).toBe('require_elevated_approval');
    expect(classifyCodingEdit('prisma/schema.prisma', 'write', 1, max).effect).toBe('require_elevated_approval');
  });
  it('requires approval for package.json / deploy / CI config', () => {
    expect(classifyCodingEdit('package.json', 'write', 1, max).effect).toBe('require_approval');
    expect(classifyCodingEdit('Dockerfile', 'write', 1, max).effect).toBe('require_approval');
    expect(classifyCodingEdit('.github/workflows/ci.yml', 'write', 1, max).effect).toBe('require_approval');
  });
  it('requires approval for delete/rename and large diffs', () => {
    expect(classifyCodingEdit('src/app.ts', 'delete', 1, max).effect).toBe('require_approval');
    expect(classifyCodingEdit('src/app.ts', 'write', 401, max).effect).toBe('require_approval');
  });
});

describe('classifyDeploy (TICKET-CODING)', () => {
  it('denies production deploy / publish', () => {
    expect(classifyDeploy('kubectl apply -f k8s.yaml').effect).toBe('deny');
    expect(classifyDeploy('terraform apply').effect).toBe('deny');
    expect(classifyDeploy('vercel deploy --prod').effect).toBe('deny');
    expect(classifyDeploy('npm publish').effect).toBe('deny');
  });
  it('allows non-deploy commands', () => {
    expect(classifyDeploy('npm test').effect).toBe('allow');
    expect(classifyDeploy('ls -la').effect).toBe('allow');
  });
});

describe('classifyShell', () => {
  it('denies catastrophic commands', () => {
    expect(classifyShell('rm -rf /').effect).toBe('deny');
    expect(classifyShell('mkfs.ext4 /dev/sda1').effect).toBe('deny');
    expect(classifyShell('dd if=/dev/zero of=/dev/sda').effect).toBe('deny');
    expect(classifyShell(':(){:|:&};:').effect).toBe('deny');
  });
  it('elevates destructive commands', () => {
    expect(classifyShell('rm -rf build/').effect).toBe('require_elevated_approval');
    expect(classifyShell('chown -R root /app').effect).toBe('require_elevated_approval');
    expect(classifyShell('git push --force').effect).toBe('require_elevated_approval');
  });
  it('requires approval for state-mutating/network', () => {
    expect(classifyShell('curl https://example.com').effect).toBe('require_approval');
    expect(classifyShell('npm install left-pad').effect).toBe('require_approval');
    expect(classifyShell('sudo systemctl restart x').effect).toBe('require_approval');
  });
  it('allows clearly read-only commands', () => {
    expect(classifyShell('ls -la').effect).toBe('allow');
    expect(classifyShell('cat package.json').effect).toBe('allow');
    expect(classifyShell('npm test').effect).toBe('allow');
    expect(classifyShell('git status').effect).toBe('allow');
  });
  it('defaults unknown commands to approval (not allow)', () => {
    expect(classifyShell('frobnicate --weird').effect).toBe('require_approval');
  });
});

describe('classifyFilePath', () => {
  it('denies traversal', () => {
    expect(classifyFilePath('../escape.txt', 'write', true).effect).toBe('deny');
    expect(classifyFilePath('a/../../b', 'write', true).effect).toBe('deny');
  });
  it('denies absolute paths for sandbox-confined tools', () => {
    expect(classifyFilePath('/etc/passwd', 'write', true).effect).toBe('deny');
    expect(classifyFilePath('C:\\Windows\\x', 'write', true).effect).toBe('deny');
  });
  it('elevates protected/secret files', () => {
    expect(classifyFilePath('.env', 'write', true).effect).toBe('require_elevated_approval');
    expect(classifyFilePath('config/.env.production', 'write', true).effect).toBe('require_elevated_approval');
    expect(classifyFilePath('keys/server.pem', 'write', true).effect).toBe('require_elevated_approval');
    expect(classifyFilePath('.ssh/id_rsa', 'write', true).effect).toBe('require_elevated_approval');
  });
  it('requires approval for a normal workspace write, elevates delete', () => {
    expect(classifyFilePath('out/report.md', 'write', true).effect).toBe('require_approval');
    expect(classifyFilePath('out/report.md', 'delete', true).effect).toBe('require_elevated_approval');
  });
  it('treats My-Computer host writes as approval (not deny)', () => {
    expect(classifyFilePath('/home/user/approved/x.txt', 'write', false).effect).toBe('require_approval');
  });
});

describe('classifyUrl', () => {
  it('denies loopback/private/metadata hosts (SSRF)', () => {
    expect(classifyUrl('http://127.0.0.1/x', 'allow').effect).toBe('deny');
    expect(classifyUrl('http://localhost:8080/', 'allow').effect).toBe('deny');
    expect(classifyUrl('http://169.254.169.254/latest/meta-data/', 'allow').effect).toBe('deny');
    expect(classifyUrl('http://10.0.0.5/', 'allow').effect).toBe('deny');
    expect(classifyUrl('http://192.168.1.1/', 'allow').effect).toBe('deny');
    expect(classifyUrl('http://172.16.0.9/', 'allow').effect).toBe('deny');
  });
  it('requires approval for internal hostnames', () => {
    expect(classifyUrl('http://intranet/', 'allow').effect).toBe('require_approval');
    expect(classifyUrl('http://db.internal/', 'allow').effect).toBe('require_approval');
  });
  it('honors the configured public effect', () => {
    expect(classifyUrl('https://example.com/x', 'allow').effect).toBe('allow');
    expect(classifyUrl('https://example.com/x', 'require_approval').effect).toBe('require_approval');
  });
  it('denies non-http(s) schemes and junk', () => {
    expect(classifyUrl('file:///etc/passwd', 'allow').effect).toBe('deny');
    expect(classifyUrl('not a url', 'allow').effect).toBe('deny');
  });
  it('isBlockedHost basics', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
  });
});

describe('classifyBrowser', () => {
  it('allows read/screenshot, gates writes', () => {
    expect(classifyBrowser('read').effect).toBe('allow');
    expect(classifyBrowser('screenshot').effect).toBe('allow');
    expect(classifyBrowser('type').effect).toBe('require_approval');
    expect(classifyBrowser('upload').effect).toBe('require_approval');
    expect(classifyBrowser('download').effect).toBe('require_approval');
    expect(classifyBrowser('navigate').effect).toBe('require_approval');
  });
});
