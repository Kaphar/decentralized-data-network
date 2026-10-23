import { Component, createSignal, createEffect, Show, For } from 'solid-js';
import type { BaseRecord } from '../types';
import { ReactionsBar } from './ReactionsBar';

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
              records={props.records}
              currentPubKey={props.currentPubKey}
              onReact={props.onReaction ?? (() => {})}
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
  records: BaseRecord[];
  currentPubKey: string;
  onReact: (targetCid: string, emoji: string) => void;
}> = (props) => {
  const [plaintext, setPlaintext] = createSignal('[decrypting…]');

  createEffect(() => {
    props.onDecrypt(props.msg).then((result) => {
      setPlaintext(result);
    });
  });

  return (
    <div class="chat-message">
      <div class="sender">{props.isOwn ? 'you' : props.msg.author.slice(0, 8) + '…'}</div>
      <div class="text">{plaintext()}</div>
      <ReactionsBar
        records={props.records}
        targetCid={props.msg.id}
        currentPubKey={props.currentPubKey}
        onReact={props.onReact}
      />
    </div>
  );
};
