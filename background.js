const NAV_LOG_KEY = 'ttmHelperNavLog';
const MAX_NAV_LOG_ENTRIES = 500;

function appendNavEntry(entry) {
  chrome.storage.local.get([NAV_LOG_KEY], (result) => {
    const log = Array.isArray(result[NAV_LOG_KEY]) ? result[NAV_LOG_KEY] : [];
    log.push(entry);
    if (log.length > MAX_NAV_LOG_ENTRIES) {
      log.splice(0, log.length - MAX_NAV_LOG_ENTRIES);
    }
    chrome.storage.local.set({ [NAV_LOG_KEY]: log });
  });
}

const TTM_URL_FILTER = { url: [{ hostSuffix: 'thaiticketmajor.com' }] };

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  appendNavEntry({
    type: 'committed',
    at: new Date(details.timeStamp).toISOString(),
    url: details.url,
    tabId: details.tabId,
    transitionType: details.transitionType,
    qualifiers: (details.transitionQualifiers || []).join(',')
  });
}, TTM_URL_FILTER);

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  appendNavEntry({
    type: 'error',
    at: new Date(details.timeStamp).toISOString(),
    url: details.url,
    tabId: details.tabId,
    error: details.error
  });
}, TTM_URL_FILTER);
