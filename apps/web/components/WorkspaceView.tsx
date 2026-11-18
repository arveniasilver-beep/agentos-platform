'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CAPABILITY_META, TASK_CAPABILITIES, type TaskCapability } from '@agentos/protocol';
import { api, ApiError, type Project, type SessionUser, type Task, type Workspace } from '../lib/api';
import { applyTheme, getTheme, setTheme, watchSystemTheme, type Theme } from '../lib/theme';
import { TaskDetail } from './TaskDetail';
import { SettingsPanel } from './SettingsPanel';
import { AutomationsPanel } from './AutomationsPanel';
import { MemoryPanel } from './MemoryPanel';
import { BrowserPanel } from './BrowserPanel';
import { WorkflowsPanel } from './WorkflowsPanel';
import { InsightsPanel } from './InsightsPanel';
import { SkillsPanel } from './SkillsPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { MediaPanel } from './MediaPanel';
import { ConnectorsPanel } from './ConnectorsPanel';
import { InboundEmailPanel } from './InboundEmailPanel';
import { NotificationsBell } from './NotificationsBell';
import { PersonalizationPanel } from './PersonalizationPanel';
import { LibraryPanel } from './LibraryPanel';
import { CommandPalette } from './CommandPalette';
import { ScheduleTaskDialog } from './ScheduleTaskDialog';
import { MembersPanel } from './MembersPanel';
import { ApiKeysPanel } from './ApiKeysPanel';
import { PlaybooksPanel } from './PlaybooksPanel';
import { MyComputerPanel } from './MyComputerPanel';
import { MarketplacePanel } from './MarketplacePanel';
import { HostingPanel } from './HostingPanel';

export function WorkspaceView({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);
  const [showInbound, setShowInbound] = useState(false);
  const [showPersonalization, setShowPersonalization] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [showPlaybooks, setShowPlaybooks] = useState(false);
  const [showMyComputer, setShowMyComputer] = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [showHosting, setShowHosting] = useState(false);
  // Bumping this remounts the task view, returning to the home (composer) screen.
  const [newTaskKey, setNewTaskKey] = useState(0);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        if (ws.length > 0) setActiveId(ws[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load workspaces'));
  }, []);

  async function createWorkspace(name: string, slug: string) {
    const ws = await api.createWorkspace(name, slug);
    setWorkspaces((prev) => [...(prev ?? []), ws]);
    setActiveId(ws.id);
  }

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      {/* Manus-style left sidebar: brand, new task, navigation, account. */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-900">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <span className="text-base font-semibold tracking-tight text-slate-100">✦ AgentOS</span>
          {activeId && <NotificationsBell workspaceId={activeId} />}
        </div>
        {workspaces && workspaces.length > 0 && (
          <div className="px-3 pb-2">
            <select
              value={activeId ?? ''}
              onChange={(e) => setActiveId(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 outline-none"
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="px-3 pb-3">
          <button
            onClick={() => setNewTaskKey((k) => k + 1)}
            className="flex w-full items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
          >
            <span className="text-base leading-none">✎</span> New task
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {activeId &&
            (
              [
                ['📚', 'Library', () => setShowLibrary(true)],
                ['💻', 'My Computer', () => setShowMyComputer(true)],
                ['📘', 'Playbooks', () => setShowPlaybooks(true)],
                ['🛍️', 'Marketplace', () => setShowMarketplace(true)],
                ['🌐', 'Hosting', () => setShowHosting(true)],
                ['🧩', 'Skills', () => setShowSkills(true)],
                ['🔌', 'Connectors', () => setShowConnectors(true)],
                ['✉️', 'Mail', () => setShowInbound(true)],
                ['📖', 'Knowledge', () => setShowKnowledge(true)],
                ['🎨', 'Media', () => setShowMedia(true)],
                ['📊', 'Insights', () => setShowInsights(true)],
                ['⚡', 'Automations', () => setShowAutomations(true)],
                ['🔀', 'Workflows', () => setShowWorkflows(true)],
                ['🧠', 'Memory', () => setShowMemory(true)],
                ['🌐', 'Browser', () => setShowBrowser(true)],
                ['✨', 'Personalize', () => setShowPersonalization(true)],
                ['👥', 'Members', () => setShowMembers(true)],
                ['🔑', 'API keys', () => setShowApiKeys(true)],
              ] as const
            ).map(([icon, label, onClick]) => (
              <button
                key={label}
                onClick={onClick}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                <span className="w-4 text-center text-xs">{icon}</span>
                {label}
              </button>
            ))}
        </nav>

        <div className="border-t border-slate-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="truncate text-sm text-slate-300">{user.displayName}</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            {activeId && (
              <button onClick={() => setShowSettings(true)} className="hover:text-slate-300">
                ⚙ Settings
              </button>
            )}
            <span className="text-slate-700">·</span>
            <button
              onClick={async () => {
                await api.logout().catch(() => undefined);
                onSignedOut();
              }}
              className="hover:text-slate-300"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {showSettings && activeId && (
        <SettingsPanel workspaceId={activeId} onClose={() => setShowSettings(false)} />
      )}
      {showAutomations && activeId && (
        <AutomationsPanel workspaceId={activeId} onClose={() => setShowAutomations(false)} />
      )}
      {showMemory && activeId && (
        <MemoryPanel workspaceId={activeId} onClose={() => setShowMemory(false)} />
      )}
      {showBrowser && activeId && (
        <BrowserPanel workspaceId={activeId} onClose={() => setShowBrowser(false)} />
      )}
      {showWorkflows && activeId && (
        <WorkflowsPanel workspaceId={activeId} onClose={() => setShowWorkflows(false)} />
      )}
      {showInsights && activeId && (
        <InsightsPanel workspaceId={activeId} onClose={() => setShowInsights(false)} />
      )}
      {showSkills && activeId && (
        <SkillsPanel workspaceId={activeId} onClose={() => setShowSkills(false)} />
      )}
      {showKnowledge && activeId && (
        <KnowledgePanel workspaceId={activeId} onClose={() => setShowKnowledge(false)} />
      )}
      {showMedia && activeId && (
        <MediaPanel workspaceId={activeId} onClose={() => setShowMedia(false)} />
      )}
      {showConnectors && activeId && (
        <ConnectorsPanel workspaceId={activeId} onClose={() => setShowConnectors(false)} />
      )}
      {showInbound && activeId && (
        <InboundEmailPanel workspaceId={activeId} onClose={() => setShowInbound(false)} />
      )}
      {showPersonalization && activeId && (
        <PersonalizationPanel workspaceId={activeId} onClose={() => setShowPersonalization(false)} />
      )}
      {showLibrary && activeId && (
        <LibraryPanel workspaceId={activeId} onClose={() => setShowLibrary(false)} />
      )}
      {showMembers && activeId && (
        <MembersPanel workspaceId={activeId} onClose={() => setShowMembers(false)} />
      )}
      {showApiKeys && activeId && (
        <ApiKeysPanel workspaceId={activeId} onClose={() => setShowApiKeys(false)} />
      )}
      {showPlaybooks && activeId && (
        <PlaybooksPanel
          workspaceId={activeId}
          onClose={() => setShowPlaybooks(false)}
          onRan={() => setNewTaskKey((k) => k + 1)}
        />
      )}
      {showMyComputer && activeId && (
        <MyComputerPanel workspaceId={activeId} onClose={() => setShowMyComputer(false)} />
      )}
      {showMarketplace && activeId && (
        <MarketplacePanel workspaceId={activeId} onClose={() => setShowMarketplace(false)} onAdded={() => undefined} />
      )}
      {showHosting && activeId && <HostingPanel workspaceId={activeId} onClose={() => setShowHosting(false)} />}

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-8">
          {error && <p className="mb-4 text-sm text-rose-400">{error}</p>}
          {workspaces === null ? (
            <p className="text-slate-500">Loading…</p>
          ) : activeId ? (
            <WorkspaceTasks key={`${activeId}:${newTaskKey}`} workspaceId={activeId} />
          ) : (
            <CreateWorkspace onCreate={createWorkspace} />
          )}
        </div>
      </main>
    </div>
  );
}

/** Light / dark / auto theme cycle, persisted to localStorage. */
function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>('light');
  useEffect(() => {
    const t = getTheme();
    setThemeState(t);
    applyTheme(t);
    return watchSystemTheme(); // re-apply on OS light/dark change while set to 'auto'
  }, []);
  const next: Record<Theme, Theme> = { light: 'dark', dark: 'auto', auto: 'light' };
  const icon: Record<Theme, string> = { light: '☀️', dark: '🌙', auto: '🌗' };
  return (
    <button
      onClick={() => {
        const t = next[theme];
        setThemeState(t);
        setTheme(t);
      }}
      title={`Theme: ${theme} (click to change)`}
      className="rounded-lg px-2 py-1 text-sm hover:bg-slate-800"
    >
      {icon[theme]}
    </button>
  );
}

function CreateWorkspace({ onCreate }: { onCreate: (name: string, slug: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-slate-800 bg-slate-900/50 p-8 text-center">
      <h2 className="mb-2 text-xl font-semibold">Create your first workspace</h2>
      <p className="mb-6 text-sm text-slate-400">Workspaces hold your tasks, secrets, and members.</p>
      <input
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        placeholder="Workspace name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {slug && <p className="mt-2 text-left text-xs text-slate-500">slug: {slug}</p>}
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      <button
        disabled={busy || slug.length < 2}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onCreate(name.trim(), slug);
          } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not create workspace');
          } finally {
            setBusy(false);
          }
        }}
        className="mt-4 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create workspace'}
      </button>
    </div>
  );
}

function WorkspaceTasks({ workspaceId }: { workspaceId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string | null>(null); // null = All
  const [selected, setSelected] = useState<Task | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [scheduling, setScheduling] = useState<Task | null>(null);

  // Global Cmd/Ctrl+K opens the task search / command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Throws on failure so the palette can keep itself open and surface the error; on success it
  // navigates to the new task (which unmounts the palette).
  async function startTask(prompt: string) {
    const title = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
    const task = await api.createTask(workspaceId, { title, prompt });
    setTasks((prev) => [task, ...prev]);
    setShowPalette(false);
    setSelected(task);
  }

  const refresh = useCallback(() => {
    api.listTasks(workspaceId, showArchived).then(setTasks).catch(() => undefined);
    api.listProjects(workspaceId).then(setProjects).catch(() => undefined);
  }, [workspaceId, showArchived]);

  useEffect(() => {
    setSelected(null);
    setActiveProject(null);
    refresh();
  }, [workspaceId, refresh]);

  async function toggleFavorite(t: Task) {
    await api.updateTaskMeta(workspaceId, t.id, { favorite: !t.favorite }).catch(() => undefined);
    refresh();
  }
  async function rename(t: Task) {
    const title = window.prompt('Rename task', t.title)?.trim();
    if (!title || title === t.title) return;
    await api.updateTaskMeta(workspaceId, t.id, { title }).catch(() => undefined);
    refresh();
  }
  async function toggleArchive(t: Task) {
    await api.updateTaskMeta(workspaceId, t.id, { archived: !t.archivedAt }).catch(() => undefined);
    refresh();
  }
  async function remove(t: Task) {
    if (!window.confirm(`Delete "${t.title}"? This cannot be undone.`)) return;
    await api.deleteTask(workspaceId, t.id).catch(() => undefined);
    refresh();
  }

  async function newProject() {
    const name = window.prompt('Project name')?.trim();
    if (!name) return;
    const project = await api.createProject(workspaceId, name).catch(() => null);
    if (project) {
      setProjects((prev) => [...prev, project]);
      setActiveProject(project.id);
    }
  }

  const palette = showPalette ? (
    <CommandPalette
      workspaceId={workspaceId}
      onClose={() => setShowPalette(false)}
      onOpenTask={(task) => {
        setShowPalette(false);
        setSelected(task);
      }}
      onCreate={startTask}
    />
  ) : null;

  if (selected) {
    return (
      <>
        {palette}
        <TaskDetail
          workspaceId={workspaceId}
          task={selected}
          onBack={() => {
            setSelected(null);
            refresh();
          }}
        />
      </>
    );
  }

  const shown = activeProject ? tasks.filter((t) => t.projectId === activeProject) : tasks;

  return (
    <div className="flex flex-col gap-6">
      {palette}
      {scheduling && (
        <ScheduleTaskDialog
          workspaceId={workspaceId}
          task={scheduling}
          onClose={() => setScheduling(null)}
          onScheduled={() => setScheduling(null)}
        />
      )}
      <h1 className="mt-6 text-center font-serif text-3xl text-slate-200">What can I do for you?</h1>
      <TaskComposer
        workspaceId={workspaceId}
        projectId={activeProject}
        onCreated={(task) => {
          setTasks((prev) => [task, ...prev]);
          setSelected(task);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Chip active={activeProject === null} onClick={() => setActiveProject(null)}>
          All
        </Chip>
        {projects.map((p) => (
          <Chip key={p.id} active={activeProject === p.id} onClick={() => setActiveProject(p.id)}>
            {p.name}
          </Chip>
        ))}
        <button onClick={newProject} className="rounded-full border border-dashed border-slate-700 px-3 py-1 text-xs text-slate-400 hover:text-slate-200">
          + Project
        </button>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {showArchived ? 'Archived' : 'Tasks'}
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowPalette(true)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Search ⌘K
            </button>
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              {showArchived ? 'Active tasks' : 'Archived'}
            </button>
            <button onClick={refresh} className="text-xs text-slate-500 hover:text-slate-300">
              Refresh
            </button>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
            {showArchived ? 'No archived tasks.' : 'No tasks yet. Describe one above and AgentOS will run it.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((t) => (
              <li
                key={t.id}
                className="group flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-900/50 pr-2 hover:border-slate-700"
              >
                <button
                  onClick={() => toggleFavorite(t)}
                  title={t.favorite ? 'Unfavorite' : 'Favorite'}
                  className={`pl-3 text-sm ${t.favorite ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
                >
                  {t.favorite ? '★' : '☆'}
                </button>
                <button
                  onClick={() => setSelected(t)}
                  className="flex min-w-0 flex-1 items-center justify-between px-2 py-3 text-left"
                >
                  <span className="truncate text-sm text-slate-200">{t.title}</span>
                  <span className="ml-3 shrink-0 text-xs text-slate-500">{t.status}</span>
                </button>
                <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500 opacity-0 transition group-hover:opacity-100">
                  <button onClick={() => setScheduling(t)} className="hover:text-slate-200">
                    Schedule
                  </button>
                  <button onClick={() => rename(t)} className="hover:text-slate-200">
                    Rename
                  </button>
                  <button onClick={() => toggleArchive(t)} className="hover:text-slate-200">
                    {t.archivedAt ? 'Unarchive' : 'Archive'}
                  </button>
                  <button onClick={() => remove(t)} className="hover:text-rose-400">
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Minimal typing for the (non-standard-typed) Web Speech API so we avoid `any` while staying lint-clean.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs ${
        active ? 'bg-emerald-600 text-white' : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

function TaskComposer({
  workspaceId,
  projectId,
  onCreated,
}: {
  workspaceId: string;
  projectId: string | null;
  onCreated: (task: Task) => void;
}) {
  const [prompt, setPrompt] = useState('');
  // Chat-first default: a typed message runs as lightweight CHAT (1 call, no planning, no tool schemas) so a
  // greeting costs ~hundreds of tokens, not ~20k from the full agent pipeline. An agentic task is one click
  // away — pick the 'general' (or a deliverable) chip to escalate to the planning+tools agent.
  const [capability, setCapability] = useState<TaskCapability>('chat');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('high');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;
      const task = await api.createTask(workspaceId, {
        title,
        prompt: text,
        ...(projectId ? { projectId } : {}),
        ...(capability !== 'general' ? { capability } : {}),
        ...(effort !== 'high' ? { effort } : {}),
      });
      setPrompt('');
      setCapability('chat'); // return to the lightweight chat default after each send
      onCreated(task);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the task');
    } finally {
      setBusy(false);
    }
  }

  // Voice input via the browser Web Speech API (no key); transcript is appended to the prompt.
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  // Stop any in-flight recognition when the composer unmounts (don't leave the mic open).
  useEffect(() => () => recRef.current?.stop(), []);

  function toggleMic() {
    const SR = getSpeechRecognition();
    if (!SR) return;
    if (listening) {
      // Second click cancels an in-progress session.
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const t = e.results[0]?.[0]?.transcript ?? '';
      if (t) setPrompt((p) => (p ? `${p} ${t}` : t));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    // start() can throw synchronously (e.g. InvalidStateError, denied mic); only flip the flag on
    // success so the button never gets stuck in the listening state.
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }
  const micSupported = getSpeechRecognition() !== null;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-sm focus-within:border-emerald-500">
      <textarea
        className="w-full resize-none bg-transparent px-1 py-1 text-sm text-slate-100 outline-none placeholder:text-slate-500"
        rows={3}
        placeholder="Assign a task or ask anything…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
      />
      {/* Capability chips (Manus-style): pick the kind of deliverable to prime the agent. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {TASK_CAPABILITIES.map((id) => {
          const meta = CAPABILITY_META[id];
          const active = capability === id;
          return (
            <button
              key={id}
              type="button"
              title={meta.description}
              onClick={() => setCapability(id)}
              className={
                'rounded-full border px-3 py-1 text-xs font-medium transition ' +
                (active
                  ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                  : 'border-slate-700 bg-slate-950 text-slate-400 hover:border-slate-600 hover:text-slate-200')
              }
            >
              {meta.label}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="hidden text-xs text-slate-500 sm:inline">
          {capability === 'general'
            ? '⌘/Ctrl + Enter to run'
            : CAPABILITY_META[capability].description}
        </span>
        <div className="flex items-center gap-2">
          {/* Effort tier (Manus Lite/Pro/Max): cost/quality tradeoff. */}
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value as typeof effort)}
            title="Reasoning effort (cost/quality tradeoff)"
            className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-emerald-500"
          >
            <option value="low">Effort: Low</option>
            <option value="medium">Effort: Medium</option>
            <option value="high">Effort: High</option>
            <option value="max">Effort: Max</option>
          </select>
          {micSupported && (
            <button
              type="button"
              onClick={toggleMic}
              title="Dictate (voice input)"
              className={`rounded-lg border px-2.5 py-1.5 text-sm ${
                listening
                  ? 'animate-pulse border-rose-500 text-rose-400'
                  : 'border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              🎤
            </button>
          )}
          <button
            onClick={submit}
            disabled={busy || !prompt.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Run task'}
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
    </div>
  );
}
