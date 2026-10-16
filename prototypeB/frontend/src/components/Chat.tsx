import { Component, createSignal, createEffect } from 'solid-js';
import { For } from 'solid-js';
import type { BaseRecord } from '../types';

export interface ChatProps {
  records: BaseRecord[];
  currentPubKey: string;
}

export const Chat: Component<ChatProps> = (props) => {
  const [message, setMessage] = createSignal('');
  const [recipient, setRecipient] = createSignal('');
  const [messages, setMessages] = createSignal<BaseRecord[]>([]);

  const loadMessages = async () => {
    if (!recipient()) return;
    try {
      const resp = await fetch(`/api/dm?me=${props.currentPubKey}&other=${recipient()}`);
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
    const ts = Date.now();
    const payload = {
      to: recipient(),
      ciphertext: btoa(message()),
      nonce: btoa('nonce-placeholder'),
      ephemeral_pubkey: '',
    };
    try {
      const resp = await fetch('/api/record/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          author: props.currentPubKey,
          prev: null,
          ts,
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
    }
  };

  createEffect(() => {
    if (recipient()) {
      loadMessages();
    }
  });

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
        <For each={messages()} fallback={<div>No messages</div>}>
          {(msg) => {
            const p = msg.payload as Record<string, unknown>;
            let decoded = (p.ciphertext as string) ?? '';
            try { decoded = atob(decoded); } catch {}
            return (
              <div class="chat-message">
                <div class="sender">{msg.author.slice(0, 8)}...</div>
                <div class="text">{decoded}</div>
              </div>
            );
          }}
        </For>
      </div>
      <div class="chat-input">
        <input
          type="text"
          value={message()}
          oninput={(e) => setMessage((e.target as HTMLInputElement).value)}
          placeholder="Type a message..."
        />
        <button class="btn btn-secondary" onclick={sendMessage} disabled={!message().trim() || !recipient()}>
          Send
        </button>
      </div>
    </div>
  );
};
