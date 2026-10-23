import { Component, createSignal, createEffect, Show } from 'solid-js';
import type { IdentityInfo } from '../types';

export interface IdentityBadgeProps {
  identity: IdentityInfo | null;
  onAction: (action: IdentityAction) => void;
}

export type IdentityAction = 'export' | 'switch' | 'remove' | 'create' | 'unlock';

export const IdentityBadge: Component<IdentityBadgeProps> = (props) => {
  const [open, setOpen] = createSignal(false);

  const truncate = (s: string) => {
    if (!s) return '(no identity)';
    if (s.length <= 24) return s;
    return s.slice(0, 12) + '...' + s.slice(-12);
  };

  function toggle() {
    setOpen(!open());
  }

  function handleAction(action: IdentityAction) {
    setOpen(false);
    props.onAction(action);
  }

  let buttonRef: HTMLButtonElement | undefined;

  function handleClickOutside(e: MouseEvent) {
    if (open() && buttonRef && !buttonRef.contains(e.target as Node)) {
      setOpen(false);
    }
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  });

  const isLocked = () => props.identity ? props.identity.locked : false;

  return (
    <div class="identity-badge-dropdown">
      <button
        ref={buttonRef}
        class="identity-badge"
        title={props.identity ? props.identity.pubkey : 'No identity'}
        onClick={toggle}
      >
        <Show when={props.identity}>
          <span class="identity-badge__pubkey">{truncate(props.identity!.pubkey)}</span>
          <Show when={isLocked()}>
            <span class="identity-badge__lock" title="Locked">🔒</span>
          </Show>
        </Show>
        <Show when={!props.identity}>
          <span class="identity-badge__pubkey">(no identity)</span>
        </Show>
      </button>

      <Show when={open()}>
        <ul class="identity-dropdown-menu">
          <Show when={isLocked()}>
            <li>
              <button
                class="identity-dropdown-item"
                onClick={() => handleAction('unlock')}
                type="button"
              >
                🔓 Unlock Identity
              </button>
            </li>
          </Show>
          <Show when={!isLocked()}>
            <li>
              <button
                class="identity-dropdown-item"
                onClick={() => handleAction('export')}
                type="button"
              >
                ⬇ Export / Backup
              </button>
            </li>
            <li>
              <button
                class="identity-dropdown-item"
                onClick={() => handleAction('switch')}
                type="button"
              >
                🔄 Switch Identity
              </button>
            </li>
            <li>
              <button
                class="identity-dropdown-item"
                onClick={() => handleAction('create')}
                type="button"
              >
                ➕ Create New Identity
              </button>
            </li>
            <li>
              <button
                class="identity-dropdown-item identity-dropdown-item--destructive"
                onClick={() => handleAction('remove')}
                type="button"
              >
                🗑 Remove Identity
              </button>
            </li>
          </Show>
        </ul>
      </Show>
    </div>
  );
};
