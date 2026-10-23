import { Component, createSignal, Show } from 'solid-js';
import type { BaseRecord } from '../types';

export interface ReactionsBarProps {
  records: BaseRecord[];
  targetCid: string;
  currentPubKey: string;
  onReact: (targetCid: string, emoji: string) => void;
}

const REACTION_EMOJIS = ['👍', '❤️', '😄', '😮', '😢', '😡'];

export const ReactionsBar: Component<ReactionsBarProps> = (props) => {
  const [hiddenReactions, setHiddenReactions] = createSignal<Set<string>>(new Set());

  const reactionsFor = () => {
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
      .filter((r) => r.target_cid === props.targetCid && r.emoji);
  };

  const handleReactionClick = (emoji: string) => {
    if (!props.currentPubKey) return;
    const reactions = reactionsFor();
    const ownReactions = reactions.filter(
      (r) => r.author === props.currentPubKey && r.emoji === emoji,
    );

    if (ownReactions.length > 0) {
      const current = new Set(hiddenReactions());
      ownReactions.forEach((r) => current.add(r.id));
      setHiddenReactions(current);
    } else {
      props.onReact(props.targetCid, emoji);
    }
  };

  return (
    <div class="reactions-bar">
      {REACTION_EMOJIS.map((emoji) => {
        const reactions = reactionsFor();
        const hidden = hiddenReactions();
        const visible = reactions.filter((r) => !hidden.has(r.id));
        const matching = visible.filter((r) => r.emoji === emoji);
        const hasReacted = matching.some((r) => r.author === props.currentPubKey);
        const count = matching.length;

        return (
          <button
            class={`reaction-btn ${hasReacted ? 'reacted' : ''}`}
            onClick={() => handleReactionClick(emoji)}
            title={hasReacted ? 'Remove your reaction' : `React with ${emoji}`}
            type="button"
          >
            {emoji}
            <Show when={count > 0}>
              <span class="reaction-count">{count}</span>
            </Show>
          </button>
        );
      })}
    </div>
  );
};
