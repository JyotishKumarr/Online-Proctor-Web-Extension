/* Exam Proctor — shared logger injected into every page.
 * Provides window.ProctorLogger used by content.js. Forwards violations to
 * the background service worker (the single source of truth) and triggers
 * the on-page warning overlay. */

(function () {
  const ProctorLogger = {
    active: false,
    settings: {},

    setActive(active) { this.active = !!active; },
    setSettings(settings) { this.settings = settings || {}; },

    /** Record a violation. Safe to call even when no exam is running —
     *  the background worker ignores logs while inactive. The background
     *  reply carries the running strike `count` and an `ended` flag once the
     *  limit is reached, which drive the escalating overlay. */
    log(type, detail) {
      if (!this.active) return;
      const self = this;
      try {
        chrome.runtime.sendMessage(
          { cmd: "LOG_VIOLATION", type, detail, url: location.href },
          (resp) => {
            void chrome.runtime.lastError; // swallow "no receiver" errors
            if (self.settings.showWarnings === false || !window.ProctorOverlay) return;
            if (resp && resp.ended) window.ProctorOverlay.ended("Repeated violations");
            else window.ProctorOverlay.warn(type, detail, (resp && resp.count) || 1);
          }
        );
      } catch (e) { /* extension context may be invalidated on reload */ }
    }
  };

  window.ProctorLogger = ProctorLogger;
})();
