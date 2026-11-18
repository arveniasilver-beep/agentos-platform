import type { RiskLevel } from '@agentos/protocol';
import { API_BASE } from './config';
import { getDeviceToken } from './device-auth';

/** Thin typed client for the AgentOS REST API. Sends the session cookie (and, in a native shell, an
 * optional Bearer device token from secure storage). */

/** Consolidated, minimal, mobile-safe sync snapshot (TICKET-5/6). No prompts/args/outputs/tokens. */
export interface SyncSnapshot {
  tasks: Array<{ id: string; title: string; status: string; updatedAt: string }>;
  approvals: Array<{ id: string; approvalId: string; taskId: string; action: string; risk: string; elevated: boolean; requestedAt: string }>;
  artifacts: Array<{ id: string; taskId: string; name: string; kind: string; createdAt: string }>;
  automationRuns: Array<{ id: string; automationId: string; status: string; triggeredBy: string; finishedAt: string | null }>;
  unreadNotifications: number;
  serverTime: string;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  riskCeiling: RiskLevel;
  capability: string | null;
  favorite: boolean;
  archivedAt: string | null;
  rating: number | null;
  projectId: string | null;
  estCostUsd: string | null;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TaskSubtask {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  estCostUsd: number | null;
}

// Multi-turn follow-up (KEYSTONE): one durable conversation turn on a task.
export interface TaskMessage {
  id: string;
  role: 'user' | 'assistant';
  seq: number;
  content: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
}

export interface Playbook {
  id: string;
  name: string;
  prompt: string;
  capability: string | null;
  effort: string | null;
}

export interface LocalFolder {
  id: string;
  label: string;
  path: string;
  writable: boolean;
}

export interface TaskEventRow {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface SharedReplay {
  title: string;
  prompt: string;
  status: TaskStatus;
  estCostUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
  events: TaskEventRow[];
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  taskId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface InboundConfig {
  token: string;
  enabled: boolean;
  allowedSenders: string[];
  taskRiskCeiling: 'low' | 'medium' | 'high' | 'critical';
  taskCostBudgetUsd: number | null;
}

export interface ConnectorView {
  provider: string;
  connected: boolean;
  clientConfigured: boolean;
  accountLabel: string | null;
  scopes: string | null;
}

export interface LibraryItem {
  taskId: string;
  taskTitle: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface Personalization {
  nickname: string | null;
  profession: string | null;
  about: string | null;
  instructions: string | null;
  memories: string[];
}

export interface BrainConfigInput {
  provider: 'anthropic' | 'openai';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

// Model Router config (TICKET-10): named provider profiles + a capability/effort route table + fallback.
export interface ModelRouteConfigInput {
  profiles: Record<string, BrainConfigInput>;
  routes: { capability?: string; effortAtLeast?: 'low' | 'medium' | 'high' | 'max'; profile: string }[];
  fallback: string[];
  default?: string;
}

export interface LlmKeyInfo {
  configured: boolean;
  lastFour: string | null;
  provider: string | null;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  riskCeiling: RiskLevel;
  lastRunAt: string | null;
  lastTaskId: string | null;
  createdAt: string;
}

/** Workflow definition (TICKET-8). `definition` is the validated JSON DSL. */
export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  cronExpression: string | null;
  createdAt: string;
}
/** A workflow run with its per-step state trace. */
export interface WorkflowRunRow {
  id: string;
  workflowId: string;
  status: string;
  triggeredBy: string;
  currentStepId: string | null;
  stepStates: Array<{ stepId: string; type: string; status: string; taskId?: string; branch?: boolean }>;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

/** Durable browser session (TICKET-1). URLs are sanitized server-side (no secrets). */
export interface BrowserSessionRow {
  id: string;
  taskId: string | null;
  status: string;
  lastUrl: string | null;
  lastAction: string | null;
  actionCount: number;
  approvalCount: number;
  deniedCount: number;
  takeover: boolean;
  startedAt: string;
  endedAt: string | null;
}

/** One durable browser action in a session's trace (redacted). */
export interface BrowserActionRow {
  id: string;
  action: string;
  url: string | null;
  target: string | null;
  risk: string;
  outcome: string;
  approvalId: string | null;
  createdAt: string;
}

/** Project Memory entry (TICKET-MEMORY). Content is already redacted server-side. */
export interface ProjectMemoryEntry {
  id: string;
  kind: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  priority: number;
  projectId: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

/** Durable AutomationRun history row (TICKET-AUTOMATION). */
export interface AutomationRun {
  id: string;
  automationId: string;
  taskId: string | null;
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped';
  triggeredBy: 'manual' | 'scheduled';
  attempt: number;
  skipReason: string | null;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface UsageSummary {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    taskCount: number;
  };
  recentTasks: Array<{ id: string; title: string; status: string; costUsd: number; createdAt: string }>;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string | null;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  risk: RiskLevel | null;
  createdAt: string;
}

export interface Artifact {
  path: string;
  size: number;
  modifiedAt: string;
}

/** Durable artifact metadata (TICKET-ART). `sizeBytes` is a plain number (BigInt-safe on the server). */
export interface ArtifactMeta {
  id: string;
  taskId: string;
  name: string;
  kind: string;
  versionId: string;
  version: number;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

export interface SkillParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description?: string;
}
export interface Skill {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  riskCeiling: RiskLevel;
  createdAt: string;
  // Skills v2 (TICKET-4) — present once the v2 fields are set.
  version?: number;
  params?: SkillParam[] | null;
  capability?: string | null;
  effort?: string | null;
}

export interface ApiKeyInfo {
  id: string;
  publicId: string;
  label: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Member {
  id: string;
  userId: string;
  role: MemberRole;
  user: { id: string; email: string; displayName: string };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // TICKET-6: in a native shell, a Bearer device token (from secure storage) may be present; the web/PWA
  // path leaves this null and relies on the httpOnly cookie. AuthGuard prefers the cookie when both exist.
  const bearer = getDeviceToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...init?.headers,
    },
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    if (data && typeof data === 'object' && 'message' in data) {
      const m = (data as { message: unknown }).message;
      if (typeof m === 'string') message = m;
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  // --- auth --- (the API wraps the user as { user }, so unwrap it here)
  register: async (email: string, password: string, displayName: string) =>
    (
      await request<{ user: SessionUser }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, displayName }),
      })
    ).user,
  login: async (email: string, password: string) =>
    (
      await request<{ user: SessionUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
    ).user,
  me: async () => (await request<{ user: SessionUser }>('/auth/me')).user,
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  // --- workspaces ---
  listWorkspaces: () => request<Workspace[]>('/workspaces'),
  createWorkspace: (name: string, slug: string) =>
    request<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ name, slug }) }),

  // --- members ---
  listMembers: (workspaceId: string) => request<Member[]>(`/workspaces/${workspaceId}/members`),
  addMember: (workspaceId: string, email: string, role: Exclude<MemberRole, 'owner'>) =>
    request<Member>(`/workspaces/${workspaceId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  updateMemberRole: (workspaceId: string, memberUserId: string, role: Exclude<MemberRole, 'owner'>) =>
    request<Member>(`/workspaces/${workspaceId}/members/${memberUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (workspaceId: string, memberUserId: string) =>
    request<{ removed: boolean }>(`/workspaces/${workspaceId}/members/${memberUserId}`, {
      method: 'DELETE',
    }),

  // --- projects ---
  listProjects: (workspaceId: string) => request<Project[]>(`/workspaces/${workspaceId}/projects`),
  createProject: (workspaceId: string, name: string) =>
    request<Project>(`/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  // --- playbooks (reusable task templates) ---
  listPlaybooks: (workspaceId: string) =>
    request<Playbook[]>(`/workspaces/${workspaceId}/playbooks`),
  createPlaybook: (
    workspaceId: string,
    input: { name: string; prompt: string; capability?: string; effort?: string },
  ) =>
    request<Playbook>(`/workspaces/${workspaceId}/playbooks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deletePlaybook: (workspaceId: string, id: string) =>
    request<{ id: string }>(`/workspaces/${workspaceId}/playbooks/${id}`, { method: 'DELETE' }),

  // --- My Computer (approved local folders) ---
  getLocalFolders: (workspaceId: string) =>
    request<{ enabled: boolean; folders: LocalFolder[] }>(`/workspaces/${workspaceId}/local-folders`),
  addLocalFolder: (workspaceId: string, input: { label: string; path: string; writable?: boolean }) =>
    request<LocalFolder>(`/workspaces/${workspaceId}/local-folders`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteLocalFolder: (workspaceId: string, id: string) =>
    request<{ id: string }>(`/workspaces/${workspaceId}/local-folders/${id}`, { method: 'DELETE' }),

  // --- Hosting (static-site deploy) ---
  getHosting: (workspaceId: string) =>
    request<{ configured: boolean; lastFour: string | null }>(`/workspaces/${workspaceId}/hosting`),
  setHosting: (
    workspaceId: string,
    config: { token: string; backend?: 'netlify' | 'selfhosted'; endpoint?: string },
  ) =>
    request<{ configured: boolean; lastFour: string | null }>(`/workspaces/${workspaceId}/hosting`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  clearHosting: (workspaceId: string) =>
    request<{ ok: boolean }>(`/workspaces/${workspaceId}/hosting`, { method: 'DELETE' }),

  // --- tasks ---
  listTasks: (workspaceId: string, archived = false) =>
    request<Task[]>(`/workspaces/${workspaceId}/tasks${archived ? '?archived=true' : ''}`),
  updateTaskMeta: (
    workspaceId: string,
    taskId: string,
    patch: { title?: string; favorite?: boolean; archived?: boolean; rating?: number },
  ) =>
    request<Task>(`/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteTask: (workspaceId: string, taskId: string) =>
    request<{ deleted: boolean }>(`/workspaces/${workspaceId}/tasks/${taskId}`, { method: 'DELETE' }),
  listLibrary: (workspaceId: string) =>
    request<{ items: LibraryItem[]; truncated: boolean }>(`/workspaces/${workspaceId}/library`),
  searchTasks: (workspaceId: string, q: string) =>
    request<Task[]>(`/workspaces/${workspaceId}/tasks/search?q=${encodeURIComponent(q)}`),
  createTask: (
    workspaceId: string,
    input: {
      title: string;
      prompt: string;
      riskCeiling?: RiskLevel;
      projectId?: string;
      capability?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
    },
  ) =>
    request<Task>(`/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getTask: (workspaceId: string, taskId: string) =>
    request<Task & { running: boolean; subtasks: TaskSubtask[] }>(
      `/workspaces/${workspaceId}/tasks/${taskId}`,
    ),
  taskEvents: (workspaceId: string, taskId: string) =>
    request<TaskEventRow[]>(`/workspaces/${workspaceId}/tasks/${taskId}/events`),
  shareTask: (workspaceId: string, taskId: string) =>
    request<{ shareId: string }>(`/workspaces/${workspaceId}/tasks/${taskId}/share`, { method: 'POST' }),
  unshareTask: (workspaceId: string, taskId: string) =>
    request<void>(`/workspaces/${workspaceId}/tasks/${taskId}/share`, { method: 'DELETE' }),
  getSharedReplay: (shareId: string) => request<SharedReplay>(`/public/replay/${shareId}`),
  stopTask: (workspaceId: string, taskId: string) =>
    request<Task>(`/workspaces/${workspaceId}/tasks/${taskId}/stop`, { method: 'POST' }),
  // Multi-turn follow-up (KEYSTONE): the durable chat thread + sending a new turn that continues the task.
  listTaskMessages: (workspaceId: string, taskId: string) =>
    request<TaskMessage[]>(`/workspaces/${workspaceId}/tasks/${taskId}/messages`),
  sendTaskMessage: (workspaceId: string, taskId: string, text: string) =>
    request<Task>(`/workspaces/${workspaceId}/tasks/${taskId}/messages`, { method: 'POST', body: JSON.stringify({ text }) }),
  decideApproval: (
    workspaceId: string,
    taskId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    confirmation?: string,
  ) =>
    request<{ approvalId: string; decision: string }>(
      `/workspaces/${workspaceId}/tasks/${taskId}/approvals/${approvalId}`,
      { method: 'POST', body: JSON.stringify(confirmation ? { decision, confirmation } : { decision }) },
    ),

  // --- settings: LLM key (envelope-encrypted server-side; the key itself is never returned) ---
  getLlmKey: (workspaceId: string) =>
    request<LlmKeyInfo>(`/workspaces/${workspaceId}/settings/llm-key`),
  setLlmKey: (workspaceId: string, apiKey: string) =>
    request<LlmKeyInfo>(`/workspaces/${workspaceId}/settings/llm-key`, {
      method: 'PUT',
      body: JSON.stringify({ apiKey, provider: 'anthropic' }),
    }),
  deleteLlmKey: (workspaceId: string) =>
    request<LlmKeyInfo>(`/workspaces/${workspaceId}/settings/llm-key`, { method: 'DELETE' }),

  // --- chat "brain" provider (Anthropic default, or OpenAI-compatible: DeepSeek / local MiMo) ---
  getBrain: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/brain`),
  setBrain: (workspaceId: string, input: BrainConfigInput) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/brain`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteBrain: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/brain`, { method: 'DELETE' }),

  // --- peer "second brain" the agent can consult (e.g. brain=DeepSeek, peer=MiMo-VL for vision) ---
  getPeer: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/peer`),
  setPeer: (workspaceId: string, input: BrainConfigInput) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/peer`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deletePeer: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/peer`, { method: 'DELETE' }),

  // --- Model Router config: named provider profiles + capability/effort route table + fallback (TICKET-10).
  // Admin-only write; profile API keys are never returned. Inert unless MODEL_ROUTER_ENABLED. ---
  getModelRoute: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/route`),
  setModelRoute: (workspaceId: string, input: ModelRouteConfigInput) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/route`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  deleteModelRoute: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/settings/route`, { method: 'DELETE' }),

  // --- notifications (header bell) ---
  getNotifications: (workspaceId: string) =>
    request<{ items: NotificationView[]; unread: number }>(`/workspaces/${workspaceId}/notifications`),
  markNotificationsRead: (workspaceId: string, id?: string) =>
    request<{ unread: number }>(`/workspaces/${workspaceId}/notifications/read`, {
      method: 'POST',
      body: JSON.stringify(id ? { id } : {}),
    }),

  // --- mail-to-task inbound ---
  getInbound: (workspaceId: string) =>
    request<InboundConfig>(`/workspaces/${workspaceId}/inbound`),
  updateInbound: (
    workspaceId: string,
    input: {
      enabled?: boolean;
      allowedSenders?: string[];
      taskRiskCeiling?: 'low' | 'medium' | 'high' | 'critical';
      taskCostBudgetUsd?: number | null;
    },
  ) =>
    request<InboundConfig>(`/workspaces/${workspaceId}/inbound`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  regenerateInbound: (workspaceId: string) =>
    request<InboundConfig>(`/workspaces/${workspaceId}/inbound/regenerate`, { method: 'POST' }),

  // --- connectors (OAuth: GitHub, ...) ---
  listConnectors: (workspaceId: string) =>
    request<ConnectorView[]>(`/workspaces/${workspaceId}/connectors`),
  setConnectorConfig: (
    workspaceId: string,
    provider: string,
    input: { clientId: string; clientSecret: string },
  ) =>
    request<void>(`/workspaces/${workspaceId}/connectors/${provider}/config`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getConnectorStartUrl: (workspaceId: string, provider: string) =>
    request<{ url: string }>(`/workspaces/${workspaceId}/connectors/${provider}/start`),
  disconnectConnector: (workspaceId: string, provider: string) =>
    request<void>(`/workspaces/${workspaceId}/connectors/${provider}`, { method: 'DELETE' }),

  // --- personalization (always-on profile + custom instructions + memory) ---
  getPersonalization: (workspaceId: string) =>
    request<Personalization>(`/workspaces/${workspaceId}/personalization`),
  updatePersonalization: (workspaceId: string, input: Personalization) =>
    request<Personalization>(`/workspaces/${workspaceId}/personalization`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  // --- automations ---
  listAutomations: (workspaceId: string) =>
    request<Automation[]>(`/workspaces/${workspaceId}/automations`),
  createAutomation: (
    workspaceId: string,
    input: { name: string; prompt: string; cronExpression: string; timezone?: string },
  ) =>
    request<Automation>(`/workspaces/${workspaceId}/automations`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setAutomationEnabled: (workspaceId: string, automationId: string, enabled: boolean) =>
    request<Automation>(`/workspaces/${workspaceId}/automations/${automationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  runAutomation: (workspaceId: string, automationId: string) =>
    request<{ taskId: string | null }>(
      `/workspaces/${workspaceId}/automations/${automationId}/run`,
      { method: 'POST' },
    ),
  deleteAutomation: (workspaceId: string, automationId: string) =>
    request<{ deleted: boolean }>(`/workspaces/${workspaceId}/automations/${automationId}`, {
      method: 'DELETE',
    }),
  // Durable AutomationRun history (TICKET-AUTOMATION) — empty unless AUTOMATION_RUNS_ENABLED.
  listAutomationRuns: (workspaceId: string, automationId: string) =>
    request<AutomationRun[]>(`/workspaces/${workspaceId}/automations/${automationId}/runs`),

  // --- project memory (TICKET-MEMORY) ---
  listMemory: (workspaceId: string, opts?: { kind?: string; includeArchived?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts?.kind) qs.set('kind', opts.kind);
    if (opts?.includeArchived) qs.set('includeArchived', 'true');
    const q = qs.toString();
    return request<ProjectMemoryEntry[]>(`/workspaces/${workspaceId}/memory${q ? `?${q}` : ''}`);
  },
  createMemory: (
    workspaceId: string,
    input: { kind: string; content: string; source?: string; tags?: string[]; priority?: number; confidence?: number; expiresAt?: string | null },
  ) => request<ProjectMemoryEntry>(`/workspaces/${workspaceId}/memory`, { method: 'POST', body: JSON.stringify(input) }),
  updateMemory: (
    workspaceId: string,
    id: string,
    input: { kind?: string; content?: string; tags?: string[]; priority?: number; confidence?: number; expiresAt?: string | null },
  ) => request<ProjectMemoryEntry>(`/workspaces/${workspaceId}/memory/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  archiveMemory: (workspaceId: string, id: string) =>
    request<ProjectMemoryEntry>(`/workspaces/${workspaceId}/memory/${id}/archive`, { method: 'POST' }),
  deleteMemory: (workspaceId: string, id: string) =>
    request<{ deleted: boolean }>(`/workspaces/${workspaceId}/memory/${id}`, { method: 'DELETE' }),

  // --- workflows (TICKET-8) ---
  listWorkflows: (workspaceId: string) => request<Workflow[]>(`/workspaces/${workspaceId}/workflows`),
  createWorkflow: (workspaceId: string, input: { name: string; definition: unknown }) =>
    request<{ workflow: Workflow; webhookToken?: string }>(`/workspaces/${workspaceId}/workflows`, { method: 'POST', body: JSON.stringify(input) }),
  runWorkflow: (workspaceId: string, id: string) =>
    request<WorkflowRunRow>(`/workspaces/${workspaceId}/workflows/${id}/run`, { method: 'POST' }),
  listWorkflowRuns: (workspaceId: string, id: string) =>
    request<WorkflowRunRow[]>(`/workspaces/${workspaceId}/workflows/${id}/runs`),
  deleteWorkflow: (workspaceId: string, id: string) =>
    request<{ deleted: boolean }>(`/workspaces/${workspaceId}/workflows/${id}`, { method: 'DELETE' }),
  decideWorkflowApproval: (workspaceId: string, runId: string, decision: 'approve' | 'deny') =>
    request<WorkflowRunRow>(`/workspaces/${workspaceId}/workflows/runs/${runId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }),

  // --- device sync snapshot (TICKET-5/6) ---
  syncSnapshot: (workspaceId: string) => request<SyncSnapshot>(`/workspaces/${workspaceId}/sync/snapshot`),

  // --- browser operator trace (TICKET-1) ---
  listBrowserSessions: (workspaceId: string) =>
    request<BrowserSessionRow[]>(`/workspaces/${workspaceId}/browser-sessions`),
  listBrowserActions: (workspaceId: string, sessionId: string) =>
    request<BrowserActionRow[]>(`/workspaces/${workspaceId}/browser-sessions/${sessionId}/actions`),

  // --- skills ---
  listSkills: (workspaceId: string) => request<Skill[]>(`/workspaces/${workspaceId}/skills`),
  createSkill: (
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      instructions: string;
      // Skills v2 (TICKET-4)
      params?: SkillParam[];
      capability?: string;
      effort?: string;
    },
  ) =>
    request<Skill>(`/workspaces/${workspaceId}/skills`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  runSkill: (workspaceId: string, skillId: string, input?: string, params?: Record<string, unknown>) =>
    request<Task>(`/workspaces/${workspaceId}/skills/${skillId}/run`, {
      method: 'POST',
      body: JSON.stringify({ ...(input ? { input } : {}), ...(params ? { params } : {}) }),
    }),
  deleteSkill: (workspaceId: string, skillId: string) =>
    request<{ deleted: boolean }>(`/workspaces/${workspaceId}/skills/${skillId}`, { method: 'DELETE' }),

  // --- api keys ---
  listApiKeys: (workspaceId: string) => request<ApiKeyInfo[]>(`/workspaces/${workspaceId}/api-keys`),
  createApiKey: (workspaceId: string, label?: string) =>
    request<{ id: string; token: string; createdAt: string }>(`/workspaces/${workspaceId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({ ...(label ? { label } : {}) }),
    }),
  revokeApiKey: (workspaceId: string, keyId: string) =>
    request<{ revoked: boolean }>(`/workspaces/${workspaceId}/api-keys/${keyId}`, { method: 'DELETE' }),

  // --- insights ---
  getUsage: (workspaceId: string) => request<UsageSummary>(`/workspaces/${workspaceId}/usage`),
  getAudit: (workspaceId: string) =>
    request<{ entries: AuditEntry[]; chainValid: boolean }>(`/workspaces/${workspaceId}/audit`),

  // --- artifacts ---
  listArtifacts: (workspaceId: string, taskId: string) =>
    request<Artifact[]>(`/workspaces/${workspaceId}/tasks/${taskId}/artifacts`),
  downloadArtifact: async (workspaceId: string, taskId: string, path: string): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/workspaces/${workspaceId}/tasks/${taskId}/artifacts/download?path=${encodeURIComponent(path)}`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
    return res.blob();
  },
  uploadArtifact: (workspaceId: string, taskId: string, filename: string, dataBase64: string) =>
    request<Artifact>(`/workspaces/${workspaceId}/tasks/${taskId}/artifacts/upload`, {
      method: 'POST',
      body: JSON.stringify({ filename, dataBase64 }),
    }),
  // Durable artifacts (TICKET-ART): DB-backed, blob-stored, versioned.
  listDurableArtifacts: (workspaceId: string, taskId: string) =>
    request<ArtifactMeta[]>(`/workspaces/${workspaceId}/tasks/${taskId}/artifacts/durable`),
  downloadDurableArtifact: async (workspaceId: string, taskId: string, artifactId: string): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/workspaces/${workspaceId}/tasks/${taskId}/artifacts/id/${encodeURIComponent(artifactId)}/download`,
      { credentials: 'include' },
    );
    if (!res.ok) throw new ApiError(res.status, `Download failed (${res.status})`);
    return res.blob();
  },

  // ---- Knowledge / RAG ----
  ingestKnowledge: (workspaceId: string, title: string, content: string) =>
    request<{ chunks: number; model: string }>(`/workspaces/${workspaceId}/knowledge/documents`, {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    }),
  listKnowledge: (workspaceId: string) =>
    request<KnowledgeDoc[]>(`/workspaces/${workspaceId}/knowledge/documents`),
  deleteKnowledge: (workspaceId: string, title: string) =>
    request<number>(`/workspaces/${workspaceId}/knowledge/documents?title=${encodeURIComponent(title)}`, {
      method: 'DELETE',
    }),
  searchKnowledge: (workspaceId: string, q: string, k = 5) =>
    request<KnowledgeHit[]>(`/workspaces/${workspaceId}/knowledge/search?q=${encodeURIComponent(q)}&k=${k}`),
  getEmbeddingsInfo: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/knowledge/embeddings`),
  setEmbeddings: (workspaceId: string, config: EmbeddingsConfigInput) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/knowledge/embeddings`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  deleteEmbeddings: (workspaceId: string) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/knowledge/embeddings`, { method: 'DELETE' }),

  // --- media generation provider config (image + speech; keys stored encrypted server-side) ---
  getMediaInfo: (workspaceId: string, kind: 'image' | 'speech') =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/media/${kind}`),
  setMedia: (workspaceId: string, kind: 'image' | 'speech', config: MediaConfigInput) =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/media/${kind}`, {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  deleteMedia: (workspaceId: string, kind: 'image' | 'speech') =>
    request<EmbeddingsInfo>(`/workspaces/${workspaceId}/media/${kind}`, { method: 'DELETE' }),
};

export interface MediaConfigInput {
  provider: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
}

export interface KnowledgeDoc {
  title: string;
  ownerType: string;
  chunks: number;
}
export interface KnowledgeHit {
  id: string;
  content: string;
  score: number;
  title: string | null;
}
export interface EmbeddingsInfo {
  configured: boolean;
  provider: string | null;
  model: string | null;
  lastFour: string | null;
}
export interface EmbeddingsConfigInput {
  provider: 'openai' | 'voyage' | 'gemini' | 'local';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}
