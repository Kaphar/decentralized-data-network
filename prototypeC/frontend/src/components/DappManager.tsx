import { createSignal, createEffect, Show, For } from 'solid-js';
import { listDapps, installDapp, setDappsDir, discoverDapps, getApiBase, fetchIdentity } from '../api';
import type { DappListResponse, DappInfo } from '../api';

export const DappManager = () => {
  const [localDapps, setLocalDapps] = createSignal<DappListResponse | null>(null);
  const [networkDapps, setNetworkDapps] = createSignal<DappInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [installName, setInstallName] = createSignal('');
  const [installPath, setInstallPath] = createSignal('');
  const [newDir, setNewDir] = createSignal('');
  const [isUnlocked, setIsUnlocked] = createSignal(false);

  const nodeUrl = getApiBase() || window.location.origin;

  const tauriAvailable = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

  async function openInNewTauriWindow(url: string) {
    if (tauriAvailable) {
      try {
        const tauriWindow = await (window as any).__TAURI__.window;
        const newWindow = tauriWindow.createWindow('dapp-window', {
          url,
          width: 1200,
          height: 800,
          title: 'dApp',
          webview: { autofocus: true },
        });
        await newWindow.show();
        await newWindow.setFocus();
      } catch (e) {
        console.error('Failed to open Tauri window, falling back to browser:', e);
        window.open(url, '_blank');
      }
    } else {
      window.open(url, '_blank');
    }
  }

  async function browseForFolder() {
    if (!tauriAvailable) {
      setError('Native file dialog not available in web mode. Enter a path manually.');
      return;
    }
    try {
      const selected = await (window as any).__TAURI__.dialog.open({
        multiple: false,
        directory: true,
        title: 'Select dApp dist folder',
      });
      if (selected && typeof selected === 'string') {
        setInstallPath(selected);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadLocalDapps() {
    try {
      const data = await listDapps();
      setLocalDapps(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadNetworkDapps() {
    try {
      const data = await discoverDapps();
      setNetworkDapps(data.dapps);
    } catch (e) {
      console.warn('Failed to discover dApps:', e);
    }
  }

  async function checkUnlock() {
    try {
      const info = await fetchIdentity();
      setIsUnlocked(!info.locked);
    } catch {
      setIsUnlocked(false);
    }
  }

  async function handleInstall() {
    const name = installName().trim();
    const source = installPath().trim();
    if (!name) {
      setError('dApp name is required');
      return;
    }
    if (!source) {
      setError('Source path is required');
      return;
    }
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      const result = await installDapp({ name, source_path: source });
      setSuccess(`dApp "${result.name}" installed. Open at ${result.url}`);
      await loadLocalDapps();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleSetDir() {
    const dir = newDir().trim();
    if (!dir) {
      setError('Directory path is required');
      return;
    }
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      const result = await setDappsDir({ path: dir });
      setSuccess(`dApp directory set to ${result.dir}`);
      await loadLocalDapps();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function openLocalDapp(name: string, mode: 'browser' | 'window') {
    const url = `${nodeUrl}/dapp/${name}`;
    if (mode === 'window') {
      openInNewTauriWindow(url);
    } else {
      window.open(url, '_blank');
    }
  }

  function openNetworkDapp(dapp: DappInfo, mode: 'browser' | 'window') {
    const url = dapp.url.startsWith('http') ? dapp.url : `${nodeUrl}${dapp.url}`;
    if (mode === 'window') {
      openInNewTauriWindow(url);
    } else {
      window.open(url, '_blank');
    }
  }

  createEffect(() => {
    loadLocalDapps();
    loadNetworkDapps();
    checkUnlock();
    const iv = setInterval(() => {
      loadLocalDapps();
      loadNetworkDapps();
      checkUnlock();
    }, 5000);
    return () => clearInterval(iv);
  });

  return (
    <div class="dapp-manager">
      <h3>DApp Manager</h3>
      <p class="hint">
        The node serves dApps from its dApp directory. You can install a pre-built
        dApp (a <code>dist/</code> folder) at runtime — no node restart needed.
        Network-registered dApps are discovered via record gossip.
      </p>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>

      <Show when={success()}>
        <div class="success-banner">
          <p>{success()}</p>
        </div>
      </Show>

      <div class="form-group">
        <label>Set dApp directory (runtime)</label>
        <Show when={!isUnlocked()}>
          <div class="warning-banner">
            Unlock your identity first to change the dApp directory.
          </div>
        </Show>

        <div class="input-row">
          <input
            type="text"
            placeholder="Absolute path to dApps directory (e.g. /home/user/my-dapps)"
            value={newDir()}
            onInput={(e) => setNewDir(e.currentTarget.value)}
          />
        </div>

        <button
          class="btn btn-primary"
          onClick={handleSetDir}
          disabled={loading() || !isUnlocked()}
        >
          {loading() ? 'Setting…' : 'Set Directory'}
        </button>
      </div>

      <div class="form-group">
        <label>Install a dApp from a dist folder</label>
        <Show when={!isUnlocked()}>
          <div class="warning-banner">
            Unlock your identity first to install dApps (POST /api/identity/unlock).
          </div>
        </Show>

        <div class="input-row">
          <input
            type="text"
            placeholder="dApp name (e.g. myguestbook)"
            value={installName()}
            onInput={(e) => setInstallName(e.currentTarget.value)}
          />
        </div>

        <div class="input-row">
          <input
            type="text"
            placeholder="Absolute path to the dApp dist folder"
            value={installPath()}
            onInput={(e) => setInstallPath(e.currentTarget.value)}
          />
          <Show when={tauriAvailable}>
            <button class="btn" onClick={browseForFolder}>
              Browse…
            </button>
          </Show>
        </div>

        <button
          class="btn btn-primary"
          onClick={handleInstall}
          disabled={loading() || !isUnlocked()}
        >
          {loading() ? 'Installing…' : 'Install dApp'}
        </button>
      </div>

      <div class="form-group">
        <Show when={localDapps()} fallback={<div class="loading">Loading…</div>}>
          {(d) => {
            const list = d().dapps;
            return (
              <>
                <label>Local dApp directory: <code>{d().dir || '(not loaded)'}</code></label>
                <label>Installed dApps ({list.length})</label>
                <Show when={list.length > 0} fallback={<p class="hint">No dApps installed yet.</p>}>
                  <ul class="peer-list">
                    <For each={list}>
                      {(name) => (
                        <li>
                          <span>dApp/{name}</span>
                          <button class="btn" onClick={() => openLocalDapp(name, 'browser')}>
                            Open (browser)
                          </button>
                          <button class="btn" onClick={() => openLocalDapp(name, 'window')}>
                            Open (window)
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </>
            );
          }}
        </Show>
      </div>

      <div class="form-group">
        <label>Network-discovered dApps ({networkDapps().length})</label>
        <Show when={networkDapps().length > 0} fallback={<p class="hint">No dApps discovered yet. Register one with a dApp record to make it appear here.</p>}>
          <ul class="peer-list">
            <For each={networkDapps()}>
              {(dapp) => (
                <li>
                  <div>
                    <strong>{dapp.name}</strong> v{dapp.version} — {dapp.description}
                  </div>
                  <div class="hint">by {dapp.author}</div>
                  <div>
                    <button class="btn" onClick={() => openNetworkDapp(dapp, 'browser')}>
                      Open (browser)
                    </button>
                    <button class="btn" onClick={() => openNetworkDapp(dapp, 'window')}>
                      Open (window)
                    </button>
                    <Show when={dapp.is_encrypted}>
                      <span class="text-warn">(encrypted)</span>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <p class="hint">
        Built-in dApps (chaindemo, notes, guestbook) are served at
        <code>/dapp/&lt;name&gt;</code>. Use the install form above to add
        additional dApps from any dist folder on disk.
      </p>
    </div>
  );
};
