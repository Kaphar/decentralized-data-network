import { Component, createMemo, Show, createSignal } from 'solid-js';
import { For } from 'solid-js';
import { reportContent } from '../api';
import type { BaseRecord, MediaRef } from '../types';
import type { MediaOfferInfo, WebRTCReceiver } from '../App';

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
  const [hiddenReactions, setHiddenReactions] = createSignal<Set<string>>(new Set());

  const myPubKey = () => props.currentPubKey ?? '';

  const REACTION_EMOJIS = ['👍', '❤️', '😄', '😮', '😢', '😡'];

  const reactionsFor = (targetCid: string) => {
    return props.records
      .filter((r) => r.type === 'reaction')
      .map((r) => {
        const p = r.payload as Record<string, unknown>;
        return {
          id: r.id,
          author: r.author,
          emoji: (p.emoji as string) ?? '',
          target_cid: (p.target_cid as string) ?? '',
        };
      })
      .filter((r) => r.target_cid === targetCid && r.emoji);
  };

  const handleReactionClick = (targetCid: string, emoji: string) => {
    if (!myPubKey() || !props.onReaction) return;
    props.onReaction(targetCid, emoji);
  };

  const toggleReaction = (reactionId: string) => {
    const current = new Set(hiddenReactions());
    if (current.has(reactionId)) {
      current.delete(reactionId);
    } else {
      current.add(reactionId);
    }
    setHiddenReactions(current);
  };

  const renderReactions = (targetCid: string) => {
    const reactions = reactionsFor(targetCid);
    const hidden = hiddenReactions();
    const visible = reactions.filter((r) => !hidden.has(r.id));

    return (
      <div class="reactions-bar">
        {REACTION_EMOJIS.map((emoji) => {
          const matching = visible.filter((r) => r.emoji === emoji);
          const hasReacted = matching.some((r) => r.author === myPubKey());
          const count = matching.length;
          return (
            <button
              class={`reaction-btn ${hasReacted ? 'reacted' : ''}`}
              onclick={() => {
                if (hasReacted) {
                  // Locally remove own reactions (cannot delete from network)
                  matching.filter((r) => r.author === myPubKey()).forEach((r) => toggleReaction(r.id));
                } else {
                  handleReactionClick(targetCid, emoji);
                }
              }}
              title={hasReacted ? 'Click to remove your reaction' : `React with ${emoji}`}
            >
              {emoji}
              {count > 0 && <span class="reaction-count">{count}</span>}
            </button>
          );
        })}
      </div>
    );
  };

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
                {(m) =>
                  m.isOffer ? (() => {
                    const offer = offersMap().get(m.cid);
                    const getReceiver = createMemo(() => props.receivers?.get(m.cid));
                    const r = getReceiver();
                    return (
                      <div class="media-preview">
                        {r && r.state === 'complete' && r.blobUrl ? (
                          <div>
                            <span class="badge badge-green">Received!</span>
                            {m.mime.startsWith('video/') ? (
                              <video
                                src={r.blobUrl}
                                controls
                                class="media-preview"
                                style={{ "max-width": "100%", "border-radius": "4px", "margin-top": "0.5rem" }}
                              />
                            ) : m.mime.startsWith('audio/') ? (
                              <audio
                                src={r.blobUrl}
                                controls
                                style={{ "width": "100%", "margin-top": "0.5rem" }}
                              />
                            ) : null}
                            <a
                              href={r.blobUrl}
                              download={offer?.file_name ?? 'file'}
                              class="btn btn-tiny"
                              style={{ "margin-top": "0.5rem" }}
                            >
                              Download
                            </a>
                          </div>
                        ) : r && r.state === 'transferring' ? (
                          <div>
                            <span class="badge badge-blue">Transferring {Math.round(r.progress)}%</span>
                            <div class="progress-bar" style={{ "margin-top": "0.25rem" }}>
                              <div class="progress-fill" style={{ "width": `${r.progress}%` }} />
                            </div>
                          </div>
                        ) : r && (r.state === 'connecting' || r.state === 'waiting_for_answer') ? (
                          <span class="badge badge-blue">{r.state}</span>
                        ) : (
                          <button
                            class="btn btn-secondary btn-small"
                            onclick={() => {
                              if (offer && props.onReceiveOffer) {
                                props.onReceiveOffer(offer);
                              }
                            }}
                          >
                            Receive via WebRTC ({Math.round(m.size / (1024 * 1024))} MB)
                          </button>
                        )}
                      </div>
                    );
                  })() : m.mime.startsWith('image/') ? (
                    <img src={`/api/blob/${m.cid}`} alt="media" class="media-preview" />
                  ) : m.mime.startsWith('video/') ? (
                    <video src={`/api/blob/${m.cid}`} controls class="media-preview" style={{ "max-width": "100%", "border-radius": "4px" }} />
                  ) : m.mime.startsWith('audio/') ? (
                    <audio src={`/api/blob/${m.cid}`} controls style={{ "width": "100%", "margin-top": "0.5rem" }} />
                  ) : (
                    <div class="media-preview">[{m.mime}] {m.size} bytes</div>
                  )
                }
              </For>
              {renderReactions(record.id)}
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
                      {renderReactions(comment.id)}
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
