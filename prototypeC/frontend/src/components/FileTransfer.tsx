import { Component, createMemo, For, Show } from 'solid-js';
import type { BaseRecord, WsWebrtcSignalEvent } from '../types';
import type { MediaOfferInfo, WebRTCReceiver } from '../App';

export interface FileTransferProps {
  records: BaseRecord[];
  currentPubKey: string;
  signalEvents?: WsWebrtcSignalEvent[];
  receivers: Map<string, WebRTCReceiver>;
  onReceiveOffer: (offer: MediaOfferInfo) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateAuthor(author: string): string {
  return author.length <= 16 ? author : `${author.slice(0, 8)}…${author.slice(-8)}`;
}

export const FileTransfer: Component<FileTransferProps> = (props) => {
  const offers = createMemo(() => {
    const result: MediaOfferInfo[] = [];
    for (const r of props.records) {
      if (r.type !== 'media_offer') continue;
      const p = r.payload as Record<string, unknown>;
      const target = p.target_user as string;
      if (target !== props.currentPubKey) continue;
      result.push({
        id: r.id,
        author: r.author,
        file_name: p.file_name as string,
        size_bytes: (p.size_bytes as number) || 0,
        ephemeral_pubkey: p.ephemeral_pubkey as string,
      });
    }
    return result;
  });

  return (
    <div class="file-transfer">
      <h3>Large File Transfers (WebRTC)</h3>
      <p class="hint">
        Files larger than 5 MB are shared via <code>media_offer</code> records and
        WebRTC Data Channels. No files are stored on the node.
      </p>

      <Show when={offers().length === 0}>
        <div class="loading">No pending file transfers. Be the first to send a large file!</div>
      </Show>

      <Show when={offers().length > 0}>
        <ul class="transfer-list">
          <For each={offers()}>
            {(offer) => {
              const getReceiver = createMemo(() => props.receivers.get(offer.id));
              const r = getReceiver();
              return (
                <li class="transfer-item">
                  <div class="transfer-info">
                    <div class="transfer-file">{offer.file_name}</div>
                    <div class="transfer-meta">
                      From: <span class="monospace">{truncateAuthor(offer.author)}</span>
                      · Size: {formatBytes(offer.size_bytes)}
                    </div>
                  </div>

                  <Show when={!r}>
                    <button
                      class="btn btn-secondary btn-small"
                      onclick={() => props.onReceiveOffer(offer)}
                    >
                      Receive
                    </button>
                  </Show>

                  <Show when={r && r.state === 'connecting'}>
                    <span class="badge badge-blue">Connecting...</span>
                  </Show>

                  <Show when={r && r.state === 'transferring'}>
                    <span class="badge badge-blue">Transferring</span>
                    <div class="progress-bar">
                      <div
                        class="progress-fill"
                        style={{ "width": `${r!.progress}%` }}
                      />
                    </div>
                  </Show>

                  <Show when={r && r.state === 'complete'}>
                    <Show when={r && r!.blobUrl}>
                      <a
                        href={r!.blobUrl!}
                        download={offer.file_name}
                        class="btn btn-tiny"
                        style={{ "margin-left": "0.5rem" }}
                      >
                        Download
                      </a>
                    </Show>
                    <span class="badge badge-green">Received!</span>
                  </Show>

                  <Show when={r && r.state === 'error'}>
                    <span class="badge badge-red">Error: {r!.error}</span>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
};
