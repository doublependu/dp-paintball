/**
 * Display names for the scoreboard and the results line-up.
 *
 * The bots were `bot a` through `bot f` everywhere they were shown, which is
 * fine for a test fixture and wrong for the end card: seven figures stand in a
 * row there with awards over their heads, and "bot d — most painted" reads like
 * a unit test passing rather than like an afternoon in the park.
 *
 * Initials follow the ids, so `bot-c` is still findable as Cass when something
 * needs debugging from a screenshot.
 */
const BOT_NAMES: Readonly<Record<string, string>> = {
  'bot-a': 'Ada',
  'bot-b': 'Bo',
  'bot-c': 'Cass',
  'bot-d': 'Dev',
  'bot-e': 'Etta',
  'bot-f': 'Fitz',
};

/**
 * In a room, the names of the friends in the bots' places (`net/`): the name for a
 * character's id, or undefined for a bot.
 */
let friendName: ((id: string) => string | undefined) | null = null;

export function setFriendNames(names: ((id: string) => string | undefined) | null): void {
  friendName = names;
}

/** What to call a character on screen. Ids stay the wire format. */
export function displayName(id: string): string {
  if (id === 'player') return 'you';
  const friend = friendName?.(id);
  if (friend !== undefined) return friend;
  return BOT_NAMES[id] ?? id.replace('bot-', 'bot ');
}
