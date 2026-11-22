export interface SupportMessageSegment {
  text: string;
  url?: string;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/gi;

export function tokenizeSupportMessage(text: string | null | undefined): SupportMessageSegment[] {
  const value = String(text || '');
  if (!value) return [];
  const segments: SupportMessageSegment[] = [];
  let lastIndex = 0;
  URL_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(value)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: value.slice(lastIndex, match.index) });
    }
    let rawUrl = match[0];
    let trailing = '';
    while (rawUrl.length > 0 && /[.,!?;:)\]]$/.test(rawUrl)) {
      trailing = rawUrl.slice(-1) + trailing;
      rawUrl = rawUrl.slice(0, -1);
    }
    if (rawUrl) {
      segments.push({ text: rawUrl, url: rawUrl });
    }
    if (trailing) {
      segments.push({ text: trailing });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex) });
  }
  return segments;
}
