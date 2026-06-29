/* Exam Proctor — on-page warning overlay.
 * Provides window.ProctorOverlay with:
 *   warn(type, detail, strike) — escalating top banner
 *     strike 1: auto-hides after 5s; strike >= 2: stays until the student clicks.
 *   gate(onEnter)  — blocking full-page overlay requiring fullscreen.
 *   clearGate()    — remove the fullscreen gate once fullscreen is entered.
 *   ended(reason)  — terminal blocking overlay when the session is ended.
 * Works even at document_start, before <body> exists. */

(function () {
  const STYLE_ID = "exam-proctor-overlay-style";
  const BANNER_ID = "exam-proctor-overlay-root";
  const MODAL_ID = "exam-proctor-modal-root";
  let hideTimer = null;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BANNER_ID} {
        position: fixed; top: 0; left: 0; right: 0;
        z-index: 2147483647;
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        display: flex; align-items: center; gap: 12px;
        padding: 14px 20px;
        background: #b00020; color: #fff;
        box-shadow: 0 2px 12px rgba(0,0,0,.35);
        animation: ep-slide-down .25s ease-out;
      }
      #${BANNER_ID}.ep-severe { background: #7a0016; }
      @keyframes ep-slide-down { from { transform: translateY(-100%);} to { transform: translateY(0);} }
      #${BANNER_ID} .ep-icon { font-size: 22px; line-height: 1; }
      #${BANNER_ID} .ep-text { flex: 1; }
      #${BANNER_ID} .ep-title { font-weight: 700; font-size: 15px; }
      #${BANNER_ID} .ep-detail { font-size: 13px; opacity: .92; margin-top: 2px; }
      #${BANNER_ID} .ep-btn {
        background: rgba(255,255,255,.18); color: #fff; border: 1px solid rgba(255,255,255,.5);
        border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
      }
      #${BANNER_ID} .ep-btn:hover { background: rgba(255,255,255,.3); }

      #${MODAL_ID} {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(10,10,12,.94);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        animation: ep-fade .2s ease-out;
      }
      @keyframes ep-fade { from { opacity: 0; } to { opacity: 1; } }
      #${MODAL_ID} .ep-card {
        background: #15171c; color: #fff;
        max-width: 440px; width: calc(100% - 48px);
        border-radius: 14px; padding: 28px; text-align: center;
        box-shadow: 0 12px 48px rgba(0,0,0,.5);
      }
      #${MODAL_ID}.ep-ended .ep-card { border: 1px solid #b00020; }
      #${MODAL_ID} .ep-m-icon { font-size: 40px; line-height: 1; }
      #${MODAL_ID} .ep-m-title { font-size: 20px; font-weight: 700; margin: 12px 0 6px; }
      #${MODAL_ID} .ep-m-msg { font-size: 14px; line-height: 1.5; opacity: .85; }
      #${MODAL_ID} .ep-m-btn {
        margin-top: 20px; background: #1a73e8; color: #fff; border: 0;
        border-radius: 8px; padding: 12px 22px; font-size: 15px; font-weight: 600; cursor: pointer;
      }
      #${MODAL_ID} .ep-m-btn:hover { background: #1765c1; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- escalating banner ------------------------------------------------

  function ensureBanner() {
    let root = document.getElementById(BANNER_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = BANNER_ID;
    root.innerHTML = `
      <div class="ep-icon">⚠️</div>
      <div class="ep-text">
        <div class="ep-title"></div>
        <div class="ep-detail"></div>
      </div>
      <button class="ep-btn ep-fs" style="display:none">Return to fullscreen</button>
      <button class="ep-btn ep-dismiss">Dismiss</button>
    `;
    (document.body || document.documentElement).appendChild(root);

    root.querySelector(".ep-dismiss").addEventListener("click", hideBanner);
    root.querySelector(".ep-fs").addEventListener("click", () => {
      const el = document.documentElement;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      hideBanner();
    });
    return root;
  }

  function hideBanner() {
    const root = document.getElementById(BANNER_ID);
    if (root) root.remove();
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // ---- blocking modal (fullscreen gate / session ended) -----------------

  function showModal({ kind, icon, title, message, buttonText, onButton }) {
    injectStyle();
    let modal = document.getElementById(MODAL_ID);
    // Once the terminal "ended" overlay is shown, nothing may replace it.
    if (modal && modal.dataset.kind === "ended") return;
    // Same gate already on screen — don't rebuild (avoids flicker on re-checks).
    if (modal && modal.dataset.kind === kind) return;
    if (!modal) {
      modal = document.createElement("div");
      modal.id = MODAL_ID;
      (document.body || document.documentElement).appendChild(modal);
    }
    modal.dataset.kind = kind;
    modal.className = kind === "ended" ? "ep-ended" : "";
    modal.innerHTML = `
      <div class="ep-card">
        <div class="ep-m-icon">${icon}</div>
        <div class="ep-m-title"></div>
        <div class="ep-m-msg"></div>
        ${buttonText ? `<button class="ep-m-btn"></button>` : ""}
      </div>`;
    modal.querySelector(".ep-m-title").textContent = title;
    modal.querySelector(".ep-m-msg").textContent = message;
    if (buttonText) {
      const btn = modal.querySelector(".ep-m-btn");
      btn.textContent = buttonText;
      btn.addEventListener("click", () => { try { onButton && onButton(); } catch (e) {} });
    }
  }

  const ProctorOverlay = {
    /** Escalating warning. strike 1 → auto-hide after 5s; strike ≥ 2 → stays until clicked. */
    warn(type, detail, strike) {
      injectStyle();
      const root = ensureBanner();
      const isFs = /fullscreen/i.test(type || "");
      root.querySelector(".ep-fs").style.display = isFs ? "" : "none";
      root.querySelector(".ep-title").textContent = "Proctor warning: " + type;

      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

      if (strike >= 2) {
        // Second strike: requires an explicit click to acknowledge.
        root.classList.add("ep-severe");
        root.querySelector(".ep-detail").textContent =
          (detail ? detail + " — " : "") +
          "Second warning. One more violation will end your exam. Click to acknowledge.";
      } else {
        // First strike: informational, clears itself after a 5-second window.
        root.classList.remove("ep-severe");
        root.querySelector(".ep-detail").textContent =
          (detail ? detail + " — " : "") + "This activity has been logged. Return to your exam.";
        hideTimer = setTimeout(hideBanner, 5000);
      }
    },

    /** Blocking overlay shown until the student enters fullscreen. */
    gate(onEnter) {
      showModal({
        kind: "gate",
        icon: "🔒",
        title: "Fullscreen required",
        message: "This exam must be taken in fullscreen mode. Click below to enter fullscreen and begin. Leaving fullscreen during the exam will be recorded.",
        buttonText: "Enter fullscreen",
        onButton: () => {
          const el = document.documentElement;
          if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
          if (onEnter) onEnter();
        }
      });
    },

    /** Blocking overlay requiring the (compulsory) Window Management
     *  permission. `denied` switches to site-settings guidance. Not a violation. */
    permGate(onAllow, denied) {
      showModal({
        kind: denied ? "perm-denied" : "perm",
        icon: "🖥️",
        title: "Display permission required",
        message: denied
          ? "Display-management access is blocked. Enable “Window management” for this site in your browser’s site settings, then click Re-check to continue."
          : "This exam requires permission to verify you are using a single screen. Click below and choose Allow to continue.",
        buttonText: denied ? "Re-check" : "Allow display detection",
        onButton: () => { if (onAllow) onAllow(); }
      });
    },

    /** Blocking overlay shown while an extra display is connected.
     *  Not a violation — it clears itself once the display is disconnected. */
    screenGate() {
      showModal({
        kind: "screen",
        icon: "🖥️",
        title: "Additional display detected",
        message: "Only one screen is allowed during this exam. Disconnect any extra monitors or screens to continue. This is not counted as a violation."
      });
    },

    /** Remove any non-terminal gate (fullscreen or screen), but never "ended". */
    clearGate() {
      const modal = document.getElementById(MODAL_ID);
      if (modal && modal.dataset.kind !== "ended") modal.remove();
    },

    /** Terminal blocking overlay when the session is ended by repeated violations. */
    ended(reason) {
      hideBanner();
      showModal({
        kind: "ended",
        icon: "⛔",
        title: "Exam ended",
        message: (reason ? reason + ". " : "") +
          "Your session has been terminated due to repeated violations. Please contact your invigilator."
      });
    },

    hide: hideBanner
  };

  window.ProctorOverlay = ProctorOverlay;
})();
