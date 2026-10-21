import { Component, createSignal, Show } from 'solid-js';
import {
  backupIdentity,
  downloadJson,
  unlockIdentity,
  importIdentity,
  deleteIdentity,
} from '../api';
import type { IdentityFile } from '../types';

export interface IdentityManagerProps {
  currentPubKey: string;
  locked: boolean;
  onUnlock: (password: string) => Promise<void>;
  onIdentityDeleted: () => void;
}

export const IdentityManager: Component<IdentityManagerProps> = (props) => {
  const [tab, setTab] = createSignal<'export' | 'import' | 'remove'>('export');
  const [password, setPassword] = createSignal('');
  const [importFile, setImportFile] = createSignal<IdentityFile | null>(null);
  const [importPassword, setImportPassword] = createSignal('');
  const [status, setStatus] = createSignal<{ msg: string; ok: boolean } | null>(null);
  const [working, setWorking] = createSignal(false);

  const truncate = (s: string) => {
    if (!s) return '(no identity)';
    return s.length <= 32 ? s : `${s.slice(0, 16)}…${s.slice(-16)}`;
  };

  const handleExport = async () => {
    if (props.locked) {
      setStatus({ msg: 'Identity is locked. Unlock first.', ok: false });
      return;
    }
    if (password().length < 8) {
      setStatus({ msg: 'Password must be at least 8 characters', ok: false });
      return;
    }
    setWorking(true);
    setStatus(null);
    try {
      const file = await backupIdentity(password());
      const json = JSON.stringify(file, null, 2);
      downloadJson('ddn_backup.json', json);
      setStatus({ msg: 'Backup file generated. Download started.', ok: true });
    } catch (e) {
      setStatus({ msg: String(e), ok: false });
    } finally {
      setWorking(false);
    }
  };

  const handleImportFile = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed: IdentityFile = JSON.parse(reader.result as string);
        setImportFile(parsed);
        setStatus(null);
      } catch {
        setStatus({ msg: 'Invalid JSON file', ok: false });
      }
    };
    reader.readAsText(file);
    input.value = '';
  };

  const handleImport = async () => {
    const file = importFile();
    if (!file) {
      setStatus({ msg: 'Please select a backup file first', ok: false });
      return;
    }
    if (!importPassword()) {
      setStatus({ msg: 'Password is required', ok: false });
      return;
    }
    setWorking(true);
    setStatus(null);
    try {
      await importIdentity(file, importPassword());
      setStatus({
        msg: `Identity imported (${truncate(file.pubkey)}). Restart the node for changes to take effect.`,
        ok: true,
      });
      setImportFile(null);
      setImportPassword('');
    } catch (e) {
      setStatus({ msg: String(e), ok: false });
    } finally {
      setWorking(false);
    }
  };

  const handleRemove = async () => {
    if (!confirm('Delete your identity? A new one will be generated on next restart.')) return;
    setWorking(true);
    setStatus(null);
    try {
      await deleteIdentity();
      setStatus({ msg: 'Identity file deleted. Restart the node to generate a new identity.', ok: true });
      props.onIdentityDeleted();
    } catch (e) {
      setStatus({ msg: String(e), ok: false });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div class="identity-manager">
      <h3>Identity Management</h3>

      <div class="info-row">
        <span class="label">Current Identity:</span>
        <span class="monospace" title={props.currentPubKey}>
          {truncate(props.currentPubKey)}
        </span>
      </div>

      <Show when={props.locked}>
        <div class="error-banner" style={{ "margin-bottom": "0.5rem" }}>
          Identity is LOCKED. Enter your password to unlock signing and networking.
        </div>
        <form
          class="form-group"
          onSubmit={(e) => {
            e.preventDefault();
            if (password()) {
              props.onUnlock(password());
              setPassword('');
            }
          }}
        >
          <input
            type="password"
            placeholder="Password to unlock"
            value={password()}
            oninput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
          <button type="submit" class="btn btn-primary" style={{ "margin-top": "0.5rem" }}>
            Unlock
          </button>
        </form>
        <Show when={status() && !status()!.ok}>
          <div class="error-banner">{status()!.msg}</div>
        </Show>
      </Show>

      <Show when={!props.locked}>
        <div class="tabs" style={{ "margin-bottom": "0.5rem" }}>
          <a
            href="#"
            class={tab() === 'export' ? 'active' : ''}
            onclick={() => setTab('export')}
          >
            Export / Backup
          </a>
          <a
            href="#"
            class={tab() === 'import' ? 'active' : ''}
            onclick={() => setTab('import')}
          >
            Import
          </a>
          <a
            href="#"
            class={tab() === 'remove' ? 'active' : ''}
            onclick={() => setTab('remove')}
          >
            Remove
          </a>
        </div>

        <Show when={status()}>
          <div class={status()!.ok ? 'success-banner' : 'error-banner'}>
            {status()!.msg}
          </div>
        </Show>

        <Show when={tab() === 'export'}>
          <form
            class="form-group"
            onSubmit={(e) => {
              e.preventDefault();
              handleExport();
            }}
          >
            <input
              type="password"
              placeholder="Encryption password (min 8 chars)"
              value={password()}
              oninput={(e) => setPassword((e.target as HTMLInputElement).value)}
              required
              minlength={8}
            />
            <button
              type="submit"
              class="btn btn-primary"
              disabled={working() || password().length < 8}
            >
              {working() ? 'Exporting...' : 'Generate Encrypted Backup'}
            </button>
          </form>
        </Show>

        <Show when={tab() === 'import'}>
          <div class="form-group">
            <input
              type="file"
              accept="application/json"
              onchange={handleImportFile}
            />
          </div>
          <Show when={importFile()}>
            <div class="info-row">
              <span class="label">Imported pubkey:</span>
              <span class="monospace">{truncate(importFile()!.pubkey)}</span>
            </div>
            <form
              class="form-group"
              onSubmit={(e) => {
                e.preventDefault();
                handleImport();
              }}
            >
              <input
                type="password"
                placeholder="Password for backup file"
                value={importPassword()}
                oninput={(e) => setImportPassword((e.target as HTMLInputElement).value)}
                required
              />
              <button
                type="submit"
                class="btn btn-primary"
                disabled={working() || !importPassword()}
              >
                {working() ? 'Importing...' : 'Import Identity'}
              </button>
            </form>
          </Show>
          <Show when={!importFile()}>
            <p class="hint">
              Select a ddn_backup.json file to import. The node will use this identity
              after restart. The current identity will be replaced.
            </p>
          </Show>
        </Show>

        <Show when={tab() === 'remove'}>
          <p class="hint">
            Deleting your identity removes the local key file. On next startup,
            a fresh identity will be generated. Your old data will not be
            accessible with the new identity.
          </p>
          <button
            class="btn btn-secondary"
            style={{ "background": "#3a1a1a", "color": "#ff6b6b" }}
            onclick={handleRemove}
            disabled={working()}
          >
            {working() ? 'Removing...' : 'Remove Identity'}
          </button>
        </Show>
      </Show>
    </div>
  );
};
