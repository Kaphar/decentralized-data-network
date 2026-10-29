import { Component, createSignal, createEffect, For, Show } from 'solid-js';
import { reportContent, fetchModerationList } from '../api';
import type { BaseRecord } from '../types';

export interface ModerationProps {
  records: BaseRecord[];
}

interface ModerationStatus {
  blocked_cids: string[];
  hidden_cids: string[];
  mod_pubkeys: string[];
}

export const Moderation: Component<ModerationProps> = (props) => {
  const [status, setStatus] = createSignal<ModerationStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [reportError, setReportError] = createSignal<string | null>(null);
  const [reportSuccess, setReportSuccess] = createSignal<string | null>(null);
  const [reportCid, setReportCid] = createSignal('');
  const [reportReason, setReportReason] = createSignal('');

  const loadStatus = async () => {
    try {
      const data = await fetchModerationList();
      setStatus(data);
      setReportError(null);
    } catch (e) {
      setReportError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleReport = async () => {
    if (!reportCid().trim()) return;
    setReportSuccess(null);
    setReportError(null);
    try {
      const result = await reportContent(reportCid(), reportReason() || 'spam');
      setReportSuccess(`Report published (record ${result.id.slice(0, 16)}…)`);
      setReportCid('');
      setReportReason('');
      await loadStatus();
    } catch (e) {
      setReportError(String(e));
    }
  };

  createEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  });

  const isBlocked = (cid: string) => {
    return status()?.blocked_cids.includes(cid) ?? false;
  };

  const postsUnderModeration = () => props.records.filter((r) => r.type === 'post');

  return (
    <div class="moderation-view">
      <h3>Moderation</h3>

      <div class="form-group">
        <label>Report Content CID:</label>
        <input
          type="text"
          value={reportCid()}
          oninput={(e) => setReportCid((e.target as HTMLInputElement).value)}
          placeholder="Record CID to flag"
        />
        <select
          value={reportReason()}
          onchange={(e) => setReportReason((e.target as HTMLSelectElement).value)}
        >
          <option value="spam">Spam</option>
          <option value="explicit_content">Explicit Content</option>
          <option value="harassment">Harassment</option>
          <option value="copyright">Copyright Violation</option>
          <option value="impersonation">Impersonation</option>
        </select>
        <button class="btn btn-primary" onclick={handleReport} disabled={!reportCid().trim()}>
          Submit Report
        </button>
      </div>

      <Show when={reportSuccess()}>
        <div class="success-banner" style={{ "font-size": "0.85rem" }}>
          {reportSuccess()}
        </div>
      </Show>
      <Show when={reportError()}>
        <div class="error-banner">{reportError()}</div>
      </Show>

      <hr style={{ "border-color": "#222", "margin": "1rem 0" }} />

      <Show when={loading()}>
        <div class="loading">Loading moderation status…</div>
      </Show>

      <Show when={!loading() && status()}>
        <div class="info-row">
          <span class="label">Blocked CIDs (nuke):</span>
          <span>{status()!.blocked_cids.length}</span>
        </div>
        <Show when={status()!.blocked_cids.length > 0}>
          <ul class="peer-sublist">
            <For each={status()!.blocked_cids}>
              {(cid) => (
                <li class="monospace" title={cid}>
                  {cid.slice(0, 16)}…{cid.slice(-16)}
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="info-row">
          <span class="label">Hidden CIDs (hide):</span>
          <span>{status()!.hidden_cids?.length ?? 0}</span>
        </div>
        <Show when={status()!.hidden_cids && status()!.hidden_cids.length > 0}>
          <ul class="peer-sublist">
            <For each={status()!.hidden_cids}>
              {(cid) => (
                <li class="monospace" title={cid}>
                  {cid.slice(0, 16)}…{cid.slice(-16)}
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div class="info-row">
          <span class="label">Trusted Moderators:</span>
          <span>{status()!.mod_pubkeys.length}</span>
        </div>
        <Show when={status()!.mod_pubkeys.length > 0}>
          <ul class="peer-sublist">
            <For each={status()!.mod_pubkeys}>
              {(pk) => (
                <li class="monospace" title={pk}>
                  {pk.slice(0, 16)}…{pk.slice(-16)}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={postsUnderModeration().length > 0}>
        <h4 style={{ "color": "#aaa", "margin-top": "1rem" }}>Posts Under Moderation</h4>
        <For each={postsUnderModeration()}>
          {(record) => (
            <div
              class="post-card"
              style={{
                "border-color": isBlocked(record.id) ? "#ff6b6b" : "#2a2a3a",
                "opacity": isBlocked(record.id) ? 0.6 : 1,
              }}
            >
              <div class="author">{(record.payload as Record<string, unknown>).text as string}</div>
              <div class="timestamp monospace" title={record.id}>
                CID: {record.id.slice(0, 16)}…{record.id.slice(-16)}
              </div>
              <Show when={isBlocked(record.id)}>
                <span class="badge badge-red" style={{ "font-size": "0.7rem" }}>BLOCKED (nuke)</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};
