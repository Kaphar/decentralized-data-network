import { createSignal, createEffect, Show, For } from 'solid-js';
import { listDapps, installDapp, getApiBase, fetchIdentity } from '../api';
import type { DappInfo } from '../api';

export const DappManager = () => {
  const [dapps, setDapps] = createSignal<DappInfo | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);
  const [installName, setInstallName] = createSignal('');
  const [installPath, setInstallPath] = createSignal('');
  const [isUnlocked, setIsUnlocked] = createSignal(false);

  async function loadDapps() {
    try {
      setLoading(true);
      const data = await listDapps();
      setDapps(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
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
      await loadDapps();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    loadDapps();
    checkUnlock();
    const iv = setInterval(() => {
      loadDapps();
      checkUnlock();
    }, 5000);
    return () => clearInterval(iv);
  });

  const nodeUrl = getApiBase() || window.location.origin;

  return (
    <div class="dapp-manager">
      <h3>DApp Manager</h3>
      <p class="hint">
        The node serves dApps from its dApp directory. You can install a pre-built
        dApp (a <code>dist/</code> folder) at runtime — no node restart needed.
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
            placeholder="Absolute path to the dApp dist folder (e.g. /home/user/mydapp-dist)"
            value={installPath()}
            onInput={(e) => setInstallPath(e.currentTarget.value)}
          />
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
        <label>Current dApp directory</label>
        <p class="hint monospace">{dapps()?.dir || '(not loaded)'}</p>

        <label>Installed dApps</label>
        <Show when={dapps()} fallback={<div class="loading">Loading…</div>}>
          {(d) => {
            const list = d().dapps;
            return list.length > 0 ? (
              <ul class="peer-list">
                <For each={list}>
                  {(name) => (
                    <li>
                      <a
                        href={`${nodeUrl}/dapp/${name}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        dApp/{name}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            ) : (
              <p class="hint">No dApps installed yet.</p>
            );
          }}
        </Show>
      </div>

      <p class="hint">
        Built-in dApps already in the dist (chaindemo, notes, guestbook) are served
        at <code>/dapp/&lt;name&gt;</code>. Use the install form above to add
        additional dApps from any dist folder on disk.
      </p>
    </div>
  );
};
