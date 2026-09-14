/**
 * Whether a paused conversation is still cheap to resume.
 *
 * Resuming replays the whole thread to the model — every note the agent read, every
 * search it ran, not just the questions and answers — which is nearly free while the
 * provider's prompt cache still holds it and full price once it does not. A thread you
 * come back to after a week costs more to resume than it cost to have.
 *
 * No CLI reports a cache hit, so the only signal available is how long ago the last
 * answer landed. Hence "likely": this is a guess from the clock, measured against a
 * window each agent carries in its own capabilities — every provider caches, and each
 * for its own length of time — with one setting to override all of them, because the
 * real TTLs are only loosely documented and move.
 *
 * No Obsidian imports: `npm run check` runs this without an app.
 */

import { providerOrDefault } from "./providers";

export interface CacheState {
	/** Minutes since the last answer. Null when there is no stamp to go on. */
	ageMinutes: number | null;
	/** Whether the prompt cache has probably dropped the thread by now. */
	expired: boolean;
}

/** Nothing to judge: no thread, no timestamp, or the check turned off. */
export const FRESH: CacheState = { ageMinutes: null, expired: false };

/**
 * @param updated When the last answer landed, as the frontmatter records it.
 * @param cacheMinutes How long a thread is assumed to stay cached. 0 never expires.
 */
export function cacheState(updated: string, cacheMinutes: number, now = Date.now()): CacheState {
	// A local time with no offset, so Date.parse reads it as local — which is how it
	// was written. An unparseable or missing stamp is not evidence of age.
	const stamp = Date.parse(updated);
	if (cacheMinutes <= 0 || !Number.isFinite(stamp)) return FRESH;
	const ageMinutes = Math.max(0, Math.round((now - stamp) / 60_000));
	return { ageMinutes, expired: ageMinutes > cacheMinutes };
}

/**
 * How long a thread held by this agent is assumed to stay cached. Each agent has its own
 * window, because Anthropic caches for an hour when asked to and OpenAI and Google for
 * minutes. One override for all of them beats four numbers to keep in step.
 *
 * @param override The setting, as typed. Empty leaves each agent on its own window.
 */
export function cacheMinutesFor(override: string, provider: string): number {
	const minutes = Number.parseInt(override, 10);
	// Not `|| default`: 0 is a value here, and means never expire.
	if (Number.isFinite(minutes) && minutes >= 0) return minutes;
	return providerOrDefault(provider).capabilities.cacheMinutes;
}

/** "40 minutes", "3 hours", "2 days" — enough to tell a coffee break from a week off. */
export function formatAge(minutes: number): string {
	for (const [size, unit] of [
		[60 * 24, "day"],
		[60, "hour"],
		[1, "minute"],
	] as const) {
		const count = Math.floor(minutes / size);
		if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"}`;
	}
	return "less than a minute";
}
