/* Live Durable-Artifact verification harness (ARTIFACT_PERSISTENCE_ENABLED=true).
 * Uses the REAL compiled TaskRunner + AgentEngine + REAL deliverable tools (generate_document /
 * generate_chart) against the REAL local Postgres and the REAL durable blob store.
 *
 *   node scripts/verify-artifacts.cjs run                      # standalone full verification (own ws)
 *   node scripts/verify-artifacts.cjs produce <wsId> <userId>  # produce+register one artifact in a ws
 */
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const apiRequire = createRequire(path.join(__dirname, '..', 'services', 'api', 'package.json'));
const { getPrisma, disconnectPrisma, tenantContext, TaskStatus } = apiRequire('@agentos/db');
const { MockProvider } = apiRequire('@agentos/llm');
const { RunController } = apiRequire('@agentos/agent-engine');
const { ToolRegistryExecutor, createDeliverableTools } = apiRequire('@agentos/tools');
const { ArtifactsService } = apiRequire('./dist/artifacts/artifacts.service.js');
const { StorageService } = apiRequire('./dist/storage/storage.service.js');
const { TaskRunner } = apiRequire('./dist/tasks/task-runner.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SANDBOX = process.env.AGENT_SANDBOX_ROOT;
const STORE = process.env.ARTIFACT_STORE_ROOT;

function deliverableScripts() {
  return [
    { text: '1. write the report\n2. add a chart', stopReason: 'end_turn' },
    { text: '', toolCalls: [{ type: 'tool_use', id: 'u1', name: 'generate_document', input: {
      title: 'Quarterly Report',
      sections: [{ heading: 'Summary', paragraphs: ['Revenue grew. Costs fell.'], bullets: ['Up 20%', 'Margin improved'] }],
    } }], stopReason: 'tool_use' },
    { text: '', toolCalls: [{ type: 'tool_use', id: 'u2', name: 'generate_chart', input: {
      title: 'Revenue', type: 'bar', data: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 14 }],
    } }], stopReason: 'tool_use' },
    { text: 'Report and chart are ready.', stopReason: 'end_turn' },
  ];
}

async function produceAndRegister(prisma, artifacts, wsId, userId) {
  const task = await prisma.task.create({
    data: { workspaceId: wsId, createdByUserId: userId, title: 'artifact run', prompt: 'produce a report and a chart', status: TaskStatus.pending },
  });
  const root = path.join(SANDBOX, task.id);
  const tools = new ToolRegistryExecutor(createDeliverableTools({ root }));
  await new TaskRunner(prisma).run({
    task: { id: task.id, workspaceId: wsId, createdByUserId: userId, prompt: task.prompt, riskCeiling: 'high', stepBudget: 12, costBudgetUsd: null },
    provider: new MockProvider(deliverableScripts()),
    tools,
    controller: new RunController(),
    registerArtifacts: () => artifacts.registerFromSandbox(wsId, task.id, null),
  });
  return task.id;
}

async function dbSnapshot(prisma, taskId) {
  const arts = await prisma.artifact.findMany({ where: { taskId }, include: { versions: { orderBy: { version: 'asc' } } }, orderBy: { name: 'asc' } });
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, result: true } });
  const finals = await prisma.taskLog.findMany({ where: { taskId, type: 'final_output' }, orderBy: { seq: 'desc' }, take: 1 });
  return {
    status: task?.status,
    resultArtifactIds: task?.result?.artifactIds ?? null,
    lastFinalOutputArtifactIds: finals[0]?.payload?.artifactIds ?? null,
    artifacts: arts.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, currentVersionId: a.currentVersionId,
      versions: a.versions.map((v) => ({ id: v.id, version: v.version, sha256: v.sha256, sizeBytes: Number(v.sizeBytes), mimeType: v.mimeType, blobKey: v.blobKey })),
    })),
  };
}

async function runStandalone() {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  const artifacts = new ArtifactsService(prisma, new StorageService());
  const report = { env: { ARTIFACT_PERSISTENCE_ENABLED: process.env.ARTIFACT_PERSISTENCE_ENABLED, AGENT_SANDBOX_ROOT: SANDBOX, ARTIFACT_STORE_ROOT: STORE }, storageBackend: new StorageService().backendName };
  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({ data: { email: `va-${suffix}@t.local`, displayName: 'VA' } });
  const ws = await prisma.workspace.create({ data: { name: 'VA', slug: `va-${suffix}`, ownerUserId: user.id } });

  // 1) Produce + register.
  const taskId = await produceAndRegister(prisma, artifacts, ws.id, user.id);
  report.taskId = taskId;
  report.deliverableFiles = fs.existsSync(path.join(SANDBOX, taskId, 'deliverables'))
    ? fs.readdirSync(path.join(SANDBOX, taskId, 'deliverables')) : [];
  report.afterRun = await dbSnapshot(prisma, taskId);

  // 2) Blob is OUTSIDE the sandbox + matches.
  const first = report.afterRun.artifacts[0];
  report.blob = { key: first.versions[0].blobKey, storeRoot: STORE, pathOutsideSandbox: !path.join(STORE, first.versions[0].blobKey).startsWith(SANDBOX), exists: fs.existsSync(path.join(STORE, first.versions[0].blobKey)) };

  // 3) Download via service + sha256 match.
  const dl = await artifacts.downloadById(ws.id, first.id);
  report.download = { artifactId: first.id, bytes: dl.data.length, sha256: sha(dl.data), dbSha256: first.versions[0].sha256, match: sha(dl.data) === first.versions[0].sha256 };

  // 4) Dedup: re-register identical content → no new version.
  await artifacts.registerFromSandbox(ws.id, taskId, null);
  const afterDedup = await dbSnapshot(prisma, taskId);
  const docName = report.afterRun.artifacts.find((a) => a.name.endsWith('.md'))?.name ?? report.afterRun.artifacts[0].name;
  report.dedup = { versionsBefore: report.afterRun.artifacts.length, sameVersionCounts: afterDedup.artifacts.every((a) => a.versions.length === 1) };

  // 5) Version+1: modify the .md deliverable and re-register.
  const mdAbs = path.join(SANDBOX, taskId, docName);
  if (fs.existsSync(mdAbs)) fs.appendFileSync(mdAbs, '\n\nAppended change.\n');
  await artifacts.registerFromSandbox(ws.id, taskId, null);
  const afterChange = await dbSnapshot(prisma, taskId);
  const changed = afterChange.artifacts.find((a) => a.name === docName);
  report.versioning = { name: docName, versions: changed?.versions.map((v) => v.version), currentIsLatest: changed?.currentVersionId === changed?.versions[changed.versions.length - 1].id };

  // 6) Sandbox cleanup → still downloadable from the durable store.
  fs.rmSync(path.join(SANDBOX, taskId), { recursive: true, force: true });
  const dl2 = await artifacts.downloadById(ws.id, first.id);
  report.afterSandboxDelete = { sandboxExists: fs.existsSync(path.join(SANDBOX, taskId)), downloadOk: dl2.data.length > 0, sha256Match: sha(dl2.data) === first.versions[0].sha256 };

  // 7) Cross-workspace (service level): another ws cannot read this artifact.
  const ws2 = await prisma.workspace.create({ data: { name: 'VA2', slug: `va2-${suffix}`, ownerUserId: user.id } });
  let crossBlocked = false;
  try { await artifacts.getMetaById(ws2.id, first.id); } catch { crossBlocked = true; }
  let crossDlBlocked = false;
  try { await artifacts.downloadById(ws2.id, first.id); } catch { crossDlBlocked = true; }
  report.crossWorkspace = { metaBlocked: crossBlocked, downloadBlocked: crossDlBlocked };

  // 8) Flag OFF: a new run registers NO durable artifact, but the deliverable files still exist (FS).
  process.env.ARTIFACT_PERSISTENCE_ENABLED = 'false';
  const offTaskId = await produceAndRegister(prisma, artifacts, ws.id, user.id);
  const offRows = await prisma.artifact.count({ where: { taskId: offTaskId } });
  const offFiles = fs.existsSync(path.join(SANDBOX, offTaskId, 'deliverables')) ? fs.readdirSync(path.join(SANDBOX, offTaskId, 'deliverables')) : [];
  report.flagOff = { taskId: offTaskId, durableRows: offRows, deliverableFilesOnDisk: offFiles.length };
  process.env.ARTIFACT_PERSISTENCE_ENABLED = 'true';

  // cleanup
  for (const id of [ws.id, ws2.id]) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);

  console.log('\n===REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END===');
  await disconnectPrisma();
}

async function produce(wsId, userId) {
  tenantContext.enterSystem();
  const prisma = getPrisma();
  const artifacts = new ArtifactsService(prisma, new StorageService());
  const taskId = await produceAndRegister(prisma, artifacts, wsId, userId);
  const snap = await dbSnapshot(prisma, taskId);
  console.log(JSON.stringify({ taskId, artifacts: snap.artifacts.map((a) => ({ id: a.id, name: a.name, sha256: a.versions[a.versions.length - 1].sha256, sizeBytes: a.versions[a.versions.length - 1].sizeBytes })), resultArtifactIds: snap.resultArtifactIds }));
  await disconnectPrisma();
}

const mode = process.argv[2];
if (mode === 'produce') {
  produce(process.argv[3], process.argv[4]).catch((e) => { console.error('PRODUCE ERROR', e); process.exit(1); });
} else {
  runStandalone().catch((e) => { console.error('RUN ERROR', e); process.exit(1); });
}
