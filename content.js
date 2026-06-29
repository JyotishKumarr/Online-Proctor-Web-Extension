/* Exam Proctor — content script (DOM-level detection + enforcement).
 * Handles events the background worker cannot observe: fullscreen exit,
 * page visibility, copy/cut/paste, right-click, selection/drag, devtools and
 * print/save/find shortcuts, the screenshot key, and a leave-guard. Also keeps
 * the page blocked unless it is in fullscreen. Browser-level events (tab
 * switch, window blur, new tab, tab close) are handled in background.js. */

(function () {
  const L = window.ProctorLogger;
  if (!L) return;

  let attached = false;
  let wasFullscreen = false;
  let gateTimer = null;
  let screenDetails = null; // ScreenDetails from the Window Management API
  let permState = "unknown"; // window-management permission: granted|denied|prompt|unknown
  let permWatched = false;

  // ---- sync active state + settings from background/storage -------------

  function syncState() {
    try {
      chrome.runtime.sendMessage({ cmd: "GET_STATE" }, (state) => {
        if (chrome.runtime.lastError || !state) return;
        L.setActive(state.exam && state.exam.active);
        L.setSettings(state.settings || {});
        if (L.active) { attach(); enforceGates(); }
        else { detach(); if (window.ProctorOverlay) window.ProctorOverlay.clearGate(); }
      });
    } catch (e) { /* context invalidated */ }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.exam || changes.settings) syncState();
  });

  const windowMgmtSupported = () => typeof window.getScreenDetails === "function";

  // True if more than one display is connected. Prefers the accurate Window
  // Management API (ScreenDetails.screens); falls back to screen.isExtended.
  function isExtendedDisplay() {
    try {
      if (screenDetails && Array.isArray(screenDetails.screens)) {
        return screenDetails.screens.length > 1;
      }
      return !!(window.screen && window.screen.isExtended);
    } catch (e) { return false; }
  }

  // The Window Management permission is COMPULSORY on browsers that support the
  // API: until it is granted (and a ScreenDetails obtained) the exam is blocked.
  // Browsers without the API are not hard-blocked — they fall back to the
  // best-effort screen.isExtended check.
  function screenPermRequired() {
    return L.settings.detectSecondScreen !== false && windowMgmtSupported() && !screenDetails;
  }

  // Read the current permission state and watch for changes (e.g. the student
  // toggling it in site settings). Auto-obtains details once granted.
  async function refreshPermState() {
    if (!navigator.permissions) return;
    try {
      const status = await navigator.permissions.query({ name: "window-management" });
      permState = status.state;
      if (!permWatched) {
        permWatched = true;
        status.onchange = () => {
          permState = status.state;
          if (permState === "granted") ensureScreenDetails(false);
          enforceGates();
        };
      }
      if (permState === "granted") await ensureScreenDetails(false);
    } catch (e) { /* permission name unsupported in this browser */ }
  }

  // Obtain a ScreenDetails object. The first grant needs a user gesture, so we
  // only call getScreenDetails() outside a gesture once already granted.
  async function ensureScreenDetails(viaGesture) {
    if (screenDetails || !windowMgmtSupported()) return;
    try {
      if (!viaGesture && permState !== "granted") return; // wait for a gesture
      const sd = await window.getScreenDetails();
      screenDetails = sd;
      permState = "granted";
      sd.addEventListener && sd.addEventListener("screenschange", enforceGates);
      enforceGates();
    } catch (e) {
      // Declined: Chrome remembers the denial, so mark it so the gate can show
      // the "enable it in site settings" guidance.
      permState = "denied";
    }
  }

  // Called from the permission gate's button (a user gesture).
  async function requestScreenPermission() {
    await ensureScreenDetails(true);
    await refreshPermState();
    enforceGates();
  }

  // Decide which blocking gate (if any) the page should show, in priority
  // order. None of these log a violation — they only block until resolved.
  //   1) Window Management permission not granted → must allow it (compulsory)
  //   2) an extra display is connected           → must disconnect it
  //   3) the page is not in fullscreen           → must enter fullscreen
  function enforceGates() {
    if (!L.active || !window.ProctorOverlay) return;
    if (screenPermRequired()) {
      window.ProctorOverlay.permGate(requestScreenPermission, permState === "denied");
    } else if (L.settings.detectSecondScreen !== false && isExtendedDisplay()) {
      window.ProctorOverlay.screenGate();
    } else if (L.settings.detectFullscreenExit && !document.fullscreenElement) {
      window.ProctorOverlay.gate();
    } else {
      window.ProctorOverlay.clearGate();
    }
  }

  // ---- detectors --------------------------------------------------------

  function onFullscreenChange() {
    const isFs = !!document.fullscreenElement;
    if (L.settings.detectFullscreenExit && wasFullscreen && !isFs) {
      L.log("Fullscreen exit", "Exited fullscreen mode");
    }
    wasFullscreen = isFs;
    enforceGates();
  }

  function onVisibilityChange() {
    // Backup signal for tab/window switching when chrome APIs miss it
    // (e.g. minimised window). Only fires when the page becomes hidden.
    if (document.visibilityState === "hidden" && L.settings.detectTabSwitch) {
      L.log("Page hidden", "The exam page was hidden (minimised or switched away)");
    }
  }

  function onCopyPaste(e) {
    if (!L.settings.detectCopyPaste) return;
    const kind = e.type.charAt(0).toUpperCase() + e.type.slice(1);
    L.log(kind, `${kind} action on the exam page`);
    if (L.settings.blockActions) {
      // For copy/cut, also overwrite the clipboard with empty text so the
      // selection can't be lifted off the page.
      if ((e.type === "copy" || e.type === "cut") && e.clipboardData) {
        try { e.clipboardData.setData("text/plain", ""); } catch (_) {}
      }
      e.preventDefault();
    }
  }

  function onContextMenu(e) {
    if (!L.settings.detectContextMenu) return;
    L.log("Right-click", "Context menu opened");
    if (L.settings.blockActions) e.preventDefault();
  }

  // Block text selection and dragging (does not count as a violation).
  function onSelectStart(e) { if (L.settings.blockSelection !== false) e.preventDefault(); }
  function onDragStart(e) { if (L.settings.blockSelection !== false) e.preventDefault(); }

  function onKeyDown(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toUpperCase();

    // Devtools shortcuts
    if (L.settings.detectDevtools &&
        (e.key === "F12" || (ctrl && e.shiftKey && ["I", "J", "C"].includes(k)))) {
      L.log("Devtools", "Attempted to open developer tools");
      if (L.settings.blockActions) e.preventDefault();
      return;
    }

    if (!L.settings.detectShortcuts) return;
    // Print / Save / View-source / Find / Select-all / new window
    if (ctrl && ["P", "S", "U", "F", "A", "N"].includes(k)) {
      L.log("Blocked shortcut", `Ctrl+${e.shiftKey ? "Shift+" : ""}${k}`);
      if (L.settings.blockActions) e.preventDefault();
    }
  }

  function onKeyUp(e) {
    // PrintScreen usually only reports on keyup. We cannot block the OS
    // screenshot, but we log it and best-effort clear the clipboard.
    if (L.settings.detectShortcuts && e.key === "PrintScreen") {
      L.log("Print screen", "Screenshot key pressed");
      try { navigator.clipboard && navigator.clipboard.writeText("").catch(() => {}); } catch (_) {}
    }
  }

  // Leave-guard: native prompt before navigating away or closing the tab.
  function onBeforeUnload(e) {
    if (!L.active || L.settings.warnOnLeave === false) return;
    e.preventDefault();
    e.returnValue = "Leaving the exam will be recorded.";
    return e.returnValue;
  }

  // Best-effort devtools detection via viewport/outer size gap.
  let devtoolsOpen = false;
  function checkDevtools() {
    if (!L.active || !L.settings.detectDevtools) return;
    const threshold = 160;
    const wGap = window.outerWidth - window.innerWidth;
    const hGap = window.outerHeight - window.innerHeight;
    const open = wGap > threshold || hGap > threshold;
    if (open && !devtoolsOpen) L.log("Devtools", "Developer tools appear to be open");
    devtoolsOpen = open;
  }

  // ---- attach / detach --------------------------------------------------

  function attach() {
    if (attached) return;
    attached = true;
    wasFullscreen = !!document.fullscreenElement;
    document.addEventListener("fullscreenchange", onFullscreenChange, true);
    document.addEventListener("visibilitychange", onVisibilityChange, true);
    document.addEventListener("copy", onCopyPaste, true);
    document.addEventListener("cut", onCopyPaste, true);
    document.addEventListener("paste", onCopyPaste, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("beforeunload", onBeforeUnload, true);
    window.addEventListener("resize", checkDevtools, true);
    // Re-evaluate the blocking gates periodically — connecting/disconnecting a
    // display has no reliable DOM event when the Window Management permission
    // is not granted (when it is, the screenschange event drives updates).
    if (!gateTimer) gateTimer = setInterval(enforceGates, 2000);
    // Read the Window Management permission (and obtain details if already
    // granted); the gate enforces it from here.
    refreshPermState();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    document.removeEventListener("fullscreenchange", onFullscreenChange, true);
    document.removeEventListener("visibilitychange", onVisibilityChange, true);
    document.removeEventListener("copy", onCopyPaste, true);
    document.removeEventListener("cut", onCopyPaste, true);
    document.removeEventListener("paste", onCopyPaste, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("selectstart", onSelectStart, true);
    document.removeEventListener("dragstart", onDragStart, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("beforeunload", onBeforeUnload, true);
    window.removeEventListener("resize", checkDevtools, true);
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
  }

  // ---- boot -------------------------------------------------------------
  syncState();
})();
