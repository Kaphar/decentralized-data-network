import { Component, createSignal, createEffect, Show, For } from 'solid-js';
import {
  fetchCommunities,
  createCommunity,
  promoteCommunityModerator,
  fetchModerationList,
  createCommunityModAction,
} from '../api';
import type { BaseRecord, ModerationResponse, CommunityInfoResponse } from '../types';

export interface CommunitiesProps {
  records: BaseRecord[];
  currentPubKey: string;
}

const truncate = (s: string) => (s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-8)}`);

export const Communities: Component<CommunitiesProps> = (props) => {
  const [communities, setCommunities] = createSignal<BaseRecord[]>([]);
  const [moderation, setModeration] = createSignal<ModerationResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const [newName, setNewName] = createSignal('');
  const [newDescription, setNewDescription] = createSignal('');
  const [creating, setCreating] = createSignal(false);

  const [promoCommunity, setPromoCommunity] = createSignal('');
  const [promoTarget, setPromoTarget] = createSignal('');
  const [promoting, setPromoting] = createSignal(false);

  const [modActionCid, setModActionCid] = createSignal('');
  const [modActionCommunity, setModActionCommunity] = createSignal('');
  const [modActionChoice, setModActionChoice] = createSignal<'hide' | 'nuke'>('hide');
  const [modActionPubKey, setModActionPubKey] = createSignal('');
  const [applyingModAction, setApplyingModAction] = createSignal(false);

  const loadCommunities = async () => {
    try {
      const data = await fetchCommunities();
      setCommunities(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const loadModeration = async () => {
    try {
      const data = await fetchModerationList();
      setModeration(data);
    } catch (e) {
      console.error('Failed to fetch moderation:', e);
    }
  };

  const handleCreate = async () => {
    if (!newName().trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createCommunity(newName(), newDescription());
      setNewName('');
      setNewDescription('');
      await loadCommunities();
      await loadModeration();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const handlePromote = async () => {
    if (!promoTarget().trim() || !promoCommunity()) return;
    setPromoting(true);
    setError(null);
    try {
      await promoteCommunityModerator(promoCommunity(), promoTarget(), 'moderator');
      setPromoTarget('');
      await loadModeration();
    } catch (e) {
      setError(String(e));
    } finally {
      setPromoting(false);
    }
   };

  const handleModAction = async () => {
    if (!modActionCid().trim() || !modActionCommunity()) return;
    setApplyingModAction(true);
    setError(null);
    try {
      await createCommunityModAction(
        modActionCommunity(),
        modActionCid(),
        modActionChoice(),
        modActionPubKey(),
      );
      setModActionCid('');
      await loadModeration();
    } catch (e) {
      setError(String(e));
    } finally {
      setApplyingModAction(false);
    }
  };

  const getCommunityInfo = (cid: string): CommunityInfoResponse | null => {
    const mod = moderation();
    if (!mod) return null;
    return mod.communities[cid] ?? null;
  };

  const isFounderOrMod = (communityCid: string): boolean => {
    const info = getCommunityInfo(communityCid);
    if (!info) return false;
    return info.founder === props.currentPubKey || info.moderators.includes(props.currentPubKey);
  };

  createEffect(() => {
    setLoading(true);
    Promise.all([loadCommunities(), loadModeration()]).finally(() => setLoading(false));
    const interval = setInterval(() => {
      loadCommunities();
      loadModeration();
    }, 5000);
    return () => clearInterval(interval);
  });

  return (
    <div class="communities-view">
      <h3>Communities</h3>

      <Show when={error()}>
        <div class="error-banner">{error()}</div>
      </Show>

      <div class="form-group">
        <h4 style={{ "color": "#ccc", "margin-bottom": "0.5rem" }}>Create Community</h4>
        <input
          type="text"
          placeholder="Community name"
          value={newName()}
          oninput={(e) => setNewName((e.target as HTMLInputElement).value)}
        />
        <textarea
          placeholder="Description (optional)"
          value={newDescription()}
          oninput={(e) => setNewDescription((e.target as HTMLTextAreaElement).value)}
          rows={3}
        />
        <button
          class="btn btn-primary"
          onclick={handleCreate}
          disabled={creating() || !newName().trim()}
        >
          {creating() ? 'Creating...' : 'Create Community'}
        </button>
      </div>

      <hr style={{ "border-color": "#222", "margin": "1rem 0" }} />

      <Show when={loading()} fallback={
        <Show when={communities().length > 0} fallback={
          <div class="loading">No communities found. Be the first to create one!</div>
        }>
          <For each={communities()}>
            {(record) => {
              const info = getCommunityInfo(record.id) ?? {
                cid: record.id,
                name: '',
                founder: '',
                moderators: [],
                blocked_cids: [],
                hidden_cids: [],
              };
              const isMod = isFounderOrMod(record.id);
              return (
                <div class="post-card" style={{ "border-color": "#2a2a3a" }}>
                  <div class="author" style={{ "font-size": "1rem", "font-weight": "bold" }}>
                    {info.name || '(unnamed)'}
                  </div>
                  <div class="timestamp monospace" title={record.id}>
                    CID: {truncate(record.id)}
                  </div>
                  <div class="info-row">
                    <span class="label">Founder:</span>
                    <span class="monospace" title={record.author}>
                      {truncate(record.author)}
                    </span>
                    <Show when={isMod}>
                      <span class="badge badge-green" style={{ "margin-left": "0.5rem", "font-size": "0.7rem" }}>
                        You are founder/moderator
                      </span>
                    </Show>
                  </div>

                  <Show when={info.moderators.length > 0}>
                    <div class="info-row">
                      <span class="label">Moderators:</span>
                      <For each={info.moderators}>
                        {(mod) => (
                          <span class="monospace" title={mod} style={{ "margin-right": "0.5rem" }}>
                            {truncate(mod)}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={isMod}>
                    <div class="form-group" style={{ "margin-top": "0.5rem" }}>
                      <input
                        type="text"
                        placeholder="Target pubkey to promote"
                        value={promoCommunity() === record.id ? promoTarget() : ''}
                        oninput={(e) => {
                          setPromoCommunity(record.id);
                          setPromoTarget((e.target as HTMLInputElement).value);
                        }}
                        style={{ "width": "calc(100% - 110px)" }}
                      />
                      <button
                        class="btn btn-secondary btn-small"
                        onclick={handlePromote}
                        disabled={promoting() || !promoTarget().trim() || promoCommunity() !== record.id}
                      >
                        {promoting() && promoCommunity() === record.id ? '...' : 'Promote'}
                      </button>
                    </div>
                  </Show>

                  <Show when={isMod}>
                    <div class="form-group" style={{ "margin-top": "0.5rem" }}>
                      <h5 style={{ "color": "#aaa", "font-size": "0.8rem", "margin-bottom": "0.25rem" }}>Community Moderation</h5>
                      <input
                        type="text"
                        placeholder="Target CID to hide/nuke"
                        value={modActionCommunity() === record.id ? modActionCid() : ''}
                        oninput={(e) => {
                          setModActionCommunity(record.id);
                          setModActionCid((e.target as HTMLInputElement).value);
                        }}
                      />
                      <select
                        value={modActionCommunity() === record.id ? modActionChoice() : 'hide'}
                        onchange={(e) => setModActionChoice((e.target as HTMLSelectElement).value as 'hide' | 'nuke')}
                      >
                        <option value="hide">Hide (client-side blur)</option>
                        <option value="nuke">Nuke (community-scoped block)</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Your pubkey"
                        value={modActionCommunity() === record.id ? modActionPubKey() : ''}
                        oninput={(e) => setModActionPubKey((e.target as HTMLInputElement).value)}
                      />
                      <button
                        class="btn btn-secondary btn-small"
                        onclick={handleModAction}
                        disabled={
                          applyingModAction() ||
                          !modActionCid().trim() ||
                          modActionCommunity() !== record.id ||
                          !modActionPubKey().trim()
                        }
                      >
                        {applyingModAction() && modActionCommunity() === record.id ? 'Applying...' : 'Apply'}
                      </button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      }>
        <div class="loading">Loading communities…</div>
      </Show>
    </div>
  );
};
