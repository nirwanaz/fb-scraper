// Global storage for intercepted posts
let interceptedPosts = [];
let discoveredGroups = [];


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

// Helper to update badge (shows sum of posts and new groups)
function updateBadge(count) {
  if (chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: count }).catch(() => {});
  }
}

// Deep Scrape State
let isDeepScraping = false;
let deepScrapeFbid = null;
let deepScrapeClickCount = 0;
let deepScrapeEmptyRetries = 0;
const MAX_DEEP_CLICKS = 30;
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

  // 1. Robust Scrolling
  const dialog = document.querySelector('[role="dialog"]');
  if (dialog) {
    console.log('[FB Scraper] Scrolling dialog...');
    dialog.scrollTop += 800;
  } else {
    window.scrollBy(0, 800);
    document.documentElement.scrollTop += 800;
  }

  // 2. Find "View more comments" buttons
  const keywords = ['view more', 'lihat komentar', 'lihat balasan', 'see more', 'tampilkan', 'sebelumnya', 'previous', 'lainnya'];
  
  // Back to basics: look for role="button" containing keywords
  const buttons = Array.from(document.querySelectorAll('[role="button"]')).filter(btn => {
    const text = (btn.innerText || '').toLowerCase().trim();
    if (!text) return false;
    
    const isMatch = keywords.some(kw => text.includes(kw));
    const isExcluded = text.includes('share') || text.includes('bagikan');
    
    return isMatch && !isExcluded;
  });

  console.log(`[FB Scraper] Found ${buttons.length} potential load-more buttons.`);

  if (buttons.length > 0 && deepScrapeClickCount < MAX_DEEP_CLICKS) {
    deepScrapeClickCount++;
    deepScrapeEmptyRetries = 0; // Reset retries since we found a button
    
    const targetButton = buttons[0];
    console.log(`[FB Scraper] Clicking button: "${targetButton.innerText.substring(0, 40)}..."`);
    targetButton.click();
    
    // Random delay between 2-5 seconds
    const delay = Math.floor(Math.random() * 3000) + 2000;
    setTimeout(startDeepAutoClicker, delay);
  } else {
    // If no buttons found, it might still be loading or we reached the end
    deepScrapeEmptyRetries++;
    if (deepScrapeEmptyRetries <= MAX_EMPTY_RETRIES) {
      console.log(`[FB Scraper] No buttons found. Retrying in 2s... (${deepScrapeEmptyRetries}/${MAX_EMPTY_RETRIES})`);
      setTimeout(startDeepAutoClicker, 2000);
    } else {
      console.log('[FB Scraper] Deep Scrape Completed (Limit or End reached).');
      isDeepScraping = false;
      chrome.runtime.sendMessage({ type: 'DEEP_SCRAPE_COMPLETE' }).catch(() => {});
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
    let newCommentsText = [];
    function findCommentsDeep(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (obj.__typename === 'Comment' && obj.body && obj.body.text) {
        newCommentsText.push(obj.body.text);
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
    
    if (newCommentsText.length > 0) {
      console.log('[FB Scraper] Intercepted comments:', newCommentsText.length);
      chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
        let posts = result.fb_intercepted_posts || [];
        // Robust comparison: convert both to String
        let postIndex = posts.findIndex(p => String(p.fbid) === String(deepScrapeFbid));
        
        if (postIndex !== -1) {
          const appendedText = newCommentsText.join(' | ');
          const currentText = posts[postIndex].commentsText || '';
          
          // Only append if not already there (rudimentary deduplication)
          if (!currentText.includes(newCommentsText[0].substring(0, 20))) {
            posts[postIndex].commentsText = currentText + ' | ' + appendedText;
            posts[postIndex].commentsText = posts[postIndex].commentsText.substring(0, 25000); // Increased limit
            chrome.storage.local.set({ fb_intercepted_posts: posts }, () => {
              console.log('[FB Scraper] Storage updated with new comments.');
            });
          }
        } else {
          console.warn('[FB Scraper] Could not find post in storage with FBID:', deepScrapeFbid);
        }
      });
    }
    return; // Don't process as a feed if we are deep scraping
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

      // Live Discovery: also add group to discoveredGroups if not already there
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
        newFound = true;
        console.log(`%c 🔍 Group Discovered from Post: ${post.groupName}`, 'color: #3b82f6; font-weight: bold;');
      }
    });
  }

  if (groups && groups.length > 0) {
    groups.forEach(group => {
      if (!discoveredGroups.find(g => g.id === group.id)) {
        discoveredGroups.push(group);
        newFound = true;
        console.log(`%c 🔍 Group Discovered: ${group.name}`, 'color: #22c55e; font-weight: bold;');
      }
    });
  }

  if (newFound) {
    chrome.storage.local.set({ 
      fb_intercepted_posts: interceptedPosts,
      fb_discovered_groups: discoveredGroups
    });
    updateBadge(interceptedPosts.length + discoveredGroups.length);

    chrome.runtime.sendMessage({ 
      type: 'DATA_UPDATED', 
      posts: interceptedPosts,
      groups: discoveredGroups
    }).catch(() => {});
  }
});



// Listener for popup messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    
    // Extract metadata (members and activity)
    let memberCount = 0;
    let postsPerDay = 0;
    
    // Helper to find strings in nested objects
    function findMetadataStrings(obj, results = []) {
      if (!obj || typeof obj !== 'object') return results;
      if (typeof obj.text === 'string') results.push(obj.text);
      if (typeof obj === 'string') results.push(obj);
      
      for (const key in obj) {
        findMetadataStrings(obj[key], results);
      }
      return results;
    }

    const allStrings = findMetadataStrings(node);
    
    // Improved Number Extractor to handle decimals and localized separators
    function extractNumber(text) {
      const lowerText = text.toLowerCase();
      const match = lowerText.match(/([\d,\.]+)/);
      if (!match) return 0;
      
      let numStr = match[1];
      // If the text contains multipliers, treat the punctuation as a decimal (e.g., "1,5 jt")
      if (lowerText.match(/\b(rb|k|jt|m)\b/)) {
        numStr = numStr.replace(',', '.');
        let count = parseFloat(numStr) || 0;
        if (lowerText.includes('rb') || lowerText.includes('k')) count *= 1000;
        if (lowerText.includes('jt') || lowerText.includes('m')) count *= 1000000;
        return count;
      } else {
        // Normal large number (e.g., "1.500" or "1,500"), remove punctuation
        numStr = numStr.replace(/[,.]/g, '');
        return parseInt(numStr, 10) || 0;
      }
    }
    
    allStrings.forEach(text => {
      const lowerText = text.toLowerCase();
      
      // Member extraction (e.g., "1,5 jt anggota", "1.5M members")
      if (lowerText.includes('member') || lowerText.includes('anggota')) {
        const count = extractNumber(text);
        if (count > 0) memberCount = Math.max(memberCount, count);
      }
      
      // Post activity extraction (e.g., "10+ postingan sehari", "5 kiriman hari ini")
      const isActivity = lowerText.includes('post') || lowerText.includes('kiriman') || lowerText.includes('tulisan');
      const isDaily = lowerText.includes('sehari') || lowerText.includes('hari ini') || lowerText.includes('a day') || lowerText.includes('today');
      
      // Sometimes Facebook just says "10+ posts a day"
      if (isActivity && !lowerText.includes('member')) {
        // If it specifically mentions daily or just generally talks about posts
        if (isDaily || lowerText.match(/\d+\+?\s*(post|kiriman)/)) {
           const count = extractNumber(text);
           if (count > 0) postsPerDay = Math.max(postsPerDay, count);
        }
      }
    });

    // Advanced Scoring System (Point-based)
    let scorePoints = 0;
    
    // 1. Buying Intent in Name
    const intentKeywords = ['racun', 'promo', 'diskon', 'jual', 'beli', 'murah', 'review', 'spill', 'rekomendasi', 'shopee', 'tokopedia', 'tiktok'];
    const lowerName = name.toLowerCase();
    if (intentKeywords.some(kw => lowerName.includes(kw))) {
      scorePoints += 30; // High buying intent
    }

    // 2. Public vs Private Check
    let isPublic = false;
    allStrings.forEach(text => {
      const lowerText = text.toLowerCase();
      if (lowerText.includes('publik') || lowerText.includes('public group')) isPublic = true;
    });
    if (isPublic) {
      scorePoints += 20; // Public groups are easier for affiliate sharing
    }

    // 3. Member Count Tiers
    if (memberCount >= 100000) scorePoints += 30;
    else if (memberCount >= 50000) scorePoints += 20;
    else if (memberCount >= 10000) scorePoints += 10;
    else if (memberCount >= 1000) scorePoints += 5;

    // 4. Activity Rate (Posts per day)
    if (postsPerDay >= 20) scorePoints += 30;
    else if (postsPerDay >= 10) scorePoints += 20;
    else if (postsPerDay >= 5) scorePoints += 10;
    else if (postsPerDay >= 1) scorePoints += 5;

    // Determine Final Grade
    let score = 'Low';
    let scoreColor = '#94a3b8';
    
    if (scorePoints >= 70) {
      score = '🔥 Viral Potential';
      scoreColor = '#22c55e';
    } else if (scorePoints >= 40) {
      score = '⭐ Medium Potential';
      scoreColor = '#eab308';
    } else {
      score = '💤 Low Potential';
      scoreColor = '#94a3b8';
    }

    const discovery = {
      id,
      name,
      url,
      memberCount,
      postsPerDay,
      score,
      scoreColor,
      discoveredAt: new Date().toISOString()
    };

    console.log(`%c 🔍 Group Discovered: ${name}`, 'color: #22c55e; font-weight: bold;', discovery);
    return discovery;
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

    // Filter: Only keep posts that have engagement (likes OR comments)
    // The user requested: "hanya menampilkan data yang memiliki jumlah like dan komentar"
    if (likes === 0 && comments === 0) {
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
  let maxAttempts = targetLimit ? 30 : 5; // allow more time if waiting for a big limit
  let initialPosts = interceptedPosts.length;

  const interval = setInterval(() => {
    window.scrollBy(0, 1500);
    scrollAttempts++;
    
    const currentCount = interceptedPosts.length;
    
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
