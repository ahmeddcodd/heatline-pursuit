export const CLOUD_SAVE_VERSION = 1;

export type HeatlineCloudSave = Readonly<{
  version: typeof CLOUD_SAVE_VERSION;
  completedThrough: number;
  resumeLevel: number;
  playerMuted: boolean;
}>;

const clampInteger = (value: unknown, minimum: number, maximum: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
};

const defaultSave = (): HeatlineCloudSave => ({
  version: CLOUD_SAVE_VERSION,
  completedThrough: -1,
  resumeLevel: 0,
  playerMuted: false,
});

export function parseCloudSave(
  serialized: string | null,
  levelCount: number,
): HeatlineCloudSave {
  if (!serialized || levelCount < 1) return defaultSave();

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object") return defaultSave();

    const root = parsed as Record<string, unknown>;
    const campaign =
      root.campaign && typeof root.campaign === "object"
        ? (root.campaign as Record<string, unknown>)
        : root;
    const lastLevel = levelCount - 1;

    return {
      version: CLOUD_SAVE_VERSION,
      completedThrough: clampInteger(
        campaign.completedThrough,
        -1,
        lastLevel,
      ),
      resumeLevel: clampInteger(campaign.resumeLevel, 0, lastLevel),
      playerMuted:
        typeof root.playerMuted === "boolean" ? root.playerMuted : false,
    };
  } catch {
    return defaultSave();
  }
}

export function serializeCloudSave(
  save: Omit<HeatlineCloudSave, "version">,
  levelCount: number,
) {
  const lastLevel = Math.max(0, levelCount - 1);
  return JSON.stringify({
    version: CLOUD_SAVE_VERSION,
    campaign: {
      completedThrough: clampInteger(
        save.completedThrough,
        -1,
        lastLevel,
      ),
      resumeLevel: clampInteger(save.resumeLevel, 0, lastLevel),
    },
    playerMuted: save.playerMuted,
  });
}
