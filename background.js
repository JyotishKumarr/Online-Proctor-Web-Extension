/* Exam Proctor — background service worker.
 * Single source of truth for exam state, settings and violation log.
 * Watches browser-level events (tab switch, window focus, tab close) that
 * content scripts cannot see, and records DOM-level violations forwarded
 * from content scripts. Monitoring auto-starts when the exam URL loads and
 * auto-ends when the student navigates away or closes the tab. */

/* ============================ CONFIGURATION ============================
 * To deploy on a real exam site:
 *   1. Replace the production prefix below with your exam URL prefix, and
 *      update "matches" + "host_permissions" in manifest.json to match.
 *   2. Remove the localhost test prefix here AND in manifest.json.
 *   3. Tune the strike limit via maxViolations in DEFAULT_SETTINGS below.
 * Only URLs starting with one of these prefixes are proctored.
 * ====================================================================== */
const EXAM_URL_PREFIXES = [
  "https://exams.myschool.com/take/",
  "http://localhost:8000/take/"   // TEST ONLY — remove for production
];
const isExamUrl = (url) =>
  typeof url === "string" && EXAM_URL_PREFIXES.some((p) => url.startsWith(p));

const DEFAULT_SETTINGS = {
  detectFullscreenExit: true,
  detectTabSwitch: true,
  detectWindowBlur: true,
  detectNewTab: true,
  detectCopyPaste: true,
  detectContextMenu: true,
  detectDevtools: true,
  detectShortcuts: true,
  detectSecondScreen: true, // flag when more than one display is connected
  blockActions: true,      // preventDefault on copy/paste/contextmenu/shortcuts
  blockSelection: true,    // block text selection and dragging
  warnOnLeave: true,       // native prompt before navigating away / closing
  showWarnings: true,      // show on-page warning overlay
  notify: true,            // OS notification on violation
  maxViolations: 3         // 3-strike rule: 3rd violation auto-ends the exam
};

const DEFAULT_EXAM = {
  active: false,
  student: "",
  examId: "",
  examTabId: null,
  startedAt: null,
  endedAt: null
};

// ---- storage helpers ---------------------------------------------------

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["exam", "settings", "violations"], (data) => {
      resolve({
        exam: Object.assign({}, DEFAULT_EXAM, data.exam || {}),
        settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
        violations: data.violations || []
      });
    });
  });
}

function setExam(exam) {
  return chrome.storage.local.set({ exam });
}

function setSettings(settings) {
  return chrome.storage.local.set({ settings });
}

function setViolations(violations) {
  return chrome.storage.local.set({ violations });
}

// ---- badge / notifications --------------------------------------------

// No toolbar action in this build (popup removed); badge is a no-op kept so
// existing call sites stay simple.
async function refreshBadge() { /* no toolbar action — nothing to update */ }

function notify(title, message) {
  try {
    chrome.notifications.create("", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2
    });
  } catch (e) { /* notifications may be unavailable */ }
}

// ---- log file (continuous download) -----------------------------------
// Extensions cannot append to a file on disk, so we rewrite the whole log
// and overwrite the same file on every change. The file is auto-saved to
// <Downloads>/exam-proctor-reports/ (extensions can only write under the
// browser's Downloads folder without a save prompt).

function buildReport(exam, violations) {
  return {
    student: exam.student,
    examId: exam.examId,
    startedAt: exam.startedAt ? new Date(exam.startedAt).toISOString() : null,
    endedAt: exam.endedAt ? new Date(exam.endedAt).toISOString() : null,
    endReason: exam.endReason || null,
    totalViolations: violations.length,
    violations: violations.map((v) => ({
      type: v.type,
      detail: v.detail,
      url: v.url,
      time: new Date(v.timestamp).toISOString()
    }))
  };
}

// Stable per-session filename so each write overwrites the same file.
function logFilename(exam) {
  const id = String(exam.examId || "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40) || "exam";
  return `exam-proctor-reports/proctor-log-${id}-${exam.startedAt || 0}.json`;
}

function writeLog(exam, violations) {
  try {
    const json = JSON.stringify(buildReport(exam, violations), null, 2);
    const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    chrome.downloads.download(
      { url, filename: logFilename(exam), conflictAction: "overwrite", saveAs: false },
      () => { void chrome.runtime.lastError; }
    );
  } catch (e) { /* downloads may be unavailable */ }
}

// ---- violation recording ----------------------------------------------

async function recordViolation(type, detail, url) {
  const { exam, settings, violations } = await getState();
  if (!exam.active) return { recorded: false };

  const entry = {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random()),
    type,
    detail: detail || "",
    url: url || "",
    timestamp: Date.now()
  };
  violations.push(entry);
  await setViolations(violations);
  await refreshBadge();
  writeLog(exam, violations);   // continuously rewrite the log file

  if (settings.notify) {
    notify("Exam violation detected", `${type}${detail ? " — " + detail : ""}`);
  }

  // auto-end exam if a violation limit is configured and reached
  let ended = false;
  if (settings.maxViolations > 0 && violations.length >= settings.maxViolations) {
    await endExam("violation-limit");
    notify("Exam ended", `Violation limit (${settings.maxViolations}) reached.`);
    ended = true;
  }
  return { recorded: true, count: violations.length, ended };
}

// ---- exam lifecycle ----------------------------------------------------

async function startExam({ student, examId, examTabId }) {
  const exam = Object.assign({}, DEFAULT_EXAM, {
    active: true,
    student: student || "",
    examId: examId || "",
    examTabId: examTabId ?? null,
    startedAt: Date.now(),
    endedAt: null
  });
  await setViolations([]);
  await setExam(exam);
  await refreshBadge();
  writeLog(exam, []);   // create the log file at session start
  return exam;
}

// Pull optional student / exam identifiers from the exam URL's query string,
// e.g. .../take/?student=Jane%20Doe&examId=MATH101
function identityFromUrl(url) {
  try {
    const q = new URL(url).searchParams;
    return {
      student: q.get("student") || q.get("name") || "",
      examId: q.get("examId") || q.get("exam") || ""
    };
  } catch (e) {
    return { student: "", examId: "" };
  }
}

// Start a session for the exam tab if one isn't already running for it.
async function autoStart(tabId, url) {
  const { exam } = await getState();
  if (exam.active && exam.examTabId === tabId) return; // already proctoring this tab
  const { student, examId } = identityFromUrl(url);
  await startExam({ student, examId, examTabId: tabId });
}

// End the session if the proctored tab leaves the exam URL.
async function autoEndIfLeft(tabId, url) {
  const { exam } = await getState();
  if (exam.active && exam.examTabId === tabId && !isExamUrl(url)) {
    await endExam("left-exam-page");
  }
}

async function endExam(reason) {
  const { exam, violations } = await getState();
  if (!exam.active) return exam;   // already ended — avoid a duplicate final write
  exam.active = false;
  exam.endedAt = Date.now();
  exam.endReason = reason || "manual";
  await setExam(exam);
  await refreshBadge();
  writeLog(exam, violations);      // final write, now including endedAt / endReason
  return exam;
}

// ---- browser-level watchers -------------------------------------------

// Auto-start / auto-end based on the exam tab's URL.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // A navigation to a new URL (matching or not) — may end an active session.
  if (changeInfo.url) await autoEndIfLeft(tabId, changeInfo.url);
  // Page finished loading the exam URL — begin proctoring.
  if (changeInfo.status === "complete" && isExamUrl(tab && tab.url)) {
    await autoStart(tabId, tab.url);
  }
});

// Switching to a different tab than the exam tab.
chrome.tabs.onActivated.addListener(async (info) => {
  const { exam, settings } = await getState();
  if (!exam.active || !settings.detectTabSwitch) return;
  if (exam.examTabId != null && info.tabId !== exam.examTabId) {
    let title = "";
    try { const t = await chrome.tabs.get(info.tabId); title = t.url || t.title || ""; }
    catch (e) { /* tab may be gone */ }
    recordViolation("Tab switch", "Switched away from the exam tab" + (title ? " → " + title : ""), title);
  }
});

// Browser window lost focus (e.g. alt-tabbed to another application).
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const { exam, settings } = await getState();
  if (!exam.active || !settings.detectWindowBlur) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    recordViolation("Window blur", "Browser lost focus (switched to another application)", "");
  }
});

// A brand new tab was opened during the exam.
chrome.tabs.onCreated.addListener(async (tab) => {
  const { exam, settings } = await getState();
  if (!exam.active || !settings.detectNewTab) return;
  recordViolation("New tab", "A new tab was opened during the exam", tab.url || "");
});

// The exam tab itself was closed — record it, then end the session.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { exam } = await getState();
  if (!exam.active) return;
  if (exam.examTabId != null && tabId === exam.examTabId) {
    await recordViolation("Exam tab closed", "The exam tab was closed", "");
    await endExam("exam-tab-closed");
  }
});

// ---- message router ----------------------------------------------------
// Only the content scripts talk to the worker now (no popup/options page).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.cmd) {
      case "GET_STATE": {
        sendResponse(await getState());
        break;
      }
      case "LOG_VIOLATION": {
        const res = await recordViolation(msg.type, msg.detail, msg.url || (sender.tab && sender.tab.url));
        sendResponse(res);
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown command" });
    }
  })();
  return true; // async response
});

// ---- init --------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await setSettings(settings);          // persist defaults
  await setExam(DEFAULT_EXAM);          // ensure clean state
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(refreshBadge);
