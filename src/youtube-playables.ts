export type YouTubePlayablesState = Readonly<{
  paused: boolean;
  audioEnabled: boolean;
  inPlayablesEnvironment: boolean;
}>;

export type YouTubePlayablesLifecycle = {
  getState: () => YouTubePlayablesState;
  onStateChange: (
    listener: (state: YouTubePlayablesState) => void,
  ) => () => void;
  firstFrameReady: () => void;
  gameReady: () => void;
  loadCloudData: () => Promise<string | null>;
  saveCloudData: (data: string) => Promise<void>;
  destroy: () => void;
};

type YouTubePlayablesApi = {
  IN_PLAYABLES_ENV: boolean;
  game: {
    firstFrameReady: () => void;
    gameReady: () => void;
    loadData: () => Promise<string>;
    saveData: (data: string) => Promise<void>;
  };
  system: {
    isAudioEnabled: () => boolean;
    onAudioEnabledChange: (callback: (enabled: boolean) => void) => () => void;
    onPause: (callback: () => void) => () => void;
    onResume: (callback: () => void) => () => void;
  };
  health?: {
    logWarning: () => void;
  };
};

function getYouTubePlayablesApi() {
  return (globalThis as typeof globalThis & { ytgame?: YouTubePlayablesApi })
    .ytgame;
}

export function createYouTubePlayablesLifecycle(): YouTubePlayablesLifecycle {
  const api = getYouTubePlayablesApi();
  const inPlayablesEnvironment = Boolean(api?.IN_PLAYABLES_ENV);
  const listeners = new Set<(state: YouTubePlayablesState) => void>();
  const removeSdkListeners: Array<() => void> = [];
  let state: YouTubePlayablesState = Object.freeze({
    paused: false,
    audioEnabled: true,
    inPlayablesEnvironment,
  });
  let firstFrameWasReported = false;
  let gameWasReportedReady = false;
  let cloudLoadSettled = !inPlayablesEnvironment;
  let cloudLoadSucceeded = !inPlayablesEnvironment;
  let cloudLoadPromise: Promise<string | null> | null = null;
  let cloudSaveQueue = Promise.resolve();

  const warnYouTube = () => {
    try {
      api?.health?.logWarning();
    } catch {
      // The health endpoint is best-effort and must never break the game.
    }
  };

  const publish = (next: Partial<YouTubePlayablesState>) => {
    state = Object.freeze({ ...state, ...next });
    listeners.forEach((listener) => listener(state));
  };

  if (api && inPlayablesEnvironment) {
    try {
      state = Object.freeze({
        ...state,
        audioEnabled: api.system.isAudioEnabled(),
      });
    } catch {
      warnYouTube();
    }

    const register = (subscribe: () => () => void) => {
      try {
        removeSdkListeners.push(subscribe());
      } catch {
        warnYouTube();
      }
    };
    register(() =>
      api.system.onAudioEnabledChange((audioEnabled) => {
        publish({ audioEnabled });
      }),
    );
    register(() =>
      api.system.onPause(() => {
        publish({ paused: true });
      }),
    );
    register(() =>
      api.system.onResume(() => {
        publish({ paused: false });
      }),
    );
  }

  const loadCloudData = () => {
    if (!api || !inPlayablesEnvironment) {
      cloudLoadSucceeded = true;
      return Promise.resolve(null);
    }
    if (!cloudLoadPromise) {
      try {
        cloudLoadPromise = api.game
          .loadData()
          .then((data) => {
            cloudLoadSettled = true;
            cloudLoadSucceeded = true;
            return data || null;
          })
          .catch(() => {
            cloudLoadSettled = true;
            cloudLoadSucceeded = false;
            warnYouTube();
            return null;
          });
      } catch {
        cloudLoadSettled = true;
        cloudLoadSucceeded = false;
        warnYouTube();
        cloudLoadPromise = Promise.resolve(null);
      }
    }
    return cloudLoadPromise;
  };

  const isWellFormedUtf16 = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next < 0xdc00 || next > 0xdfff) return false;
        index++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return false;
      }
    }
    return true;
  };

  const saveCloudData = (data: string) => {
    if (!api || !inPlayablesEnvironment) return Promise.resolve();
    if (
      !cloudLoadSucceeded ||
      data.length * 2 > 3 * 1024 * 1024 ||
      !isWellFormedUtf16(data)
    ) {
      warnYouTube();
      return Promise.resolve();
    }

    cloudSaveQueue = cloudSaveQueue
      .catch(() => undefined)
      .then(() => api.game.saveData(data))
      .catch(() => {
        warnYouTube();
      });
    return cloudSaveQueue;
  };

  return {
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    firstFrameReady: () => {
      if (!api || !inPlayablesEnvironment || firstFrameWasReported) return;
      try {
        api.game.firstFrameReady();
        firstFrameWasReported = true;
      } catch {
        warnYouTube();
      }
    },
    gameReady: () => {
      if (
        !api ||
        !inPlayablesEnvironment ||
        gameWasReportedReady ||
        !firstFrameWasReported ||
        !cloudLoadSettled
      ) {
        return;
      }
      try {
        api.game.gameReady();
        gameWasReportedReady = true;
      } catch {
        warnYouTube();
      }
    },
    loadCloudData,
    saveCloudData,
    destroy: () => {
      removeSdkListeners.forEach((removeListener) => {
        try {
          removeListener();
        } catch {
          warnYouTube();
        }
      });
      removeSdkListeners.length = 0;
      listeners.clear();
    },
  };
}
