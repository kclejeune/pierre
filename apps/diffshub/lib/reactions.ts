// Emoji reactions on GitHub comments. GitHub offers a fixed set of eight;
// REST names them by their API content ('+1', 'laugh', …) and GraphQL by an
// enum (THUMBS_UP, LAUGH, …). The app keeps the REST names and converts at
// the GraphQL boundary.

import { asRecord } from './untypedJson';

export type ReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'hooray'
  | 'confused'
  | 'heart'
  | 'rocket'
  | 'eyes';

// One reaction's tally on a comment, and whether the signed-in viewer is
// among those who left it.
export interface CommentReaction {
  content: ReactionContent;
  count: number;
  viewerHasReacted: boolean;
}

interface ReactionDefinition {
  content: ReactionContent;
  emoji: string;
  graphql: string;
  label: string;
}

// In GitHub's picker order.
export const REACTIONS: readonly ReactionDefinition[] = [
  { content: '+1', emoji: '👍', graphql: 'THUMBS_UP', label: 'Thumbs up' },
  { content: '-1', emoji: '👎', graphql: 'THUMBS_DOWN', label: 'Thumbs down' },
  { content: 'laugh', emoji: '😄', graphql: 'LAUGH', label: 'Laugh' },
  { content: 'hooray', emoji: '🎉', graphql: 'HOORAY', label: 'Hooray' },
  { content: 'confused', emoji: '😕', graphql: 'CONFUSED', label: 'Confused' },
  { content: 'heart', emoji: '❤️', graphql: 'HEART', label: 'Heart' },
  { content: 'rocket', emoji: '🚀', graphql: 'ROCKET', label: 'Rocket' },
  { content: 'eyes', emoji: '👀', graphql: 'EYES', label: 'Eyes' },
];

const BY_CONTENT = new Map(REACTIONS.map((entry) => [entry.content, entry]));
const BY_GRAPHQL = new Map(REACTIONS.map((entry) => [entry.graphql, entry]));

export function isReactionContent(value: unknown): value is ReactionContent {
  return typeof value === 'string' && BY_CONTENT.has(value as ReactionContent);
}

export function getReactionDefinition(
  content: ReactionContent
): ReactionDefinition {
  // Every ReactionContent is in the table.
  return BY_CONTENT.get(content) as ReactionDefinition;
}

// The non-zero tallies in a REST comment's `reactions` summary
// ({ total_count, '+1': 2, heart: 1, … }). REST doesn't say which are the
// viewer's.
export function readRestReactions(summary: unknown): CommentReaction[] {
  const record = asRecord(summary);
  return REACTIONS.flatMap(({ content }) => {
    const count = record?.[content];
    return typeof count === 'number' && count > 0
      ? [{ content, count, viewerHasReacted: false }]
      : [];
  });
}

// The non-zero tallies in a GraphQL `reactionGroups` list
// ([{ content: 'THUMBS_UP', viewerHasReacted, reactors: { totalCount } }]),
// or null when the payload isn't one.
export function readReactionGroups(groups: unknown): CommentReaction[] | null {
  if (!Array.isArray(groups)) {
    return null;
  }
  const reactions: CommentReaction[] = [];
  for (const group of groups) {
    const record = asRecord(group);
    const definition = BY_GRAPHQL.get(String(record?.content));
    const count = asRecord(record?.reactors)?.totalCount;
    if (definition != null && typeof count === 'number' && count > 0) {
      reactions.push({
        content: definition.content,
        count,
        viewerHasReacted: record?.viewerHasReacted === true,
      });
    }
  }
  return reactions;
}

// Whether `content` is among the viewer's own reactions.
export function hasViewerReacted(
  reactions: readonly CommentReaction[],
  content: ReactionContent
): boolean {
  return reactions.some(
    (entry) => entry.content === content && entry.viewerHasReacted
  );
}

// `reactions` after the viewer adds or removes `content`, for showing the
// change before GitHub confirms it. Keeps GitHub's picker order.
export function toggleReaction(
  reactions: readonly CommentReaction[],
  content: ReactionContent
): CommentReaction[] {
  const existing = reactions.find((entry) => entry.content === content);
  const adding = !hasViewerReacted(reactions, content);
  const next = new Map(reactions.map((entry) => [entry.content, entry]));
  const count = (existing?.count ?? 0) + (adding ? 1 : -1);
  if (count <= 0) {
    next.delete(content);
  } else {
    next.set(content, { content, count, viewerHasReacted: adding });
  }
  return REACTIONS.flatMap(({ content: key }) => {
    const entry = next.get(key);
    return entry == null ? [] : [entry];
  });
}
