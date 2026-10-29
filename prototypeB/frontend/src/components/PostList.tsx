import { Component, createMemo, Show, For } from 'solid-js';
import { reportContent } from '../api';
import type { BaseRecord, MediaRef } from '../types';
import type { MediaOfferInfo, WebRTCReceiver } from '../App';
import { ReactionsBar } from './ReactionsBar';

function OfferReceiver({ m, offer, receiver, onReceiveOffer }: {
  m: MediaRef;
  offer: MediaOfferInfo;
  receiver: WebRTCReceiver | undefined;
  onReceiveOffer: ((offer: MediaOfferInfo) => void) | undefined;
}) {
  return (
    <div class="media-preview">
      <Show when={receiver && receiver.state === 'complete' && receiver.blobUrl} fallback={
        <Show when={receiver && receiver.state === 'transferring'} fallback={
          <Show when={receiver && (receiver.state === 'connecting' || receiver.state === 'waiting_for_answer')} fallback={
            <button
              class="btn btn-secondary btn-small"
              onClick={() => {
                if (offer && onReceiveOffer) onReceiveOffer(offer);
              }}
              type="button"
            >
              Receive via WebRTC ({Math.round(m.size / (1024 * 1024))} MB)
            </button>
          }>
            <span class="badge badge-blue">{receiver!.state}</span>
          </Show>
        }>
          <div>
            <span class="badge badge-blue">Transferring {Math.round(receiver!.progress)}%</span>
            <div class="progress-bar" style={{ "margin-top": "0.25rem" }}>
              <div class="progress-fill" style={{ "width": `${receiver!.progress}%` }} />
            </div>
          </div>
        </Show>
      }>
        <div>
          <span class="badge badge-green">Received!</span>
          <Show when={m.mime.startsWith('video/')}>
            <video
              src={receiver!.blobUrl!}
              controls
              class="media-preview"
              style={{ "max-width": "100%", "border-radius": "4px", "margin-top": "0.5rem" }}
            />
          </Show>
          <Show when={m.mime.startsWith('audio/')}>
            <audio
              src={receiver!.blobUrl!}
              controls
              style={{ "width": "100%", "margin-top": "0.5rem" }}
            />
          </Show>
          <a
            href={receiver!.blobUrl!}
            download={offer.file_name ?? 'file'}
            class="btn btn-tiny"
            style={{ "margin-top": "0.5rem" }}
          >
            Download
          </a>
        </div>
      </Show>
    </div>
  );
}

function MediaRenderer({ m, offersMap, receivers, onReceiveOffer }: {
  m: MediaRef;
  offersMap: Map<string, MediaOfferInfo>;
  receivers?: Map<string, WebRTCReceiver>;
  onReceiveOffer?: (offer: MediaOfferInfo) => void;
}) {
  if (m.isOffer) {
    const offer = offersMap.get(m.cid);
    if (!offer) return null;
    const receiver = receivers?.get(m.cid);
    return (
      <OfferReceiver
        m={m}
        offer={offer}
        receiver={receiver}
        onReceiveOffer={onReceiveOffer}
      />
    );
  }

  return (
    <>
      <Show when={m.mime.startsWith('image/')}>
        <img src={`/api/blob/${m.cid}`} alt="media" class="media-preview" />
      </Show>
      <Show when={m.mime.startsWith('video/')}>
        <video src={`/api/blob/${m.cid}`} controls class="media-preview" style={{ "max-width": "100%", "border-radius": "4px" }} />
      </Show>
      <Show when={m.mime.startsWith('audio/')}>
        <audio src={`/api/blob/${m.cid}`} controls style={{ "width": "100%", "margin-top": "0.5rem" }} />
      </Show>
      <Show when={
        !m.mime.startsWith('image/') &&
        !m.mime.startsWith('video/') &&
        !m.mime.startsWith('audio/')
      }>
        <div class="media-preview">[{m.mime}] {m.size} bytes</div>
      </Show>
    </>
  );
}

export interface PostListProps {
  records: BaseRecord[];
  onReport?: (cid: string, reason: string) => void;
  hiddenCids?: string[];
  currentPubKey?: string;
  onReaction?: (targetCid: string, emoji: string) => void;
  receivers?: Map<string, WebRTCReceiver>;
  onReceiveOffer?: (offer: MediaOfferInfo) => void;
}

export const PostList: Component<PostListProps> = (props) => {
  const sortedPosts = createMemo(() =>
    props.records
      .filter((r) => r.type === 'post')
      .sort((a, b) => b.ts - a.ts)
  );

  const offersMap = createMemo(() => {
    const map = new Map<string, MediaOfferInfo>();
    for (const r of props.records) {
      if (r.type !== 'media_offer') continue;
      const p = r.payload as Record<string, unknown>;
      map.set(r.id, {
        id: r.id,
        author: r.author,
        file_name: (p.file_name as string) ?? 'unknown',
        size_bytes: (p.size_bytes as number) ?? 0,
        ephemeral_pubkey: (p.ephemeral_pubkey as string) ?? '',
      });
    }
    return map;
  });

  const formatTime = (ts: number) => new Date(ts).toLocaleString();
  const truncateAuthor = (author: string) =>
    author.length <= 16 ? author : `${author.slice(0, 8)}...${author.slice(-8)}`;

  const getPostPayload = (record: BaseRecord) => {
    if (typeof record.payload === 'object' && record.payload !== null) {
      const p = record.payload as Record<string, unknown>;
      return {
        text: (p.text as string) ?? '',
        media: (p.media as MediaRef[]) ?? [],
      };
    }
    return { text: '', media: [] };
  };

  const getCommentsFor = (postId: string) =>
    props.records
      .filter((r) => {
        if (typeof r.payload === 'object' && r.payload !== null) {
          const p = r.payload as Record<string, unknown>;
          return p.target_cid === postId;
        }
        return false;
      })
      .sort((a, b) => a.ts - b.ts);

  const handleReport = async (cid: string, reason: string) => {
    if (props.onReport) {
      props.onReport(cid, reason);
    } else {
      try {
        await reportContent(cid, reason);
      } catch (e) {
        console.error('Failed to report:', e);
      }
    }
  };

  const hiddenSet = new Set(props.hiddenCids ?? []);
  const myPubKey = () => props.currentPubKey ?? '';

  return (
    <div class="post-list">
      <For
        each={sortedPosts()}
        fallback={<div class="loading">No posts yet. Be the first to post!</div>}
      >
        {(record) => {
          const hidden = hiddenSet.has(record.id);
          return (
            <article
              class="post-card"
              style={{
                "opacity": hidden ? 0.3 : 1,
                "border-color": hidden ? "#ff6b6b" : undefined,
              }}
            >
              <div class="author">{truncateAuthor(record.author)}</div>
              <div class="timestamp">
                {formatTime(record.ts)}
                <button
                  class="btn-tiny"
                  style={{ "margin-left": "0.5rem", "float": "right" }}
                  onclick={(e) => {
                    e.stopPropagation();
                    handleReport(record.id, 'spam');
                  }}
                  title={`Report post ${record.id.slice(0, 16)}…`}
                >
                  Report
                </button>
              </div>
              <Show when={hidden}>
                <div class="warning-banner" style={{ "font-size": "0.8rem", "margin-bottom": "0.5rem" }}>
                  Content hidden by moderation
                </div>
              </Show>
              <div class="content">{getPostPayload(record).text}</div>
              <For each={getPostPayload(record).media}>
                {(m) => (
                  <MediaRenderer
                    m={m}
                    offersMap={offersMap()}
                    receivers={props.receivers}
                    onReceiveOffer={props.onReceiveOffer}
                  />
                )}
              </For>
              <ReactionsBar
                records={props.records}
                targetCid={record.id}
                currentPubKey={myPubKey()}
                onReact={props.onReaction ?? (() => {})}
              />
              <For each={getCommentsFor(record.id)}>
                {(comment) => {
                  const p = comment.payload as Record<string, unknown>;
                  const commentHidden = hiddenSet.has(comment.id);
                  return (
                    <div
                      class="comment-card"
                      style={{
                        "opacity": commentHidden ? 0.3 : 1,
                        "border-color": commentHidden ? "#ff6b6b" : undefined,
                      }}
                    >
                      <div class="comment-author">{truncateAuthor(comment.author)}</div>
                      <Show when={commentHidden}>
                        <div class="warning-banner" style={{ "font-size": "0.7rem" }}>Hidden by moderation</div>
                      </Show>
                      <div class="comment-content">{p.text as string}</div>
                      <ReactionsBar
                      records={props.records}
                      targetCid={comment.id}
                      currentPubKey={myPubKey()}
                      onReact={props.onReaction ?? (() => {})}
                    />
                    </div>
                  );
                }}
              </For>
            </article>
          );
        }}
      </For>
    </div>
  );
};
