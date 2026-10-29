import { Component, createSignal, Show } from 'solid-js';
import { backupIdentity, downloadJson } from '../api';
import type { IdentityFile } from '../types';

export const KeyBackup: Component = () => {
  const [password, setPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [status, setStatus] = createSignal<'idle' | 'backing-up' | 'ready' | 'error'>('idle');
  const [error, setError] = createSignal<string | null>(null);
  const [backupFile, setBackupFile] = createSignal<IdentityFile | null>(null);

  const handleBackup = async () => {
    if (password() !== confirmPassword()) {
      setError('Passwords do not match');
      return;
    }
    if (password().length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setStatus('backing-up');
    setError(null);
    try {
      const file = await backupIdentity(password());
      setBackupFile(file);
      setStatus('ready');
    } catch (e) {
      setError(String(e));
      setStatus('error');
    }
  };

  const handleDownload = () => {
    const file = backupFile();
    if (!file) return;
    const json = JSON.stringify(file, null, 2);
    downloadJson('ddn_backup.json', json);
  };

  return (
    <div class="key-backup">
      <h3>Key Backup</h3>
      <p class="hint">
        Download your encrypted backup file now. Without it, you cannot restore
        your identity if you lose this browser's local storage.
      </p>

      <Show when={status() === 'idle' || status() === 'error'}>
        <form
          class="form-group"
          onSubmit={(e) => {
            e.preventDefault();
            handleBackup();
          }}
        >
          <input
            type="password"
            placeholder="Backup password"
            value={password()}
            oninput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
            minlength={8}
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword()}
            oninput={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
            required
            minlength={8}
          />
          <button
            type="submit"
            class="btn btn-primary"
            disabled={status() === 'backing-up'}
          >
            {status() === 'backing-up' ? 'Backing up...' : 'Generate Backup'}
          </button>
        </form>
        <Show when={error()}>
          <div class="error-banner">{error()}</div>
        </Show>
      </Show>

      <Show when={status() === 'ready' && backupFile()}>
        <div class="success-banner">
          <p>Backup file generated. Download it now and store it safely.</p>
          <p>
            Pubkey:{' '}
            <span class="monospace">{backupFile()!.pubkey.slice(0, 16)}...</span>
          </p>
          <button class="btn btn-primary" onclick={handleDownload}>
            Download ddn_backup.json
          </button>
        </div>
      </Show>
    </div>
  );
};
