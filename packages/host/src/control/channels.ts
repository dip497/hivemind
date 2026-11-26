/** Named channels agents follow and post to. A post goes to each follower's inbox. Keyed by bare tile id. */

const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MENTION = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;

export const validChannelName = (name: string): boolean => CHANNEL_NAME.test(name);

export const mentionedNames = (text: string): string[] =>
  [...new Set([...text.matchAll(MENTION)].map((m) => m[2]!.toLowerCase()))];

export class Channels {
  private followers = new Map<string, Set<string>>();

  follow(channel: string, tile: string): void {
    const set = this.followers.get(channel) ?? new Set<string>();
    set.add(tile);
    this.followers.set(channel, set);
  }

  leave(channel: string, tile: string): boolean {
    const set = this.followers.get(channel);
    if (!set?.delete(tile)) return false;
    if (!set.size) this.followers.delete(channel);
    return true;
  }

  followersOf(channel: string): string[] {
    return [...(this.followers.get(channel) ?? [])];
  }

  followedBy(tile: string): string[] {
    return [...this.followers].filter(([, set]) => set.has(tile)).map(([channel]) => channel).sort();
  }

  everyone(): string[] {
    return [...new Set([...this.followers.values()].flatMap((set) => [...set]))];
  }

  forget(tile: string): void {
    for (const channel of this.followedBy(tile)) this.leave(channel, tile);
  }
}
