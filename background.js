chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPDATE_BADGE') {
    const count = msg.count;
    chrome.action.setBadgeText({
      text: count > 0 ? count.toString() : ''
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1877f2' });
  }
  
  if (msg.type === 'START_DEEP_SCRAPE') {
    const { url, fbid } = msg;
    
    // Pre-store state so content script can pick it up immediately on load
    chrome.storage.local.set({ 
      pending_deep_scrape: { fbid: fbid, url: url, timestamp: Date.now() } 
    }, () => {
      chrome.tabs.create({ url: url, active: false }, (tab) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            // Still send the init message as a backup and to trigger the clicker
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { type: 'INIT_DEEP_SCRAPE', fbid: fbid });
            }, 1000);
            chrome.tabs.onUpdated.removeListener(listener);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }

  if (msg.type === 'DEEP_SCRAPE_COMPLETE') {
    // msg.tabId will be sent from content script, or we use sender.tab.id
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) {
      chrome.tabs.remove(tabId);
    }
  }
});

// Persistence check on startup
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
    const count = result.fb_intercepted_posts ? result.fb_intercepted_posts.length : 0;
    chrome.action.setBadgeText({
      text: count > 0 ? count.toString() : ''
    });
  });
});