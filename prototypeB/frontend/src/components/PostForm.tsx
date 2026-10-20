import { Component, createSignal, Show, Match } from 'solid-js';
import type { MediaRef } from '../types';

export const MEDIA_CAS_THRESHOLD = 5 * 1024 * 1024; // 5 MB

export interface PostFormProps {
  onSubmit: (text: string, media: MediaRef[]) => void;
  onBlobUpload: (file: File) => Promise<string | null>;
  onMediaOffer: (file: File) => Promise<string | null>;
  currentPubKey: string;
}

export const PostForm: Component<PostFormProps> = (props) => {
  const [text, setText] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [preview, setPreview] = createSignal<{
    cid: string;
    mime: string;
    size: number;
    name: string;
    isOffer: boolean;
  } | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!text().trim() && !preview()) return;
    setIsSubmitting(true);
    const media: MediaRef[] = [];
    if (preview()) {
      const p = preview()!;
      media.push({ cid: p.cid, mime: p.mime, size: p.size, isOffer: p.isOffer });
    }
    await props.onSubmit(text(), media);
    setText('');
    setPreview(null);
    setIsSubmitting(false);
  };

  const handleFileChange = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (file.size <= MEDIA_CAS_THRESHOLD) {
      const cid = await props.onBlobUpload(file);
      if (cid) {
        setPreview({
          cid,
          mime: file.type,
          size: file.size,
          name: file.name,
          isOffer: false,
        });
      }
    } else {
      const offerCid = await props.onMediaOffer(file);
      if (offerCid) {
        setPreview({
          cid: offerCid,
          mime: file.type,
          size: file.size,
          name: file.name,
          isOffer: true,
        });
      }
    }
    input.value = '';
  };

  return (
    <form class="post-form" onsubmit={handleSubmit}>
      <div class="form-group">
        <textarea
          value={text()}
          oninput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          placeholder="What's on your mind?"
          rows={4}
        />
      </div>

      <Show when={preview()}>
        <div class="form-group">
          <div class="peer-badge">
            {preview()!.name} ({preview()!.size} bytes)
            {preview()!.isOffer && <span class="badge badge-orange" style={{ "margin-left": "0.5rem", "font-size": "0.7rem" }}>WebRTC Offer</span>}
          </div>
          <Match when={preview()!.mime.startsWith('image/') && !preview()!.isOffer}>
            <img
              src={`/api/blob/${preview()!.cid}`}
              alt="preview"
              style={{ "max-width": "100%", "border-radius": "4px" }}
            />
          </Match>
          <Match when={preview()!.isOffer}>
            <div class="media-preview">
              Large file — shared via WebRTC. Offer CID:
              <span class="monospace" style={{ "display": "block", "font-size": "0.75rem" }}>
                {preview()!.cid.slice(0, 16)}…{preview()!.cid.slice(-16)}
              </span>
            </div>
          </Match>
        </div>
      </Show>

      <div class="form-group">
        <label>
          <input
            type="file"
            accept="image/*,video/*,.pdf,.zip,.mp4,.mov,.mp3"
            onchange={handleFileChange}
          />
          <span class="hint" style={{ "display": "block", "font-size": "0.75rem", "color": "#888", "margin-top": "0.25rem" }}>
            Files {'<='} 5 MB upload to local CAS. Files {'>'} 5 MB use WebRTC media offer.
          </span>
        </label>
      </div>

      <button type="submit" class="btn btn-primary" disabled={isSubmitting() || (!text().trim() && !preview())}>
        {isSubmitting() ? 'Posting...' : 'Post'}
      </button>
    </form>
  );
};
