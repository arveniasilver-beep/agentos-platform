'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type EmbeddingsInfo } from '../lib/api';

/**
 * Media generation settings: configure the workspace's image + speech providers. Keys are sent to
 * the server (encrypted at rest, never read back — only provider/model/lastFour are shown), exactly
 * like the Anthropic/embeddings keys. Once a provider is set, the agent's generate_image /
 * generate_speech tools (and the Image/Audio capability chips) become usable.
 */
const IMAGE_PROVIDERS = ['openai', 'gemini', 'mock'] as const;
const SPEECH_PROVIDERS = ['openai', 'mock'] as const;

export function MediaPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Media generation</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Configure image + speech providers. Keys are encrypted server-side and never returned. Once
          set, the agent can use generate_image / generate_speech and the Image/Audio modes.
        </p>
        <ProviderSection
          workspaceId={workspaceId}
          kind="image"
          title="Image provider"
          providers={IMAGE_PROVIDERS as readonly string[]}
          modelHint="gpt-image-1, dall-e-3, imagen-3.0-generate-002"
          withVoice={false}
        />
        <div className="my-5 h-px bg-slate-800" />
        <ProviderSection
          workspaceId={workspaceId}
          kind="speech"
          title="Speech provider (text-to-speech)"
          providers={SPEECH_PROVIDERS as readonly string[]}
          modelHint="tts-1, tts-1-hd"
          withVoice
        />
      </div>
    </div>
  );
}

function ProviderSection({
  workspaceId,
  kind,
  title,
  providers,
  modelHint,
  withVoice,
}: {
  workspaceId: string;
  kind: 'image' | 'speech';
  title: string;
  providers: readonly string[];
  modelHint: string;
  withVoice: boolean;
}) {
  const [info, setInfo] = useState<EmbeddingsInfo | null>(null);
  const [provider, setProvider] = useState<string>(providers[0] ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [voice, setVoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    api.getMediaInfo(workspaceId, kind).then(setInfo).catch(() => undefined);
  }
  useEffect(refresh, [workspaceId, kind]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const i = await api.setMedia(workspaceId, kind, {
        provider,
        apiKey: apiKey.trim() || undefined,
        model: model.trim() || undefined,
        voice: withVoice ? voice.trim() || undefined : undefined,
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
    await api.deleteMedia(workspaceId, kind).catch(() => undefined);
    refresh();
  }

  const field =
    'rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-emerald-500';

  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <p className="mb-2 text-xs text-slate-500">
        {info?.configured
          ? `Configured: ${info.provider}${info.model ? ` · ${info.model}` : ''}${info.lastFour ? ` · key …${info.lastFour}` : ''}`
          : 'Not configured.'}
      </p>
      {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}
      {notice && <p className="mb-2 text-sm text-emerald-400">{notice}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className={field}>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p === 'mock' ? 'mock (test, no key)' : p}
            </option>
          ))}
        </select>
        {provider !== 'mock' && (
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="API key"
            type="password"
            className={`min-w-[160px] flex-1 ${field}`}
          />
        )}
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model (optional)"
          title={modelHint}
          className={`w-44 ${field}`}
        />
        {withVoice && (
          <input
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            placeholder="voice (optional)"
            className={`w-32 ${field}`}
          />
        )}
        <button
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {info?.configured && (
          <button onClick={remove} className="text-xs text-slate-500 hover:text-rose-400">
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
