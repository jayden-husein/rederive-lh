// Finding a repo path or git URL in the learner's unsent composer text, to prefill the
// "Rederive this repo" dialog. An attached folder shows up in a sent message as a
// backtick-quoted path, so quoted candidates win over bare words. Browser-safe: no imports.

// A POSIX path needs two segments, so "/help" doesn't count.
// Only what parseSource (repo.ts) opens: http:// is refused there, so it isn't offered here.
const LOOKS_LIKE_SOURCE = /^(\\\\|[A-Za-z]:[\\/]|\/[^/\s]+\/|~\/|https:\/\/|ssh:\/\/|git@)/;

/** The last path or URL in `text` (the most recently attached one), or null. */
export function sourceFromDraft(text: string): string | null {
  const quoted = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim());
  // Bare words drop trailing sentence punctuation ("clone https://x/y.").
  const bare = text.replace(/`[^`\n]*`/g, " ").split(/\s+/).map((w) => w.replace(/[.,;:!?)"']+$/, ""));
  for (const candidates of [quoted, bare]) {
    const found = candidates.filter((c) => LOOKS_LIKE_SOURCE.test(c));
    if (found.length) return found[found.length - 1]!;
  }
  return null;
}
