/** Keep only the current app's origin and path, never credentials or URL state. */
export function appHandoffUrl(href: string): string {
  if (typeof href !== 'string') return '';
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    // URL.origin excludes username/password; search and hash are never copied.
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Call only from an explicit copy action; this module never copies on import. */
export async function copyHandoffUrl(
  url: string,
  clipboard?: Pick<Clipboard, 'writeText'> | null
): Promise<'copied' | 'manual'> {
  const value = appHandoffUrl(url);
  if (!value) return 'manual';
  try {
    const target = clipboard === undefined
      ? (typeof navigator === 'undefined' ? undefined : navigator.clipboard)
      : clipboard;
    if (typeof target?.writeText !== 'function') return 'manual';
    await target.writeText(value);
    return 'copied';
  } catch {
    // No permission requests, execCommand or automatic fallback copies.
    return 'manual';
  }
}
