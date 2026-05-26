(function() {
  if (window.hasFBScraperScriptInjected) {
    console.log('[FB Scraper] Content script already active on this page. Avoiding double injection.');
    return;
  }
  window.hasFBScraperScriptInjected = true;

  // Global storage for intercepted posts
  let interceptedPosts = [];
  let discoveredGroups = [];

// Load existing data from storage on init
chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
  if (result.fb_intercepted_posts) {
    interceptedPosts = result.fb_intercepted_posts;
  }
});

// Inject the interception script
function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

injectScript();

function safeSendMessage(message) {
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[FB Scraper] safeSendMessage error:', e.message);
  }
}

// Helper to update badge (shows sum of posts and new groups)
function updateBadge(count) {
  safeSendMessage({ type: 'UPDATE_BADGE', count: count });
}

// --- Lexical Editor Helpers for Auto Comment ---

/**
 * Insert text into Facebook's Lexical Editor using execCommand.
 * 
 * KEY INSIGHT: Lexical listens to trusted 'beforeinput' events.
 * document.execCommand('insertText') is the ONLY way to generate
 * trusted beforeinput events from a content script.
 * Direct DOM manipulation breaks Lexical's internal state.
 */
async function insertTextIntoLexical(editor, text) {
  editor.focus();
  await new Promise(r => setTimeout(r, 500));

  // Step 1: Select all existing content and delete it
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  await new Promise(r => setTimeout(r, 200));
  
  // Step 2: Try Clipboard Paste simulation first, as it preserves newlines and formatting natively in Lexical
  console.log('[FB Scraper] Simulating clipboard paste to preserve paragraphs...');
  editor.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt
  });
  editor.dispatchEvent(pasteEvent);
  
  await new Promise(r => setTimeout(r, 500));
  
  // Step 3: Verify if paste was successful
  let content = (editor.innerText || editor.textContent || '').trim();
  console.log('[FB Scraper] Editor content after paste:', content.substring(0, 80));
  
  // Step 4: Fallback to execCommand line-by-line if paste failed
  if (content.length === 0) {
    console.warn('[FB Scraper] Paste failed, trying execCommand...');
    const lines = text.split('\n');
    let inserted = true;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        inserted = inserted && document.execCommand('insertText', false, lines[i]);
      }
      if (i < lines.length - 1) {
        inserted = inserted && document.execCommand('insertLineBreak');
      }
    }
    await new Promise(r => setTimeout(r, 500));
    content = (editor.innerText || editor.textContent || '').trim();
    console.log('[FB Scraper] Editor content after execCommand:', content.substring(0, 80));
  }
  
  // Step 5: Last resort - Direct DOM manipulation
  if (content.length === 0) {
    console.warn('[FB Scraper] Both paste and execCommand failed, trying direct DOM + input event...');
    let p = editor.querySelector('p');
    if (p) {
      p.textContent = text;
    } else {
      editor.textContent = text;
    }
    
    // Dispatch input event to notify editor framework
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: text
    }));
  }
  
  return content.length > 0;
}

/**
 * Press Enter to send a comment in Facebook's Lexical Editor.
 * Uses page-context script injection to interact with the editor.
 * Also tries dispatching events directly as fallback.
 */
async function pressEnterToSend(editor) {
  editor.focus();
  await new Promise(r => setTimeout(r, 200));
  
  // Approach 1: Use execCommand insertParagraph — this triggers 
  // a trusted beforeinput event with inputType 'insertParagraph'
  // which Lexical's comment plugin interprets as "submit comment"
  // (Facebook overrides paragraph insertion to mean "send")
  
  // But first, try direct keyboard events from page context
  try {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        const el = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]:focus, div[contenteditable="true"][role="textbox"]:focus');
        if (el) {
          el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
          el.dispatchEvent(new KeyboardEvent('keypress', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
          el.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.log('[FB Scraper] Enter key dispatched via page-context injection.');
  } catch (e) {
    console.warn('[FB Scraper] Page injection failed:', e.message);
  }
  
  await new Promise(r => setTimeout(r, 500));
  
  // Approach 2: Also dispatch directly from content script
  const eventOpts = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true
  };
  editor.dispatchEvent(new KeyboardEvent('keydown', eventOpts));
  editor.dispatchEvent(new KeyboardEvent('keypress', eventOpts));
  editor.dispatchEvent(new KeyboardEvent('keyup', eventOpts));
  
  console.log('[FB Scraper] Enter key also dispatched from content script.');
}

// Deep Scrape State
let isDeepScraping = false;
let deepScrapeFbid = null;
let deepScrapeClickCount = 0;
let deepScrapeEmptyRetries = 0;
const MAX_DEEP_CLICKS = 9999; // Set to very high to scrape all comments
const MAX_EMPTY_RETRIES = 10;

chrome.storage.local.get(['pending_deep_scrape'], (result) => {
  const pending = result.pending_deep_scrape;
  if (pending && (Date.now() - pending.timestamp < 60000)) { // Valid for 60s
    isDeepScraping = true;
    deepScrapeFbid = pending.fbid;
    deepScrapeClickCount = 0;
    deepScrapeEmptyRetries = 0;
    console.log('[FB Scraper] Early Deep Scrape Init for FBID:', deepScrapeFbid);
    
    // Clear pending state
    chrome.storage.local.remove('pending_deep_scrape');
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'INIT_DEEP_SCRAPE') {
    isDeepScraping = true;
    deepScrapeFbid = msg.fbid;
    deepScrapeClickCount = 0;
    deepScrapeEmptyRetries = 0;
    console.log('[FB Scraper] Deep Scrape Message Received for FBID:', deepScrapeFbid);
    startDeepAutoClicker();
  }
});

function startDeepAutoClicker() {
  if (!isDeepScraping) return;
  
  console.log(`[FB Scraper] Running Auto-Clicker Loop. Clicks: ${deepScrapeClickCount}, Retries: ${deepScrapeEmptyRetries}`);

  // 1. Robust Scrolling (Find and scroll any large scrollable container, e.g. modal dialogs)
  const scrollableElements = Array.from(document.querySelectorAll('*')).filter(el => {
    // Find elements that are scrollable (have more content than height) and are reasonably large
    return el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200;
  });
  
  if (scrollableElements.length > 0) {
    scrollableElements.forEach(el => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
  }
  
  // Fallback to window scroll
  window.scrollTo(0, document.body.scrollHeight);

  // 2. Handle "Most Relevant" dropdown (Improved with Polling)
  if (deepScrapeClickCount < 3) {
    const filterButton = Array.from(document.querySelectorAll('[role="button"]')).find(btn => {
      const text = (btn.innerText || '').toLowerCase();
      return text.includes('paling relevan') || text.includes('most relevant') || text.includes('terkait');
    });

    if (filterButton && filterButton.getAttribute('aria-expanded') !== 'true') {
      console.log('[FB Scraper] Found relevance filter. Opening menu...');
      filterButton.click();
      
      let menuAttempts = 0;
      const menuInterval = setInterval(() => {
        const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="button"]'));
        const allCommentsOption = menuItems.find(item => {
          const text = (item.innerText || '').toLowerCase();
          return text.includes('all comments') || text.includes('semua komentar') || text.includes('terbaru') || text.includes('newest') || text.includes('oldest');
        });

        if (allCommentsOption) {
          console.log('[FB Scraper] Selecting "All Comments" option');
          allCommentsOption.click();
          clearInterval(menuInterval);
        }
        if (++menuAttempts > 15) clearInterval(menuInterval);
      }, 300);
    }
  }

  // 3. Find "View more comments/replies" buttons
  const keywords = [
    'view more', 'lihat komentar', 'lihat balasan', 'see more', 'tampilkan', 
    'sebelumnya', 'previous', 'lainnya', 'replies', 'balasan', 'more comments'
  ];
  
  const buttons = Array.from(document.querySelectorAll('[role="button"]')).filter(btn => {
    const text = (btn.innerText || '').toLowerCase().trim();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    
    if (!text && !ariaLabel) return false;
    
    const isMatch = keywords.some(kw => text.includes(kw) || ariaLabel.includes(kw));
    const hasNumbers = /\d+/.test(text) || /\d+/.test(ariaLabel);
    
    const isExcluded = text.includes('share') || text.includes('bagikan') || 
                       text.includes('like') || text.includes('suka') ||
                       text.includes('paling relevan') || text.includes('most relevant');
    
    // Ignore buttons that have been clicked repeatedly without disappearing
    const clickCount = parseInt(btn.getAttribute('data-scraped-clicks') || '0');
    if (clickCount >= 3) return false;
    
    return (isMatch || (hasNumbers && (text.includes('reply') || text.includes('balasan')))) && !isExcluded;
  });

  console.log(`[FB Scraper] Found ${buttons.length} potential load-more buttons.`);

  if (buttons.length > 0 && deepScrapeClickCount < MAX_DEEP_CLICKS) {
    deepScrapeClickCount++;
    deepScrapeEmptyRetries = 0; 
    
    // Pick the last button (often the most bottom "view more" or "replies")
    const targetButton = buttons[buttons.length - 1];
    console.log(`[FB Scraper] Clicking button: "${(targetButton.innerText || targetButton.getAttribute('aria-label') || 'unnamed').substring(0, 40)}..."`);
    
    // Increment click counter on this specific button to prevent infinite loops if broken
    const currentClicks = parseInt(targetButton.getAttribute('data-scraped-clicks') || '0');
    targetButton.setAttribute('data-scraped-clicks', currentClicks + 1);
    
    targetButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
      targetButton.click();
      const delay = Math.floor(Math.random() * 1500) + 2000; // 2s - 3.5s
      setTimeout(startDeepAutoClicker, delay);
    }, 800);
  } else {
    deepScrapeEmptyRetries++;
    if (deepScrapeEmptyRetries <= MAX_EMPTY_RETRIES) {
      console.log(`[FB Scraper] No buttons found. Retrying in 2.5s... (${deepScrapeEmptyRetries}/${MAX_EMPTY_RETRIES})`);
      setTimeout(startDeepAutoClicker, 2500);
    } else {
      console.log('[FB Scraper] Deep Scrape Completed (Limit or End reached).');
      isDeepScraping = false;
      safeSendMessage({ type: 'DEEP_SCRAPE_COMPLETE' });
    }
  }
}

// Load existing data from storage on start
chrome.storage.local.get(['fb_intercepted_posts', 'fb_discovered_groups'], (result) => {
  if (result.fb_intercepted_posts) {
    interceptedPosts = result.fb_intercepted_posts;
  }
  if (result.fb_discovered_groups) {
    discoveredGroups = result.fb_discovered_groups;
  }
  
  // Backfill discovery: ensure all groups from posts are in discoveredGroups
  let backfilled = false;
  interceptedPosts.forEach(post => {
    if (post.groupId && post.groupName && !discoveredGroups.find(g => g.id === post.groupId)) {
      discoveredGroups.push({
        id: post.groupId,
        name: post.groupName,
        url: `https://www.facebook.com/groups/${post.groupId}/`,
        memberCount: 0,
        postsPerDay: 0,
        score: '⭐ Linked from Post',
        scoreColor: '#3b82f6',
        discoveredAt: new Date().toISOString()
      });
      backfilled = true;
    }
  });

  if (backfilled) {
    chrome.storage.local.set({ fb_discovered_groups: discoveredGroups });
  }

  updateBadge(interceptedPosts.length + discoveredGroups.length);
});



// Listen for messages from the injected script
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'FB_GRAPHQL_DATA') {
    return;
  }

  const rawData = event.data.data;

  // --- Deep Scrape Interception ---
  if (isDeepScraping && deepScrapeFbid) {
    let newComments = []; 
    function findCommentsDeep(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.__typename === 'Comment' && obj.body && obj.body.text) {
        newComments.push({
          text: obj.body.text.trim(),
          id: obj.id || obj.legacy_fbid
        });
      }
      for (const k in obj) {
        if (Array.isArray(obj[k])) {
          obj[k].forEach(findCommentsDeep);
        } else if (typeof obj[k] === 'object') {
          findCommentsDeep(obj[k]);
        }
      }
    }
    findCommentsDeep(rawData);
    
    if (newComments.length > 0) {
      chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
        let posts = result.fb_intercepted_posts || [];
        let postIndex = posts.findIndex(p => String(p.fbid) === String(deepScrapeFbid));
        
        if (postIndex !== -1) {
          let currentText = posts[postIndex].commentsText || '';
          let addedCount = 0;
          
          newComments.forEach(nc => {
            // Better check: don't add if the exact text is already there
            // We use a slightly more robust check than just .includes
            const cleanText = nc.text;
            if (cleanText && !currentText.includes(cleanText)) {
              currentText += (currentText ? ' | ' : '') + cleanText;
              addedCount++;
            }
          });
          
          if (addedCount > 0) {
            posts[postIndex].commentsText = currentText.substring(0, 50000); 
            posts[postIndex].lastUpdated = new Date().toISOString();
            
            chrome.storage.local.get(['fb_discovered_groups'], (groupsResult) => {
              chrome.storage.local.set({ fb_intercepted_posts: posts }, () => {
                console.log(`[FB Scraper] Deep Scrape: Added ${addedCount} new comments.`);
                
                // Notify popup of the update
                safeSendMessage({ 
                  type: 'DATA_UPDATED', 
                  posts: posts,
                  groups: groupsResult.fb_discovered_groups || []
                });
              });
            });
          }
        }
      });
    }
    return; 
  }
  // --- End Deep Scrape Interception ---

  const { posts, groups } = parseGraphQL(rawData);
  
  let newFound = false;

  if (posts && posts.length > 0) {
    posts.forEach(post => {
      const existingIndex = interceptedPosts.findIndex(p => p.fbid === post.fbid);
      if (existingIndex === -1) {
        interceptedPosts.push(post);
        newFound = true;
        console.log(`%c 📥 Post Captured: ${post.author}`, 'color: #1877f2; font-weight: bold;');
      } else {
        // Update stats if they are higher (fresher data)
        const existing = interceptedPosts[existingIndex];
        const hasNewStats = post.likes > existing.likes || 
                           post.comments > existing.comments || 
                           post.shares > existing.shares;
        
        if (hasNewStats) {
          interceptedPosts[existingIndex] = { 
            ...existing, 
            ...post,
            lastUpdated: new Date().toISOString() 
          };
          newFound = true;
          console.log(`%c 🔄 Post Stats Updated: ${post.author}`, 'color: #0ea5e9; font-style: italic;');
        }
      }
    });
  }

  if (newFound) {
    if (!chrome.runtime || !chrome.runtime.id) {
      console.warn('[FB Scraper] Extension context invalidated. Please refresh the page.');
      return;
    }

    chrome.storage.local.set({ 
      fb_intercepted_posts: interceptedPosts
    });
    updateBadge(interceptedPosts.length);

    safeSendMessage({ 
      type: 'DATA_UPDATED', 
      posts: interceptedPosts
    });
  }
});

// --- Auto Post Group Helpers ---

function findPostTrigger() {
  const keywords = [
    'write something', 'tulis sesuatu', 'create a public post', 
    'buat postingan publik', 'what\'s on your mind', 'apa yang anda pikirkan',
    'buat postingan', 'write something...'
  ];
  
  // Search elements with role="button" first
  const buttons = Array.from(document.querySelectorAll('[role="button"], [role="link"], [role="presentation"]'));
  for (const btn of buttons) {
    const text = (btn.innerText || '').toLowerCase().trim();
    if (keywords.some(kw => text.includes(kw))) {
      console.log('[FB Scraper] Found trigger by role button/link:', text);
      return btn;
    }
  }
  
  // Fallback: search all spans or divs containing these keywords
  const elements = Array.from(document.querySelectorAll('span, div'));
  for (const el of elements) {
    if (el.children.length === 0) { // leaf elements
      const text = (el.innerText || el.textContent || '').toLowerCase().trim();
      if (keywords.some(kw => text === kw || text === kw + '...')) {
        let clickable = el;
        while (clickable && clickable !== document.body) {
          const role = clickable.getAttribute('role');
          if (role === 'button' || clickable.tagName === 'BUTTON') {
            console.log('[FB Scraper] Found trigger ancestor:', role || clickable.tagName);
            return clickable;
          }
          clickable = clickable.parentElement;
        }
        console.log('[FB Scraper] Found trigger leaf:', text);
        return el;
      }
    }
  }
  return null;
}

function findPostEditor() {
  // Check inside active dialogs first
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  for (const dialog of dialogs) {
    let editor = dialog.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
    if (!editor) editor = dialog.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!editor) editor = dialog.querySelector('div[contenteditable="true"]');
    if (editor) {
      console.log('[FB Scraper] Found editor inside active dialog');
      return editor;
    }
  }
  
  // Fallback: check globally
  let editor = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
  if (!editor) editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!editor) {
    editor = Array.from(document.querySelectorAll('div[contenteditable="true"]')).find(el => el.offsetParent !== null);
  }
  if (editor) {
    console.log('[FB Scraper] Found editor globally');
  }
  return editor;
}

function findPostButton() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  const keywords = ['post', 'posting', 'kirim', 'publish', 'bagikan', 'share'];
  
  for (const dialog of dialogs) {
    // Search all buttons or divs with role="button" inside the dialog
    const buttons = Array.from(dialog.querySelectorAll('[role="button"], button, [type="submit"]'));
    for (const btn of buttons) {
      const text = (btn.innerText || '').toLowerCase().trim();
      if (keywords.includes(text)) {
        console.log('[FB Scraper] Found post button inside dialog:', text);
        return btn;
      }
    }
  }
  
  // Fallback: check globally
  const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
  for (const btn of buttons) {
    const text = (btn.innerText || '').toLowerCase().trim();
    if (keywords.includes(text) && btn.offsetParent !== null) {
      console.log('[FB Scraper] Found post button globally:', text);
      return btn;
    }
  }
  
  return null;
}

function clickElement(el) {
  if (!el) return;
  console.log('[FB Scraper] Clicking element:', el.tagName || el.getAttribute('role'));
  el.focus();
  
  // Single click is sufficient and prevents double submissions
  el.click();
}

// Listener for popup messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PERFORM_POST') {
    (async () => {
      try {
        console.log('[FB Scraper] Performing auto-post...');
        
        // Step 1: Find post trigger
        const trigger = findPostTrigger();
        if (!trigger) {
          sendResponse({ success: false, error: 'Could not find "Write something..." trigger box on page' });
          return;
        }

        // Step 2: Click trigger to open editor dialog
        clickElement(trigger);
        await new Promise(r => setTimeout(r, 3000));

        // Step 3: Find the editor
        const editor = findPostEditor();
        if (!editor) {
          sendResponse({ success: false, error: 'Could not find editor box after clicking trigger' });
          return;
        }

        // Step 4: Fill editor with message
        await insertTextIntoLexical(editor, msg.message);
        await new Promise(r => setTimeout(r, 2000)); // wait for button to become active

        // Step 5: Find post button
        const postBtn = findPostButton();
        if (!postBtn) {
          sendResponse({ success: false, error: 'Could not find "Post" or "Posting" button' });
          return;
        }

        // Step 6: Click post button
        clickElement(postBtn);
        await new Promise(r => setTimeout(r, 4000)); // wait for upload/submit
        
        sendResponse({ success: true });

      } catch (err) {
        console.error('[FB Scraper] Auto Post Error:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep message channel open
  }

  if (msg.type === 'PERFORM_COMMENT') {
    (async () => {
      try {
        console.log(`[FB Scraper] Attempting to perform auto-${msg.isReplyMode ? 'reply' : 'comment'}...`);
        
        if (msg.isReplyMode && msg.keywords) {
          // --- AUTO REPLY LOGIC ---
          const keywords = msg.keywords.map(k => k.toLowerCase());
          // Fix: Find all "Reply" buttons first, then check their container for keywords.
          // Facebook's DOM changes often, and role="article" is not always used (especially in dialogs).
          const replyButtons = Array.from(document.querySelectorAll('[role="button"], [role="link"], a')).filter(b => {
            const t = (b.innerText || '').toLowerCase().trim();
            return t === 'reply' || t === 'balas' || t === 'jawab' || t === 'balasan';
          });
          
          let repliesCount = 0;
          for (const replyBtn of replyButtons) {
            // Traverse up to find the comment container (approx 6-10 levels up)
            let container = replyBtn;
            for(let i=0; i<8; i++) {
              if (container.parentElement) container = container.parentElement;
            }
            
            const text = (container.innerText || '').toLowerCase();
            const hasKeyword = keywords.some(k => text.includes(k.toLowerCase()));
            
            if (hasKeyword) {
              console.log('[FB Scraper] Found matching comment for reply.');
              if (replyBtn) {
                replyBtn.click();
                await new Promise(r => setTimeout(r, 2500));
                
                // Find the Lexical reply editor that appeared
                let replyBox = container.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
                if (!replyBox) {
                  replyBox = container.querySelector('div[contenteditable="true"][role="textbox"]');
                }
                if (!replyBox) {
                  // Try document-wide as fallback, sometimes reply box is appended elsewhere
                  replyBox = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]:focus');
                }
                if (!replyBox) {
                  // Check active element
                  const active = document.activeElement;
                  if (active && (active.getAttribute('contenteditable') === 'true' || active.getAttribute('role') === 'textbox')) {
                    replyBox = active;
                  }
                }

                if (replyBox) {
                  // Insert text using Lexical-compatible method
                  await insertTextIntoLexical(replyBox, msg.message);
                  await new Promise(r => setTimeout(r, 1000));
                  
                  // Send via Enter key (Facebook has no Send button)
                  pressEnterToSend(replyBox);
                  repliesCount++;
                  await new Promise(r => setTimeout(r, 2500));
                }
              }
            }
          }
          
          sendResponse({ success: true, note: `Replied to ${repliesCount} matching comments` });
          return;
        }

        // --- STANDARD AUTO COMMENT LOGIC ---
        
        // Step 1: Find Lexical comment editor
        let commentBox = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
        
        if (!commentBox) {
          commentBox = document.querySelector('div[contenteditable="true"][role="textbox"]');
        }

        // Step 2: If not found, click "Leave a comment" button to activate it
        if (!commentBox) {
          console.log('[FB Scraper] Comment box not visible, clicking Leave a comment...');
          const leaveCommentBtn = document.querySelector('div[aria-label="Leave a comment"][role="button"]');
          if (leaveCommentBtn) {
            leaveCommentBtn.click();
            await new Promise(r => setTimeout(r, 2500));
            commentBox = document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]');
            if (!commentBox) {
              commentBox = document.querySelector('div[contenteditable="true"][role="textbox"]');
            }
          }
        }

        // Step 3: Try aria-label pattern
        if (!commentBox) {
          console.log('[FB Scraper] Trying aria-label selectors...');
          commentBox = document.querySelector('div[aria-label^="Comment as"][contenteditable="true"]');
          if (!commentBox) {
            commentBox = document.querySelector('div[aria-label*="comment"][contenteditable="true"]');
          }
          if (!commentBox) {
            commentBox = document.querySelector('div[aria-label*="komentar"][contenteditable="true"]');
          }
        }

        // Step 4: Last resort — any visible contenteditable
        if (!commentBox) {
          console.log('[FB Scraper] Last resort: searching any visible contenteditable...');
          commentBox = Array.from(document.querySelectorAll('div[contenteditable="true"]')).find(el => {
            return el.offsetParent !== null && el.getAttribute('data-lexical-editor') === 'true';
          });
          if (!commentBox) {
            commentBox = Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]')).find(el => el.offsetParent !== null);
          }
        }

        if (!commentBox) {
          sendResponse({ success: false, error: 'Lexical comment editor not found after all attempts' });
          return;
        }

        console.log('[FB Scraper] Found comment box:', commentBox.getAttribute('aria-label') || 'no label');

        // Step 5: Insert text using Lexical-compatible method
        await insertTextIntoLexical(commentBox, msg.message);
        await new Promise(r => setTimeout(r, 1500));

        // Step 6: Verify text was inserted
        const currentText = (commentBox.innerText || commentBox.textContent || '').trim();
        if (currentText.length === 0) {
          console.warn('[FB Scraper] First insertion failed, retrying with execCommand...');
          commentBox.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, msg.message);
          await new Promise(r => setTimeout(r, 1000));
        }

        // Step 7: Send via Enter (Facebook has NO send button for comments)
        console.log('[FB Scraper] Sending comment via Enter key...');
        pressEnterToSend(commentBox);
        await new Promise(r => setTimeout(r, 2500));
        
        sendResponse({ success: true, note: 'Sent via Enter key (Lexical editor)' });

      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  if (msg.type === 'START_SCRAPE') {
    const targetLimit = msg.targetLimit || null;
    autoScroll(targetLimit, (result) => {
      sendResponse({
        posts: interceptedPosts,
        groups: discoveredGroups,
        scrapedAt: new Date().toISOString()
      });
    });
    return true; // Keep channel open for async response
  }
  
  if (msg.type === 'GET_CURRENT_DATA') {
    sendResponse({ posts: interceptedPosts, groups: discoveredGroups });
  }

  if (msg.type === 'CLEAR_DATA') {
    interceptedPosts = [];
    discoveredGroups = [];
    chrome.storage.local.set({ fb_intercepted_posts: [], fb_discovered_groups: [] });
    updateBadge(0);
    sendResponse({ success: true });
  }
});



/**
 * Recursively search for story-like objects in GraphQL response
 */
function parseGraphQL(obj) {
  const posts = [];
  const groups = [];
  
  function findStories(current) {
    if (!current || typeof current !== 'object') return;

    if (current.__typename === 'Story' || current.comet_sections || (current.message && current.actors)) {
      const post = extractPostFromStory(current);
      if (post) posts.push(post);
      return;
    }

    for (const key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        if (Array.isArray(current[key])) {
          current[key].forEach(item => findStories(item));
        } else {
          findStories(current[key]);
        }
      }
    }
  }

  function findGroups(current) {
    if (!current || typeof current !== 'object') return;

    // Search for Group objects in search results
    if (current.__typename === 'Group' && current.id && current.name) {
      const group = extractGroupDiscovery(current);
      if (group) groups.push(group);
      return;
    }

    for (const key in current) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        if (Array.isArray(current[key])) {
          current[key].forEach(item => findGroups(item));
        } else {
          findGroups(current[key]);
        }
      }
    }
  }

  findStories(obj);
  findGroups(obj);
  return { posts, groups };
}

/**
 * Extract group discovery data
 */
function extractGroupDiscovery(node) {
  try {
    const id = node.id;
    const name = node.name;
    const url = node.url || `https://www.facebook.com/groups/${id}`;
    
    return {
      id,
      name,
      url,
      memberCount: 0,
      postsPerDay: 0,
      score: 'Discovery',
      scoreColor: '#94a3b8',
      discoveredAt: new Date().toISOString()
    };
  } catch (e) {
    return null;
  }
}



/**
 * Extract clean data from a Facebook GraphQL Story object
 */
function extractPostFromStory(story) {
  try {
    // Helper to find any key deeply nested in an object
    function findDeep(obj, key) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj[key] !== undefined) return obj[key];
      
      for (const k in obj) {
        const found = findDeep(obj[k], key);
        if (found) return found;
      }
      return null;
    }

    // 1. ID
    const fbid = story.post_id || story.id || (story.feedback && story.feedback.id);
    if (!fbid) return null;

    // 2. Author
    let author = 'Unknown';
    const actor = (story.actors && story.actors[0]) || 
                  (story.comet_sections?.context_layout?.story?.comet_sections?.actor_photo?.story?.actors?.[0]) ||
                  findDeep(story, 'actors')?.[0];
    if (actor) {
      author = actor.name;
    }

    // 3. Text (Main Post)
    let text = '';
    const messageObj = findDeep(story, 'message');
    if (messageObj && messageObj.text) {
      text = messageObj.text;
    } else {
      // Fallback text paths
      text = story.comet_sections?.content?.story?.message?.text || 
             story.comet_sections?.content?.story?.comet_sections?.message?.story?.message?.text || '';
    }

    // Extract Comments Text (if available in payload)
    let commentsTextArray = [];
    function extractComments(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.__typename === 'Comment' && obj.body && obj.body.text) {
        commentsTextArray.push(obj.body.text);
      }
      for (const k in obj) {
        if (Array.isArray(obj[k])) {
          obj[k].forEach(extractComments);
        } else if (typeof obj[k] === 'object') {
          extractComments(obj[k]);
        }
      }
    }
    extractComments(story);
    const commentsText = commentsTextArray.join(' | ');
    
    // Combine main text and comments text for deeper analysis
    const fullText = text + (commentsText ? ` \n[Comments: ${commentsText}]` : '');

    // 4. Stats - Use recursive search for adaptive_ufi_action_renderers
    let likes = 0;
    let comments = 0;
    let shares = 0;

    const renderers = findDeep(story, 'adaptive_ufi_action_renderers');
    
    if (renderers && Array.isArray(renderers)) {
      renderers.forEach(r => {
        if (r.__typename === 'UFIStoryReactActionRenderer') {
          likes = r.feedback?.reaction_count?.count || 0;
        } else if (r.__typename === 'UFICommentActionRenderer') {
          comments = r.feedback?.comment_rendering_instance?.comments?.total_count || 
                     r.feedback?.comment_count?.total_count || 0;
        } else if (r.__typename === 'XFBUFIAdaptiveShareActionRenderer') {
          shares = r.feedback?.share_count?.count || 0;
        }
      });
    }

    // Fallback: search for direct count fields if renderers failed or returned 0
    if (likes === 0 && comments === 0 && shares === 0) {
      const fb = findDeep(story, 'feedback');
      if (fb) {
        likes = fb.reaction_count?.count || fb.reactors?.count || 0;
        comments = fb.comment_count?.total_count || fb.total_comment_count || 0;
        shares = fb.share_count?.count || 0;
      }
    }

    // 5. Group Info
    let groupName = 'Unknown Group';
    let groupId = '';
    
    // Check "to" field (common in Group stories)
    const to = story.to || findDeep(story, 'to');
    if (to && to.__typename === 'Group') {
      groupName = to.name || groupName;
      groupId = to.id || groupId;
    }
    
    // Check "target_group" fallback
    if (groupName === 'Unknown Group') {
      const target = story.target_group || findDeep(story, 'target_group');
      if (target && target.id) {
        groupId = target.id;
        groupName = target.name || findDeep(story, 'group_name') || 'Group ' + groupId;
      }
    }
    
    // Final deep search fallback
    if (groupName === 'Unknown Group') {
      const gName = findDeep(story, 'group_name');
      const gId = findDeep(story, 'group_id');
      if (gName && gId && gName !== author) {
        groupName = gName;
        groupId = gId;
      }
    }

    // 6. Time & URL
    let timestamp = '';
    let postUrl = '';
    
    // Find creation_time
    let creationTime = story.creation_time || findDeep(story, 'creation_time');
    
    if (creationTime) {
      timestamp = new Date(creationTime * 1000).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } else {
      // Fallback to searching metadata
      const metadata = findDeep(story, 'metadata');
      if (Array.isArray(metadata)) {
        const timeMeta = metadata.find(m => m.story?.creation_time);
        if (timeMeta) {
          timestamp = new Date(timeMeta.story.creation_time * 1000).toLocaleString('id-ID', {
            day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
          });
        }
      }
    }
    
    if (fbid && groupId) {
      postUrl = `https://www.facebook.com/groups/${groupId}/posts/${fbid}`;
    } else if (fbid) {
      postUrl = `https://www.facebook.com/${fbid}`;
    }

    // Filter: Only keep posts that have more than 1 interaction (likes + comments + shares)
    const totalEngagement = likes + comments + shares;
    if (totalEngagement <= 1) {
      return null;
    }

    return {
      fbid,
      author,
      groupName,
      groupId,
      text: text.substring(0, 5000), // Main post text
      commentsText: commentsText.substring(0, 10000), // Extracted comments text
      timestamp: timestamp || 'Baru saja',
      createdAt: creationTime || (Date.now() / 1000), // Raw timestamp for sorting
      postUrl,
      likes,
      comments,
      shares,
      scrapedAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('Extraction Error:', err);
    return null;
  }
}


function autoScroll(targetLimit, callback) {
  let scrollAttempts = 0;
  // Increase default depth to capture more posts
  let maxAttempts = targetLimit ? Math.max(30, Math.ceil(targetLimit / 2)) : 15; 
  let initialPosts = interceptedPosts.length;
  
  let lastTotalScrollHeight = 0;
  let unchangedScrollCount = 0;

  const interval = setInterval(() => {
    // Robust scrolling: scroll window and any large scrollable containers (like dialogs)
    window.scrollBy(0, 1500);
    
    let currentTotalScrollHeight = document.body.scrollHeight;
    const scrollableElements = Array.from(document.querySelectorAll('*')).filter(el => {
      return el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200;
    });
    scrollableElements.forEach(el => {
      el.scrollBy(0, 1500);
      el.dispatchEvent(new Event('scroll'));
      currentTotalScrollHeight += el.scrollHeight;
    });
    
    scrollAttempts++;
    
    const currentCount = interceptedPosts.length;
    
    // Stop condition: Hit the absolute bottom (scroll height hasn't changed for 4 attempts)
    if (currentTotalScrollHeight === lastTotalScrollHeight) {
      unchangedScrollCount++;
      if (unchangedScrollCount >= 4) {
        console.log('[FB Scraper] Hit the bottom of the page, stopping scroll early.');
        clearInterval(interval);
        if(callback) callback();
        return;
      }
    } else {
      lastTotalScrollHeight = currentTotalScrollHeight;
      unchangedScrollCount = 0;
    }
    
    // Stop condition: Limit reached
    if (targetLimit && currentCount >= initialPosts + targetLimit) {
      clearInterval(interval);
      if(callback) callback();
      return;
    }

    // Stop condition: Max attempts reached (safety fallback)
    if (scrollAttempts >= maxAttempts) {
      clearInterval(interval);
      if(callback) callback();
      return;
    }
  }, 1500);
}
})();
