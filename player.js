// Thin wrapper around the official YouTube IFrame Player API.
// Hides YT chrome only as far as the documented playerVars allow.

let apiPromise = null;

function loadIframeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiPromise;
}

export class TVPlayer {
  constructor(elementId, { onStateChange, onError } = {}) {
    this.elementId = elementId;
    this.onStateChange = onStateChange;
    this.onError = onError;
    this.player = null;
    this.currentVideoId = null;
    this.readyPromise = null;
  }

  // Creates the underlying YT.Player once; safe to call repeatedly.
  ensure() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = loadIframeApi().then(
      (YT) =>
        new Promise((resolve) => {
          this.player = new YT.Player(this.elementId, {
            width: '100%',
            height: '100%',
            playerVars: {
              controls: 0,
              disablekb: 1,
              rel: 0,
              iv_load_policy: 3,
              fs: 0,
              playsinline: 1,
              autoplay: 0,
            },
            events: {
              onReady: () => resolve(this),
              onStateChange: (e) => this.onStateChange?.(e.data),
              onError: (e) => this.onError?.(e.data),
            },
          });
        })
    );
    return this.readyPromise;
  }

  tune(videoId, startSeconds) {
    this.currentVideoId = videoId;
    this.player.loadVideoById({ videoId, startSeconds: Math.max(0, Math.floor(startSeconds)) });
  }

  stop() {
    this.currentVideoId = null;
    try {
      this.player?.stopVideo();
    } catch {
      /* player may not be ready yet */
    }
  }

  play() {
    this.player?.playVideo();
  }

  pause() {
    this.player?.pauseVideo();
  }

  seekTo(seconds) {
    this.player?.seekTo(seconds, true);
  }

  getCurrentTime() {
    return this.player?.getCurrentTime?.() ?? 0;
  }

  // Reports whatever is on the video surface right now — during an ad break
  // that is the ad's length, not the scheduled programme's.
  getDuration() {
    return this.player?.getDuration?.() ?? 0;
  }

  getState() {
    return this.player?.getPlayerState?.() ?? -1;
  }

  setVolume(v) {
    this.player?.setVolume?.(v);
  }

  setMuted(muted) {
    if (!this.player) return;
    if (muted) this.player.mute();
    else this.player.unMute();
  }
}

// Mirror of YT.PlayerState so callers don't need the global.
export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
};
