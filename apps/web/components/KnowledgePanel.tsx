'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type EmbeddingsInfo, type KnowledgeDoc, type KnowledgeHit } from '../lib/api';

/** Knowledge base (RAG): ingest documents, configure the embeddings provider, and search. */
export function KnowledgePanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [info, setInfo] = useState<EmbeddingsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const [provider, setProvider] = useState<'openai' | 'voyage' | 'gemini' | 'local'>('local');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);

  function refresh() {
    api.listKnowledge(workspaceId).then(setDocs).catch((e) => setError(asMsg(e)));
    api.getEmbeddingsInfo(workspaceId).then(setInfo).catch(() => undefined);
  }
  useEffect(refresh, [workspaceId]);

  async function ingest() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.ingestKnowledge(workspaceId, title.trim(), content.trim());
      setNotice(`Ingested "${title}" (${r.chunks} chunk${r.chunks === 1 ? '' : 's'}, ${r.model}).`);
      setTitle('');
      setContent('');
      refresh();
    } catch (e) {
      setError(asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveEmbeddings() {
    setBusy(true);
    setError(null);
    try {
      const i = await api.setEmbeddings(workspaceId, {
        provider,
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
      });
      setInfo(i);
      setApiKey('');
      setNotice('Embeddings provider saved.');
    } catch (e) {
      setError(asMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function search() {
    if (!query.trim()) return;
    setError(null);
    try {
      setHits(await api.searchKnowledge(workspaceId, query.trim(), 5));
    } catch (e) {
      setError(asMsg(e));
    }
  }

  async function remove(t: string) {
    await api.deleteKnowledge(workspaceId, t).catch((e) => setError(asMsg(e)));
    refresh();
  }

  return (
    <Overlay onClose={onClose} title="Knowledge base (RAG)">
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="ok">{notice}</Banner>}

      <Group title="Embeddings provider">
        <p className="mb-2 text-xs text-slate-500">
          {info?.configured
            ? `Configured: ${info.provider}${info.model ? ` · ${info.model}` : ''}${info.lastFour ? ` · key …${info.lastFour}` : ''}`
            : 'Not configured — using the keyless local model (lexical similarity). Add a provider for semantic search.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200"
          >
            <option value="local">local (no key)</option>
            <option value="openai">OpenAI / compatible</option>
            <option value="voyage">Voyage</option>
            <option value="gemini">Gemini</option>
          </select>
          {provider !== 'local' && (
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key"
              type="password"
              className="min-w-[180px] flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200"
            />
          )}
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model (optional)"
            className="w-40 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200"
          />
          {provider === 'openai' && (
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="baseUrl (DeepSeek/local, optional)"
              className="min-w-[180px] flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200"
            />
          )}
          <button
            onClick={saveEmbeddings}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </Group>

      <Group title="Add a document">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste text to add to the knowledge base…"
          rows={4}
          className="mb-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
        />
        <button
          onClick={ingest}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Ingest
        </button>
      </Group>

      <Group title="Search">
        <div className="mb-2 flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            placeholder="Ask the knowledge base…"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200"
          />
          <button onClick={search} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
            Search
          </button>
        </div>
        {hits?.map((h) => (
          <div key={h.id} className="mb-1.5 rounded-lg border border-slate-800 bg-slate-900/50 p-2 text-sm">
            <div className="mb-1 text-xs text-slate-500">
              {h.title ?? '(untitled)'} · score {h.score.toFixed(3)}
            </div>
            <p className="line-clamp-3 text-slate-300">{h.content}</p>
          </div>
        ))}
        {hits && hits.length === 0 && <p className="text-sm text-slate-500">No matches.</p>}
      </Group>

      <Group title={`Documents (${docs?.length ?? 0})`}>
        {docs?.map((d) => (
          <div key={d.title} className="flex items-center justify-between gap-3 py-1 text-sm">
            <span className="truncate text-slate-300">{d.title}</span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-slate-500">{d.chunks} chunks</span>
              <button onClick={() => remove(d.title)} className="text-xs text-rose-400 hover:text-rose-300">
                Delete
              </button>
            </span>
          </div>
        ))}
        {docs && docs.length === 0 && <p className="text-sm text-slate-500">No documents yet.</p>}
      </Group>
    </Overlay>
  );
}

function asMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong';
}

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6" onClick={onClose}>
      <div
        className="mt-10 w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls = tone === 'error' ? 'border-rose-900 bg-rose-950/30 text-rose-300' : 'border-emerald-900 bg-emerald-950/30 text-emerald-300';
  return <div className={`mb-3 rounded-lg border p-2 text-sm ${cls}`}>{children}</div>;
}
