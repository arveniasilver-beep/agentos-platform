'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type ConnectorView } from '../lib/api';
import { API_BASE } from '../lib/config';

/**
 * Connectors (OAuth integrations, e.g. GitHub). An admin pastes the OAuth app's Client ID + Secret
 * (stored encrypted), then clicks Connect — which redirects to the provider, and on return the agent
 * gets the connector's tools (e.g. github_list_repos). Keys/tokens never come back to the client.
 */
const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  notion: 'Notion',
  google: 'Google (Calendar + Drive)',
  outlook: 'Outlook (Mail + Calendar)',
};

export function ConnectorsPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api
      .listConnectors(workspaceId)
      .then(setConnectors)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load connectors'));
  }
  useEffect(refresh, [workspaceId]);

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
          <h2 className="text-lg font-semibold text-slate-100">Connectors</h2>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            Close
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-500">
          Connect third-party accounts. Register an OAuth app with the provider, paste its Client ID +
          Secret (encrypted server-side), then Connect.
        </p>
        {error && (
          <div className="mb-3 rounded-lg border border-rose-900 bg-rose-950/30 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}
        {!connectors ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            {connectors.map((c) => (
              <ConnectorRow key={c.provider} workspaceId={workspaceId} view={c} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectorRow({
  workspaceId,
  view,
  onChanged,
}: {
  workspaceId: string;
  view: ConnectorView;
  onChanged: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const label = PROVIDER_LABELS[view.provider] ?? view.provider;

  // Must equal the server's redirect_uri (built from PUBLIC_API_BASE_URL); derive it from the same
  // API origin the SPA talks to, not a guessed host/port.
  const callbackUrl = `${API_BASE}/connectors/${view.provider}/callback`;

  async function saveConfig() {
    if (!clientId.trim() || !clientSecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.setConnectorConfig(workspaceId, view.provider, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setClientId('');
      setClientSecret('');
      setSaved(true); // confirm so clearing the inputs doesn't read as "it lost my input"
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setError(null);
    try {
      const { url } = await api.getConnectorStartUrl(workspaceId, view.provider);
      window.location.href = url; // redirect to the provider's consent screen
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start connect');
    }
  }

  async function disconnect() {
    try {
      await api.disconnectConnector(workspaceId, view.provider);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not disconnect');
    }
  }

  const field =
    'rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-emerald-500';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-200">{label}</span>
        {view.connected ? (
          <span className="rounded-full border border-emerald-700 bg-emerald-600/20 px-2 py-0.5 text-xs text-emerald-300">
            Connected{view.accountLabel ? ` · ${view.accountLabel}` : ''}
          </span>
        ) : (
          <span className="text-xs text-slate-500">{view.clientConfigured ? 'Not connected' : 'Not configured'}</span>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-rose-400">{error}</p>}

      {view.connected ? (
        <button onClick={disconnect} className="text-xs text-slate-500 hover:text-rose-400">
          Disconnect
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-slate-500">
            Register an OAuth app and set its callback URL to:{' '}
            <span className="break-all font-mono text-slate-400">{callbackUrl}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setSaved(false);
              }}
              placeholder="Client ID"
              className={`w-44 ${field}`}
            />
            <input
              value={clientSecret}
              onChange={(e) => {
                setClientSecret(e.target.value);
                setSaved(false);
              }}
              placeholder="Client Secret"
              type="password"
              className={`min-w-[160px] flex-1 ${field}`}
            />
            <button
              onClick={saveConfig}
              disabled={busy || !clientId.trim() || !clientSecret.trim()}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save app'}
            </button>
            {(saved || view.clientConfigured) && !clientId && !clientSecret && (
              <span className="text-xs text-emerald-400">Saved — now click Connect</span>
            )}
          </div>
          <button
            onClick={connect}
            disabled={!view.clientConfigured}
            title={view.clientConfigured ? '' : 'Save the OAuth app credentials first'}
            className="self-start rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Connect {label}
          </button>
        </div>
      )}
    </div>
  );
}
