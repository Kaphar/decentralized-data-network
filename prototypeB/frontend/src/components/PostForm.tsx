import { Component, createSignal, Show, Match } from 'solid-js';
import type { MediaRef } from '../types';

export interface PostFormProps {
  onSubmit: (text: string, media: MediaRef[]) => void;
  onBlobUpload: (file: File) => Promise<string | null>;
}

export const PostForm: Component<PostFormProps> = (props) => {
  const [text, setText] = createSignal('');
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [preview, setPreview] = createSignal<{ cid: string; mime: string; size: number; name: string } | null>(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!text().trim()) return;
    setIsSubmitting(true);
    const media: MediaRef[] = [];
    if (preview()) {
      const p = preview()!;
      media.push({ cid: p.cid, mime: p.mime, size: p.size });
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
    const cid = await props.onBlobUpload(file);
    if (cid) {
      setPreview({
        cid,
        mime: file.type,
        size: file.size,
        name: file.name,
      });
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
          </div>
          <Match when={preview()!.mime.startsWith('image/')}>
            <img src={`/api/blob/${preview()!.cid}`} alt="preview" style={{ "max-width": "100%", "border-radius": "4px" }} />
          </Match>
        </div>
      </Show>

      <div class="form-group">
        <label>
          <input type="file" accept="image/*" onchange={handleFileChange} />
        </label>
      </div>

      <button type="submit" class="btn btn-primary" disabled={isSubmitting() || !text().trim()}>
        {isSubmitting() ? 'Posting...' : 'Post'}
    </button>
  </form>
  );
};
