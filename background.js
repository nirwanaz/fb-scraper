let isAutoCommentCancelled = false;
let isAutoPostCancelled = false;

function safeSendMessage(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
  } catch (e) {
    console.warn('[FB Scraper] safeSendMessage error:', e.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPDATE_BADGE') {
    const count = msg.count;
    chrome.action.setBadgeText({
      text: count > 0 ? count.toString() : ''
    });
    chrome.action.setBadgeBackgroundColor({ color: '#1877f2' });
  }
  
  if (msg.type === 'STOP_AUTO_COMMENT') {
    isAutoCommentCancelled = true;
    console.log('[FB Scraper] Stop requested for Auto Comment');
    return;
  }

  if (msg.type === 'STOP_AUTO_POST') {
    isAutoPostCancelled = true;
    console.log('[FB Scraper] Stop requested for Auto Post');
    return;
  }

  if (msg.type === 'START_AUTO_COMMENT') {
    sendResponse({ success: true });
    const { posts, message, delay } = msg;
    isAutoCommentCancelled = false;
    let log = [];
    let completedCount = 0;
    
    const updateLog = (m, success = true) => {
      log.push({ time: Date.now(), msg: m, success });
      chrome.storage.local.set({ fb_auto_comment_log: log });
      safeSendMessage({ 
        type: 'AUTO_COMMENT_PROGRESS', 
        log, 
        status: `Processing ${completedCount}/${posts.length}` 
      });
    };

    (async () => {
      updateLog(`Starting auto-comment on ${posts.length} posts...`);
      
      for (let i = 0; i < posts.length; i++) {
        completedCount = i + 1; // Update count for status display
        
        if (isAutoCommentCancelled) {
          updateLog('Auto-comment process cancelled by user.', false);
          safeSendMessage({ type: 'AUTO_COMMENT_PROGRESS', log, status: 'Cancelled' });
          return;
        }

        const post = posts[i];
        updateLog(`[${completedCount}/${posts.length}] Navigating to post by ${post.author}...`);
        
        try {
          const tab = await new Promise((resolve, reject) => {
            chrome.tabs.create({ url: post.postUrl, active: false }, (t) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(t);
            });
          });

          // Wait for tab to load
          await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
              if (tabId === tab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });

          // Give it a moment to stabilize
          await new Promise(r => setTimeout(r, 4000)); // Increased wait

          if (isAutoCommentCancelled) {
            chrome.tabs.remove(tab.id);
            updateLog('Auto-comment process cancelled by user.', false);
            safeSendMessage({ type: 'AUTO_COMMENT_PROGRESS', log, status: 'Cancelled' });
            return;
          }

          if (msg.isReplyMode) {
            updateLog(`Analyzing comments for post by ${post.author}...`);
            await new Promise((resolve) => {
              chrome.tabs.sendMessage(tab.id, { type: 'INIT_DEEP_SCRAPE', fbid: post.fbid });
              const completeListener = (m) => {
                if (m.type === 'DEEP_SCRAPE_COMPLETE') {
                  chrome.runtime.onMessage.removeListener(completeListener);
                  resolve();
                }
              };
              chrome.runtime.onMessage.addListener(completeListener);
              setTimeout(resolve, 15000); // 15s timeout
            });
          }

          if (isAutoCommentCancelled) {
            chrome.tabs.remove(tab.id);
            updateLog('Auto-comment process cancelled by user.', false);
            safeSendMessage({ type: 'AUTO_COMMENT_PROGRESS', log, status: 'Cancelled' });
            return;
          }

          // Send comment/reply message (inserts text + tries Enter)
          const response = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { 
              type: 'PERFORM_COMMENT', 
              message: message,
              isReplyMode: msg.isReplyMode,
              keywords: msg.keywords
            }, (res) => {
              resolve(res || { success: false, error: 'No response from tab' });
            });
          });

          // Use chrome.debugger to send a TRUSTED Enter key as backup
          if (response.success && !msg.isReplyMode) {
            try {
              await new Promise((resolve, reject) => {
                chrome.debugger.attach({ tabId: tab.id }, '1.3', () => {
                  if (chrome.runtime.lastError) {
                    console.warn('Debugger attach failed:', chrome.runtime.lastError.message);
                    resolve(); // Don't block on debugger failure
                    return;
                  }
                  
                  // Send trusted Enter key via DevTools Protocol
                  chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
                    type: 'keyDown', key: 'Enter', code: 'Enter',
                    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
                  }, () => {
                    chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
                      type: 'keyUp', key: 'Enter', code: 'Enter',
                      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
                    }, () => {
                      // Wait for comment to be sent, then detach
                      setTimeout(() => {
                        chrome.debugger.detach({ tabId: tab.id }, () => {
                          resolve();
                        });
                      }, 2000);
                    });
                  });
                });
              });
              updateLog(`Trusted Enter key sent via debugger for post ${i+1}`);
            } catch (debugErr) {
              console.warn('Debugger Enter failed:', debugErr.message);
            }
          }

          if (response.success) {
            const type = msg.isReplyMode ? 'reply' : 'comment';
            updateLog(`Success: ${type}ed on post ${i+1}${response.note ? ` (${response.note})` : ''}`);
          } else {
            updateLog(`Failed on post ${i+1}: ${response.error}`, false);
          }

          // Wait a bit then close tab
          await new Promise(r => setTimeout(r, 2000));
          chrome.tabs.remove(tab.id);

        } catch (err) {
          updateLog(`Error processing post ${i+1}: ${err.message}`, false);
        }

        if (i < posts.length - 1) {
          const waitTime = delay + Math.floor(Math.random() * 5);
          updateLog(`Waiting ${waitTime}s before next post...`);
          
          // Chunk the wait so we can cancel during delay
          for (let w = 0; w < waitTime; w++) {
            if (isAutoCommentCancelled) {
              updateLog('Auto-comment process cancelled by user.', false);
              safeSendMessage({ type: 'AUTO_COMMENT_PROGRESS', log, status: 'Cancelled' });
              return;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
      
      updateLog('Auto-comment process completed.');
      safeSendMessage({ type: 'AUTO_COMMENT_PROGRESS', log, status: 'Completed' });
    })();
  }

  if (msg.type === 'START_AUTO_POST') {
    sendResponse({ success: true });
    const { groups: rawGroups, message, delay } = msg;
    
    // Deduplicate groups by ID to prevent double posting to the same group
    const groups = [];
    const seenGroupIds = new Set();
    if (Array.isArray(rawGroups)) {
      rawGroups.forEach(g => {
        const gid = String(g.id);
        if (!seenGroupIds.has(gid)) {
          seenGroupIds.add(gid);
          groups.push(g);
        }
      });
    }

    isAutoPostCancelled = false;
    let log = [];
    let completedCount = 0;
    
    const updateLog = (m, success = true) => {
      log.push({ time: Date.now(), msg: m, success });
      chrome.storage.local.set({ fb_auto_post_log: log });
      safeSendMessage({ 
        type: 'AUTO_POST_PROGRESS', 
        log, 
        status: `Processing ${completedCount}/${groups.length}` 
      });
    };

    (async () => {
      updateLog(`Starting auto-post on ${groups.length} groups...`);
      
      for (let i = 0; i < groups.length; i++) {
        completedCount = i + 1;
        
        if (isAutoPostCancelled) {
          updateLog('Auto-post process cancelled by user.', false);
          safeSendMessage({ type: 'AUTO_POST_PROGRESS', log, status: 'Cancelled' });
          return;
        }

        const group = groups[i];
        updateLog(`[${completedCount}/${groups.length}] Navigating to group "${group.name}"...`);
        
        try {
          const tab = await new Promise((resolve, reject) => {
            chrome.tabs.create({ url: group.url, active: false }, (t) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(t);
            });
          });

          // Wait for tab to load
          await new Promise((resolve) => {
            const listener = (tabId, changeInfo) => {
              if (tabId === tab.id && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });

          // Give it a moment to stabilize
          await new Promise(r => setTimeout(r, 4000));

          if (isAutoPostCancelled) {
            chrome.tabs.remove(tab.id);
            updateLog('Auto-post process cancelled by user.', false);
            safeSendMessage({ type: 'AUTO_POST_PROGRESS', log, status: 'Cancelled' });
            return;
          }

          updateLog(`Creating post on group: "${group.name}"...`);

          // Send post message
          const response = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { 
              type: 'PERFORM_POST', 
              message: message
            }, (res) => {
              resolve(res || { success: false, error: 'No response from tab' });
            });
          });

          if (response.success) {
            updateLog(`Success: Posted to group "${group.name}"`);
          } else {
            updateLog(`Failed on group "${group.name}": ${response.error}`, false);
          }

          // Wait a bit then close tab
          await new Promise(r => setTimeout(r, 2000));
          chrome.tabs.remove(tab.id);

        } catch (err) {
          updateLog(`Error processing group "${group.name}": ${err.message}`, false);
        }

        if (i < groups.length - 1) {
          const waitTime = delay + Math.floor(Math.random() * 5);
          updateLog(`Waiting ${waitTime}s before next group...`);
          
          for (let w = 0; w < waitTime; w++) {
            if (isAutoPostCancelled) {
              updateLog('Auto-post process cancelled by user.', false);
              safeSendMessage({ type: 'AUTO_POST_PROGRESS', log, status: 'Cancelled' });
              return;
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
      
      updateLog('Auto-post process completed.');
      safeSendMessage({ type: 'AUTO_POST_PROGRESS', log, status: 'Completed' });
    })();
  }

  if (msg.type === 'START_DEEP_SCRAPE') {
    const { url, fbid } = msg;
    chrome.storage.local.set({ 
      pending_deep_scrape: { fbid: fbid, url: url, timestamp: Date.now() } 
    }, () => {
      chrome.tabs.create({ url: url, active: false }, (tab) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
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
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId) chrome.tabs.remove(tabId);
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
    const count = result.fb_intercepted_posts ? result.fb_intercepted_posts.length : 0;
    chrome.action.setBadgeText({
      text: count > 0 ? count.toString() : ''
    });
  });
});