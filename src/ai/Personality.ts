/**
 * What makes one bot different from another.
 *
 * These are tuned for a relaxing game, not a competitive one. Aim error is
 * large, reactions are slow, and every archetype spends a good share of its
 * time doing something other than fighting — a park full of opponents who never
 * miss and never stop shooting would be a completely different game.
 */
export interface Personality {
  name: string;
  /** 0 avoids fights, 1 seeks them out. */
  aggression: number;
  /** Aim cone half-angle in degrees. Large on purpose. */
  aimErrorDeg: number;
  /** Seconds of hesitation between seeing a target and firing at it. */
  reactionTime: number;
  /** Probability that a finished errand is followed by loitering. */
  idleChance: number;
  /** Probability of celebrating a landed hit. */
  tauntChance: number;
  /** Multiplier on walk speed. */
  speed: number;
  /** How far it can notice a target, in metres. */
  sightRange: number;
  /** Seconds it keeps shooting before repositioning. */
  engageDuration: number;
}

export const PERSONALITIES: Personality[] = [
  {
    name: 'wanderer',
    aggression: 0.35,
    aimErrorDeg: 7.5,
    reactionTime: 0.75,
    idleChance: 0.45,
    tauntChance: 0.3,
    speed: 0.8,
    sightRange: 34,
    engageDuration: 2.6,
  },
  {
    name: 'camper',
    aggression: 0.55,
    aimErrorDeg: 4.5,
    reactionTime: 0.55,
    idleChance: 0.7,
    tauntChance: 0.2,
    speed: 0.65,
    sightRange: 46,
    engageDuration: 4.5,
  },
  {
    name: 'chaser',
    aggression: 0.9,
    aimErrorDeg: 9.0,
    reactionTime: 0.35,
    idleChance: 0.12,
    tauntChance: 0.45,
    speed: 1.05,
    sightRange: 40,
    engageDuration: 3.4,
  },
  {
    name: 'goofball',
    aggression: 0.5,
    aimErrorDeg: 12.0,
    reactionTime: 0.9,
    idleChance: 0.55,
    tauntChance: 0.85,
    speed: 0.9,
    sightRange: 30,
    engageDuration: 2.2,
  },
];
