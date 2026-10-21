import { Component, createSignal, createEffect, Show, For, JSX } from 'solid-js';
import type { BaseRecord } from '../types';

export interface ChatProps {
  records: BaseRecord[];
  currentPubKey: string;
  onReaction?: (targetCid: string, emoji: string) => void;
}

export const Chat: Component<ChatProps> = (props) => {
  const [message, setMessage] = createSignal('');
  const [recipient, setRecipient] = createSignal('');
  const [messages, setMessages] = createSignal<BaseRecord[]>([]);
  const [sending, setSending] = createSignal(false);
  const [decryptionError, setDecryptionError] = createSignal<string | null>(null);

  const loadMessages = async () => {
    if (!recipient()) return;
    setDecryptionError(null);
    try {
      const resp = await fetch(
        `/api/dm?me=${props.currentPubKey}&other=${recipient()}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        setMessages(data.messages);
      }
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  };

  const sendMessage = async () => {
    if (!message().trim() || !recipient()) return;
    setSending(true);
    try {
      const sealed = await fetch('/api/dm/seal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: props.currentPubKey,
          to: recipient(),
          plaintext: message(),
        }),
      });
      if (!sealed.ok) {
        const err = await sealed.json();
        throw new Error(err.error || 'Failed to encrypt message');
      }
      const { ciphertext, nonce, ephemeral_pubkey } = await sealed.json();

      const payload = {
        to: recipient(),
        ciphertext,
        nonce,
        ephemeral_pubkey,
      };

      const resp = await fetch('/api/record/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          author: props.currentPubKey,
          prev: null,
          ts: Date.now(),
          payload,
        }),
      });
      if (resp.ok) {
        const record = await resp.json();
        await fetch('/api/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
        setMessage('');
        loadMessages();
      }
    } catch (e) {
      console.error('Failed to send message:', e);
    } finally {
      setSending(false);
    }
  };

  const decryptMessage = async (record: BaseRecord): Promise<string> => {
    const p = record.payload as Record<string, unknown>;
    const ciphertext = (p.ciphertext as string) ?? '';
    const nonce = (p.nonce as string) ?? '';
    const ephemeralPubkey = (p.ephemeral_pubkey as string) ?? '';
    const sender = record.author;

    if (!ciphertext || !nonce || !ephemeralPubkey) {
      return '';
    }

    try {
      const resp = await fetch('/api/dm/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ciphertext,
          nonce,
          ephemeral_pubkey: ephemeralPubkey,
          sender,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Decryption failed');
      }
      const data = await resp.json();
      return data.plaintext;
    } catch (e) {
      console.error('Failed to decrypt message:', e);
      setDecryptionError(String(e));
      return '[encrypted — unable to decrypt]';
    }
  };

  createEffect(() => {
    if (recipient()) {
      loadMessages();
    }
  });

  const sortedMessages = () =>
    messages().sort((a, b) => a.ts - b.ts);

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
    if (!props.currentPubKey || !props.onReaction) return;
    props.onReaction(targetCid, emoji);
  };

  const renderReactions = (targetCid: string) => {
    const reactions = reactionsFor(targetCid);
    const mine = reactions.filter((r) => r.author === props.currentPubKey);
    const hasReactedMap = new Map<string, string>();
    for (const r of mine) {
      hasReactedMap.set(r.emoji, r.id);
    }

    return (
      <div class="reactions-bar">
        {REACTION_EMOJIS.map((emoji) => {
          const matching = reactions.filter((r) => r.emoji === emoji);
          const hasReacted = hasReactedMap.has(emoji);
          const count = matching.length;
          return (
            <button
              class={`reaction-btn ${hasReacted ? 'reacted' : ''}`}
              onclick={() => handleReactionClick(targetCid, emoji)}
              title={hasReacted ? 'Remove your reaction' : `React with ${emoji}`}
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
    <div class="chat-container">
      <div class="form-group">
        <input
          type="text"
          value={recipient()}
          oninput={(e) => setRecipient((e.target as HTMLInputElement).value)}
          placeholder="Recipient pubkey"
        />
      </div>

      <div class="chat-messages">
        <For each={sortedMessages()} fallback={<div>No messages</div>}>
          {(msg) => (
            <MessageBubble
              msg={msg}
              isOwn={msg.author === props.currentPubKey}
              onDecrypt={decryptMessage}
              reactions={renderReactions(msg.id)}
            />
          )}
        </For>
      </div>

      <Show when={decryptionError()}>
        <div class="error-banner" style={{ "font-size": "0.8rem" }}>
          {decryptionError()}
        </div>
      </Show>

      <div class="chat-input">
        <input
          type="text"
          value={message()}
          oninput={(e) => setMessage((e.target as HTMLInputElement).value)}
          placeholder="Type a message..."
        />
        <button
          class="btn btn-secondary"
          onclick={sendMessage}
          disabled={!message().trim() || !recipient() || sending()}
        >
          {sending() ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );
};

// Render a single decrypted message. Uses a child component so each message
// can independently run its async decryption without blocking the list.
const MessageBubble: Component<{
  msg: BaseRecord;
  isOwn: boolean;
  onDecrypt: (record: BaseRecord) => Promise<string>;
  reactions: JSX.Element;
}> = (props) => {
  const [plaintext, setPlaintext] = createSignal('[decrypting…]');
  const [decrypted, setDecrypted] = createSignal(false);

  createEffect(() => {
    props.onDecrypt(props.msg).then((result) => {
      setPlaintext(result);
      setDecrypted(true);
    });
  });

  return (
    <div class="chat-message">
      <div class="sender">{props.isOwn ? 'you' : props.msg.author.slice(0, 8) + '…'}</div>
      <div class="text">{plaintext()}</div>
      <Show when={props.reactions}>
        {props.reactions}
      </Show>
    </div>
  );
};
