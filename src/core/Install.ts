import { isIos, isStandalone } from './Device';

/**
 * The browser's own install prompt, if it offered one.
 *
 * Chrome fires `beforeinstallprompt` once, early, and only if the page
 * qualifies — a manifest, an icon, and a few visits. Captured at module scope
 * rather than inside a system's `init`, because the event has usually been and
 * gone by the time the park has finished loading.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

window.addEventListener('beforeinstallprompt', (event) => {
  // Held back so it can be offered from our own screen, at a moment that makes
  // sense, rather than by a browser bar over the game.
  event.preventDefault();
  deferred = event as InstallPromptEvent;
  for (const listener of listeners) listener();
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  for (const listener of listeners) listener();
});

/**
 * What, if anything, to offer the player.
 *
 * - `prompt` — one tap: the browser will do it (Chrome, Edge, Samsung).
 * - `manual` — iOS, where the only route is the Share sheet and the player has
 *   to be shown it.
 * - `none` — already installed, or a browser with no such concept.
 */
export type InstallOffer = 'prompt' | 'manual' | 'none';

export function installOffer(): InstallOffer {
  if (isStandalone()) return 'none';
  if (deferred) return 'prompt';
  return isIos() ? 'manual' : 'none';
}

/** Runs the browser's install flow. Resolves once the player has answered. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // A captured prompt is single-use; drop it whatever the answer, or a second
  // tap rejects with "already used".
  deferred = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === 'accepted';
  } catch {
    return false;
  } finally {
    for (const listener of listeners) listener();
  }
}

/** Called when the offer changes — the prompt arriving, or being spent. */
export function onInstallOfferChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
