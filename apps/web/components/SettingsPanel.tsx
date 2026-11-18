'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type LlmKeyInfo, type EmbeddingsInfo } from '../lib/api';

/** Workspace settings: the Anthropic API key. The key is stored envelope-encrypted on the server
 * and never sent back — only its last four characters are shown. */
export function SettingsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [info, setInfo] = useState<LlmKeyInfo | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getLlmKey(workspaceId).then(setInfo).catch(() => setInfo({ configured: false, lastFour: null, provider: null }));
  }, [workspaceId]);

  async function save() {
    const key = apiKey.trim();
    if (key.length < 8) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.setLlmKey(workspaceId, key);
      setInfo(next);
      setApiKey('');
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the key');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.deleteLlmKey(workspaceId);
      setInfo(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the key');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div
        className="mt-8 w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Workspace settings</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>
        <p className="mb-5 text-sm text-slate-400">
          Anthropic API key for running tasks with Claude Opus. Stored encrypted; never shown again.
        </p>

        <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
          Anthropic API key
        </label>
        {info?.configured ? (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
            <span className="text-emerald-400">Configured · ••••{info.lastFour}</span>
            <button onClick={remove} disabled={busy} className="text-xs text-rose-400 hover:text-rose-300">
              Remove
            </button>
          </div>
        ) : (
          <p className="mb-3 text-sm text-amber-400">No key configured — tasks need one to run live.</p>
        )}

        <input
          type="password"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500"
          placeholder="sk-ant-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
        {saved && <p className="mt-2 text-sm text-emerald-400">Saved.</p>}

        <div className="my-5 h-px bg-slate-800" />
        <ProviderSection workspaceId={workspaceId} kind="brain" />
        <div className="my-5 h-px bg-slate-800" />
        <ProviderSection workspaceId={workspaceId} kind="peer" />

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
          <button
            onClick={save}
            disabled={busy || apiKey.trim().length < 8}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? 'Saving…' : info?.configured ? 'Replace key' : 'Save key'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A provider config section reused for two roles:
 *  - kind="brain": the primary agent model — Anthropic (default) or an OpenAI-compatible server
 *    (DeepSeek, or a local vLLM/Ollama serving MiMo).
 *  - kind="peer": a second model the brain can consult via the consult_peer tool (e.g. a multimodal
 *    MiMo-VL that reads images for a text-only DeepSeek brain).
 * The key is stored encrypted server-side and never returned.
 */
function ProviderSection({ workspaceId, kind }: { workspaceId: string; kind: 'brain' | 'peer' }) {
  const [info, setInfo] = useState<EmbeddingsInfo | null>(null);
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [inPrice, setInPrice] = useState('');
  const [outPrice, setOutPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isPeer = kind === 'peer';
  const title = isPeer ? 'Peer model (second brain)' : 'Model “brain” provider';
  const emptyHint = isPeer
    ? 'Optional. A second model the brain can consult — e.g. MiMo-VL to read images for a text-only DeepSeek brain. Configures the consult_peer tool.'
    : 'Default: Anthropic (Claude). Switch to an OpenAI-compatible server (DeepSeek, or a local vLLM serving MiMo).';
  const get = isPeer ? api.getPeer : api.getBrain;
  const set = isPeer ? api.setPeer : api.setBrain;
  const del = isPeer ? api.deletePeer : api.deleteBrain;

  function refresh() {
    get(workspaceId).then(setInfo).catch(() => undefined);
  }
  useEffect(refresh, [workspaceId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const i = await set(workspaceId, {
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: provider === 'openai' ? baseUrl.trim() || undefined : undefined,
        model: model.trim() || undefined,
        inputPerMTok: inPrice ? Number(inPrice) : undefined,
        outputPerMTok: outPrice ? Number(outPrice) : undefined,
      });
      setInfo(i);
      setApiKey('');
      setNotice('Saved.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await del(workspaceId).catch(() => undefined);
    setNotice(isPeer ? 'Peer model removed.' : 'Reverted to the default Anthropic key.');
    refresh();
  }

  const field =
    'rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-emerald-500';

  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">{title}</label>
      <p className="mb-2 text-xs text-slate-500">
        {info?.configured
          ? `Configured: ${info.provider}${info.model ? ` · ${info.model}` : ''}${info.lastFour ? ` · key …${info.lastFour}` : ''}`
          : emptyHint}
      </p>
      {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
      {notice && <p className="mb-2 text-sm text-emerald-400">{notice}</p>}

      <div className="flex flex-col gap-2">
        <select value={provider} onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai')} className={field}>
          <option value="openai">OpenAI-compatible (DeepSeek / local MiMo / vLLM)</option>
          <option value="anthropic">Anthropic (Claude)</option>
        </select>
        {provider === 'openai' && (
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL (e.g. https://api.deepseek.com)" className={field} />
        )}
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={isPeer ? 'Model (e.g. mimo-vl)' : 'Model (e.g. deepseek-chat)'} className={field} />
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="API key" className={field} />
        {provider === 'openai' && (
          <div className="flex gap-2">
            <input value={inPrice} onChange={(e) => setInPrice(e.target.value)} placeholder="$/1M in (opt)" className={`w-1/2 ${field}`} />
            <input value={outPrice} onChange={(e) => setOutPrice(e.target.value)} placeholder="$/1M out (opt)" className={`w-1/2 ${field}`} />
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {info?.configured && (
            <button onClick={remove} className="text-xs text-slate-500 hover:text-rose-400">
              {isPeer ? 'Remove peer' : 'Reset to default'}
            </button>
          )}
          <button onClick={save} disabled={busy} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? 'Saving…' : isPeer ? 'Save peer' : 'Save brain'}
          </button>
        </div>
      </div>
    </div>
  );
}
