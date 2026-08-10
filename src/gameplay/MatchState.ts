import { match as matchConfig } from '../core/Config';

/**
 * How much paint everyone has left.
 *
 * A shared-state object passed explicitly at construction, like `PlayerState`,
 * rather than a system others reach into. "Can I fire?" has to be answered
 * synchronously in the same step the trigger is read, which rules out the event
 * bus, and the alternative — a counter per shooter — is the bug `HudSystem`
 * already warns about in its own header: two tallies that can disagree.
 *
 * One map for the player and the bots together, deliberately. Ammo lives here
 * rather than on `Character` alongside the score because `WeaponSystem` has no
 * way to reach a `Character`: characters are built inside
 * `CharactersSystem.init()`, after every constructor has already run. Splitting
 * the player's count from the bots' to work around that is exactly how the two
 * drift apart.
 */
export interface MatchState {
  /** Character id to paintballs remaining. */
  readonly ammo: Map<string, number>;
  /**
   * Unlimited paint, and no crate.
   *
   * The test course sets this. That is not a special case bolted on for the
   * suites so much as an honest description of what the course is: a geometry
   * gym whose measurements would become a function of how much paint happened
   * to be left.
   */
  readonly sandbox: boolean;
}

export function createMatchState(
  characterIds: readonly string[],
  options: { sandbox?: boolean } = {},
): MatchState {
  const ammo = new Map<string, number>();
  for (const id of characterIds) ammo.set(id, matchConfig.startingAmmo);
  return { ammo, sandbox: options.sandbox ?? false };
}

/** Rounds left for `id`. `Infinity` in sandbox mode, and 0 for a stranger. */
export function ammoOf(match: MatchState, id: string): number {
  if (match.sandbox) return Infinity;
  return match.ammo.get(id) ?? 0;
}

/**
 * Spends one round. Returns false when there was nothing to spend, in which
 * case the caller must not fire — this is the only gate on shooting.
 */
export function consume(match: MatchState, id: string): boolean {
  if (match.sandbox) return true;
  const remaining = match.ammo.get(id) ?? 0;
  if (remaining <= 0) return false;
  match.ammo.set(id, remaining - 1);
  return true;
}

/** Tops `id` up, and reports the new total. */
export function grant(match: MatchState, id: string, rounds: number): number {
  if (match.sandbox) return Infinity;
  const total = (match.ammo.get(id) ?? 0) + rounds;
  match.ammo.set(id, total);
  return total;
}

/** Every remaining round in the match — what the round-end rule watches. */
export function totalAmmo(match: MatchState): number {
  if (match.sandbox) return Infinity;
  let total = 0;
  for (const remaining of match.ammo.values()) total += remaining;
  return total;
}

/** Puts everyone back to a full load, for a fresh round. */
export function resetAmmo(match: MatchState): void {
  for (const id of match.ammo.keys()) match.ammo.set(id, matchConfig.startingAmmo);
}
