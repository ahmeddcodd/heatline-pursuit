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
  destroy: () => void;
};

type YouTubePlayablesApi = {
  IN_PLAYABLES_ENV: boolean;
  game: {
    firstFrameReady: () => void;
    gameReady: () => void;
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
        !firstFrameWasReported
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
