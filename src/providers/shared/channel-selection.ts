/**
 * Isolate-local channel selection state: failure cooldowns and round-robin
 * cursors. Nothing here is shared across isolates, so both are best-effort.
 */

const MAX_TRACKED_CHANNELS = 256;

const cooldowns = new Map<string, number>();
const roundRobinCursors = new Map<string, number>();

export type SelectableChannel = {
    key: string;
    config: { weight?: number };
};

const trimOldestEntry = (map: Map<string, number>): void => {
    if (map.size <= MAX_TRACKED_CHANNELS) {
        return;
    }

    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
        map.delete(oldestKey);
    }
};

export const resetChannelSelectionState = (): void => {
    cooldowns.clear();
    roundRobinCursors.clear();
};

export const markChannelSuccess = (channelKey: string): void => {
    cooldowns.delete(channelKey);
};

export const markChannelFailure = (
    channelKey: string,
    cooldownMs: number,
    now: number = Date.now(),
): void => {
    if (cooldownMs <= 0) {
        return;
    }

    cooldowns.delete(channelKey);
    cooldowns.set(channelKey, now + cooldownMs);
    trimOldestEntry(cooldowns);
};

const pickPriorityChannel = <T extends SelectableChannel>(
    channels: T[],
    random: () => number,
): T => {
    let maxWeight = Number.NEGATIVE_INFINITY;
    for (const channel of channels) {
        maxWeight = Math.max(maxWeight, channel.config.weight ?? 0);
    }

    const pool = channels.filter((channel) => (channel.config.weight ?? 0) === maxWeight);
    return pool[Math.floor(random() * pool.length)];
};

const pickWeightedChannel = <T extends SelectableChannel>(
    channels: T[],
    random: () => number,
): T => {
    let totalWeight = 0;
    for (const channel of channels) {
        totalWeight += Math.max(0, Math.trunc(channel.config.weight ?? 0)) + 1;
    }

    let roll = random() * totalWeight;
    for (const channel of channels) {
        roll -= Math.max(0, Math.trunc(channel.config.weight ?? 0)) + 1;
        if (roll < 0) {
            return channel;
        }
    }

    return channels[channels.length - 1];
};

const pickRoundRobinChannel = <T extends SelectableChannel>(channels: T[]): T => {
    const ordered = [...channels].sort((left, right) => left.key.localeCompare(right.key));
    const signature = ordered.map((channel) => channel.key).join("\u0000");
    const cursor = roundRobinCursors.get(signature) ?? 0;
    const channel = ordered[cursor % ordered.length];

    roundRobinCursors.delete(signature);
    roundRobinCursors.set(signature, cursor + 1);
    trimOldestEntry(roundRobinCursors);

    return channel;
};

/**
 * Picks one channel for the current request. Channels currently cooling down
 * are skipped unless every channel is cooling down, in which case the whole
 * list stays eligible instead of failing the request.
 */
export const selectChannel = <T extends SelectableChannel>(
    channels: T[],
    strategy: ChannelRoutingStrategy,
    options?: { now?: number; random?: () => number },
): T => {
    if (channels.length === 0) {
        throw new Error("selectChannel requires at least one channel");
    }

    const now = options?.now ?? Date.now();
    const random = options?.random ?? Math.random;
    const healthy = channels.filter((channel) => (cooldowns.get(channel.key) ?? 0) <= now);
    const pool = healthy.length > 0 ? healthy : channels;

    switch (strategy) {
        case "weighted":
            return pickWeightedChannel(pool, random);
        case "round-robin":
            return pickRoundRobinChannel(pool);
        default:
            return pickPriorityChannel(pool, random);
    }
};
