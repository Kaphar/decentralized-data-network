import { Component, createMemo } from 'solid-js';
import { For } from 'solid-js';
import type { BaseRecord, MediaRef } from '../types';

export interface PostListProps {
  records: BaseRecord[];
}

export const PostList: Component<PostListProps> = (props) => {
  const sortedPosts = createMemo(() =>
    props.records
      .filter((r) => r.type === 'post')
      .sort((a, b) => b.ts - a.ts)
  );

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

  return (
    <div class="post-list">
      <For
        each={sortedPosts()}
        fallback={<div class="loading">No posts yet. Be the first to post!</div>}
      >
        {(record) => (
          <article class="post-card">
            <div class="author">{truncateAuthor(record.author)}</div>
            <div class="timestamp">{formatTime(record.ts)}</div>
            <div class="content">{getPostPayload(record).text}</div>
            <For each={getPostPayload(record).media}>
              {(m) =>
                m.mime.startsWith('image/') ? (
                  <img src={`/api/blob/${m.cid}`} alt="media" class="media-preview" />
                ) : (
                  <div class="media-preview">[{m.mime}] {m.size} bytes</div>
                )
              }
            </For>
            <For each={getCommentsFor(record.id)}>
              {(comment) => {
                const p = comment.payload as Record<string, unknown>;
                return (
                  <div class="comment-card">
                    <div class="comment-author">{truncateAuthor(comment.author)}</div>
                    <div class="comment-content">{p.text as string}</div>
                  </div>
                );
              }}
            </For>
          </article>
        )}
      </For>
    </div>
  );
};
