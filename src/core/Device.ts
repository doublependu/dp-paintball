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
