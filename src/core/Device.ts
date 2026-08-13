/**
 * Which control scheme this machine gets.
 *
 * Asked once and cached: the answer decides how `Input` behaves and whether the
 * touch overlay is built at all, and a value that could change halfway through a
 * frame would leave those two disagreeing.
 *
 * `(pointer: coarse)` describes the *primary* pointer, which is what makes it
 * the right question — a laptop with a touchscreen still has a mouse under the
 * player's hand and should keep the keyboard scheme. `maxTouchPoints` guards the
 * other way, against a coarse pointer with no touch digitiser behind it.
 */
let cached: boolean | undefined;

export function isTouchDevice(): boolean {
  if (cached !== undefined) return cached;
  cached = detect();
  return cached;
}

/**
 * Whether the page is running as an installed app rather than in a browser tab.
 *
 * Two questions because two platforms answer different ones: the standard
 * display-mode query, and Safari's own `navigator.standalone`, which is the
 * only signal iOS gives for a page opened from the home screen.
 */
export function isStandalone(): boolean {
  const displayMode = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || legacy;
}

/**
 * Whether this is an iPhone or iPad.
 *
 * User-agent sniffing, which is normally the wrong tool — but the thing being
 * detected here is a *product decision by Apple*, not a feature: Safari on iOS
 * has no Fullscreen API on the phone and no way to offer an install, and the
 * only remedy is to tell the player how to add the page to their home screen
 * themselves. There is no capability to feature-detect for "this browser will
 * never let you do this".
 *
 * iPadOS reports itself as a Mac, hence the second clause: a desktop Safari
 * with a touch screen does not exist.
 */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function detect(): boolean {
  // `?touch=1` and `?touch=0` force it either way. Without this the touch build
  // could only ever be exercised on a phone, which is no way to work on it and
  // no way to test it.
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1' || forced === 'true') return true;
  if (forced === '0' || forced === 'false') return false;

  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && navigator.maxTouchPoints > 0;
}
