import { useRef, useState } from 'react';
import { authApi, apiErrorMessage } from '../services/api';
import { useAuth } from '../context/AuthContext';

// Profile photo: display avatar + upload control shared by every role.
// Storage: the photo is a downscaled JPEG data URL kept in users.avatar_url
// (database, not disk — Render's free-plan filesystem is ephemeral).
// The client downscales to at most 512px and JPEG quality 0.8 before
// upload; the backend rejects anything that is not a JPEG/PNG/WebP image
// or is larger than 200 KB.

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Circular avatar: the photo when present, initials otherwise. */
export function Avatar({
  name,
  photoUrl,
  size = 40,
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
}) {
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={`${name}'s profile photo`}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-navy-600 font-bold text-white"
      style={{ width: size, height: size, fontSize: Math.max(12, size * 0.36) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Downscale an image file to at most 512px on its longest side and
 * return a JPEG data URL (quality 0.8). Small enough to store in the
 * database (well under the 200 KB backend limit). */
export async function downscalePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not process the image in this browser.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** Photo upload control for the signed-in user's own profile. */
export default function PhotoUploader() {
  const { user, setPhotoUrl } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!user) return null;
  const current = preview ?? user.photoUrl ?? null;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('Choose a JPEG, PNG or WebP image.');
      return;
    }
    try {
      const dataUrl = await downscalePhoto(file);
      setPreview(dataUrl);
    } catch {
      setError('Could not read that image. Try a different file.');
    }
  };

  const save = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const { data } = await authApi.uploadPhoto(preview);
      setPhotoUrl((data.data as unknown as { avatar_url: string | null }).avatar_url ?? preview);
      setPreview(null);
      setNotice('Profile photo saved.');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await authApi.removePhoto();
      setPhotoUrl(null);
      setPreview(null);
      setNotice('Profile photo removed.');
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start gap-4">
      <Avatar name={user.fullName} photoUrl={current} size={96} />
      <div className="min-w-0">
        <p className="text-sm text-slate-500">
          Your profile photo. It is shown in the sidebar and on your profile.
          The image is resized to at most 512px before upload.
        </p>
        {error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {notice && <p role="status" className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            aria-label="Choose a profile photo"
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Choose photo…
          </button>
          {preview && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-navy-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save photo'}
            </button>
          )}
          {user.photoUrl && !preview && (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={saving}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Remove photo
            </button>
          )}
          {preview && (
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="rounded-lg border px-3 py-2 text-sm font-medium"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
