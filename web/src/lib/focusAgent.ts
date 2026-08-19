let pending: { name: string; at: number } | null = null;

/**
 * Ask the named agent's chat composer to grab focus when it next mounts.
 * Used after launching: the tile (and its composer) only appears once the
 * agent's session gets linked, so focus can't be set at navigation time.
 */
export function requestComposerFocus(name: string) {
  pending = { name, at: Date.now() };
}

/** True once per request, if it targets this agent and is still fresh. */
export function consumeComposerFocus(name: string): boolean {
  if (!pending || pending.name !== name) return false;
  const fresh = Date.now() - pending.at < 15_000;
  pending = null;
  return fresh;
}
