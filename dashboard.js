// dashboard.js - Main Logic for the Open Dashboard

let currentPosts = [];
let selectedPosts = new Set();
let autoCommentLog = [];
let activeFilter = '';
let activeSort = 'newest';

let discoveredGroups = [];
let selectedGroups = new Set();
let autoPostLog = [];

// Elements
const resultsGrid = document.getElementById('results');
const statTotalPosts = document.getElementById('statTotalPosts');
const statSelectedPosts = document.getElementById('statSelectedPosts');
const statTotalComments = document.getElementById('statTotalComments');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = statusIndicator.querySelector('.status-text');

// Init
document.addEventListener('DOMContentLoaded', () => {
  // Setup Tabs
  const navLinks = document.querySelectorAll('.nav-link');
  const tabSections = document.querySelectorAll('.tab-section');

  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navLinks.forEach(l => l.classList.remove('active'));
      tabSections.forEach(s => s.classList.remove('active'));
      
      link.classList.add('active');
      const tabId = link.getAttribute('data-tab') + '-tab';
      document.getElementById(tabId).classList.add('active');
    });
  });

  // Load Data
  chrome.storage.local.get(['fb_intercepted_posts', 'fb_auto_comment_log', 'fb_discovered_groups', 'fb_auto_post_log'], (result) => {
    if (result.fb_intercepted_posts) currentPosts = result.fb_intercepted_posts;
    if (result.fb_auto_comment_log) autoCommentLog = result.fb_auto_comment_log;
    if (result.fb_discovered_groups) discoveredGroups = result.fb_discovered_groups;
    if (result.fb_auto_post_log) autoPostLog = result.fb_auto_post_log;
    updateUI();
    updateGroupsUI();
    if (autoCommentLog.length > 0) updateCommentLog(autoCommentLog);
    if (autoPostLog.length > 0) updatePostLog(autoPostLog);
  });

  // Real-time Updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DATA_UPDATED') {
      currentPosts = msg.posts;
      if (msg.groups) {
        discoveredGroups = msg.groups;
      } else {
        // Backfill discoveredGroups from currentPosts if needed
        let changed = false;
        currentPosts.forEach(post => {
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
            changed = true;
          }
        });
        if (changed) {
          chrome.storage.local.set({ fb_discovered_groups: discoveredGroups });
        }
      }
      updateUI();
      updateGroupsUI();
    }
    if (msg.type === 'AUTO_COMMENT_PROGRESS') {
      updateCommentLog(msg.log);
      statusText.innerText = msg.status;
      if (msg.status === 'Completed' || msg.status === 'Cancelled') {
        document.getElementById('startAutoCommentBtn').style.display = 'flex';
        document.getElementById('stopAutoCommentBtn').style.display = 'none';
        statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--success)';
      }
    }
    if (msg.type === 'AUTO_POST_PROGRESS') {
      updatePostLog(msg.log);
      const statusLabel = document.getElementById('autopostStatus');
      if (statusLabel) statusLabel.innerText = msg.status;
      statusText.innerText = msg.status;
      if (msg.status === 'Completed' || msg.status === 'Cancelled') {
        const startBtn = document.getElementById('startAutoPostBtn');
        const stopBtn = document.getElementById('stopAutoPostBtn');
        if (startBtn) startBtn.style.display = 'flex';
        if (stopBtn) stopBtn.style.display = 'none';
        statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--success)';
      }
    }
    if (msg.type === 'DEEP_SCRAPE_COMPLETE') {
      const activeBtn = document.querySelector('[id^="active-scraping-"]');
      if (activeBtn) {
        activeBtn.innerText = 'Done! Click Analyze';
        activeBtn.style.background = 'var(--primary)';
        activeBtn.disabled = false;
        activeBtn.removeAttribute('id');
      }
    }
  });

  // Search & Filter
  document.getElementById('filterInput').addEventListener('input', (e) => {
    activeFilter = e.target.value.toLowerCase();
    updateUI();
  });

  document.getElementById('sortSelect').addEventListener('change', (e) => {
    activeSort = e.target.value;
    updateUI();
  });

  // Select All
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    document.querySelectorAll('.post-checkbox').forEach(cb => {
      cb.checked = isChecked;
      const fbid = cb.dataset.fbid;
      if (isChecked) {
        selectedPosts.add(String(fbid));
        cb.closest('.post-card').classList.add('selected');
      } else {
        selectedPosts.delete(String(fbid));
        cb.closest('.post-card').classList.remove('selected');
      }
    });
    updateStats();
  });

  // Export CSV
  const exportBtn = document.getElementById('exportBtn');
  exportBtn.addEventListener('click', () => {
    if (currentPosts.length === 0) return;
    const headers = ['ID', 'Author', 'GroupName', 'GroupID', 'Timestamp', 'Text', 'Likes', 'Comments', 'Shares', 'URL'];
    const csvRows = [headers.join(',')];
    currentPosts.forEach(post => {
      const row = [
        post.fbid, 
        `"${escapeCsv(post.author)}"`, 
        `"${escapeCsv(post.groupName)}"`, 
        post.groupId, 
        `"${escapeCsv(post.timestamp)}"`, 
        `"${escapeCsv(post.text)}"`, 
        post.likes, 
        post.comments, 
        post.shares, 
        post.postUrl
      ];
      csvRows.push(row.join(','));
    });
    downloadCsv(csvRows.join('\n'), `fb-scraper-pro-${Date.now()}.csv`);
  });

  // Clear Data
  document.getElementById('clearBtn').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all scraped data?')) return;
    currentPosts = [];
    selectedPosts.clear();
    chrome.storage.local.set({ fb_intercepted_posts: [], fb_auto_comment_log: [] });
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: 0 }).catch(() => {});
    
    // Also clear content script memory if active tab is FB
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes('facebook.com')) {
      chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_DATA' }).catch(() => {});
    }
    
    updateUI();
  });

  // Automation Logic
  const replyMode = document.getElementById('isReplyMode');
  const keywordGroup = document.getElementById('keywordGroup');
  replyMode.addEventListener('change', (e) => {
    keywordGroup.style.display = e.target.checked ? 'block' : 'none';
  });

  const delayRange = document.getElementById('delayRange');
  const delayValue = document.getElementById('delayValue');
  delayRange.addEventListener('input', (e) => {
    delayValue.innerText = e.target.value + 's';
  });

  document.getElementById('startAutoCommentBtn').addEventListener('click', () => {
    const message = document.getElementById('commentMessage').value;
    const delay = parseInt(delayRange.value);
    const isReplyMode = replyMode.checked;
    const keywords = document.getElementById('keywords').value.split(',').map(k => k.trim()).filter(k => k);
    
    if (!message) return alert('Please enter a message to comment.');
    if (isReplyMode && keywords.length === 0) return alert('Please enter at least one keyword for Reply Mode.');
    if (selectedPosts.size === 0) return alert('Please select at least one post from the Data tab.');

    if (confirm(`Launch automation on ${selectedPosts.size} posts?`)) {
      const selectedData = currentPosts.filter(p => selectedPosts.has(String(p.fbid)));
      
      chrome.runtime.sendMessage({
        type: 'START_AUTO_COMMENT',
        posts: selectedData,
        message: message,
        delay: delay,
        isReplyMode: isReplyMode,
        keywords: keywords
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("Auto Comment send error:", chrome.runtime.lastError);
          alert("Error: " + chrome.runtime.lastError.message + "\nPlease reload this Dashboard tab to reconnect to the extension.");
          document.getElementById('startAutoCommentBtn').style.display = 'flex';
          document.getElementById('stopAutoCommentBtn').style.display = 'none';
          statusText.innerText = 'Error: Connection lost';
          statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--danger)';
          return;
        }
        
        document.getElementById('startAutoCommentBtn').style.display = 'none';
        document.getElementById('stopAutoCommentBtn').style.display = 'flex';
        statusText.innerText = 'Running Automation...';
        statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--warning)';
      });
    }
  });

  document.getElementById('stopAutoCommentBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AUTO_COMMENT' });
    document.getElementById('stopAutoCommentBtn').innerText = 'Stopping...';
    setTimeout(() => {
      document.getElementById('stopAutoCommentBtn').innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg> Stop';
    }, 2000);
  });

  // Auto Post UI Event Listeners
  const autopostDelayRange = document.getElementById('autopostDelayRange');
  const autopostDelayValue = document.getElementById('autopostDelayValue');
  if (autopostDelayRange) {
    autopostDelayRange.addEventListener('input', (e) => {
      autopostDelayValue.innerText = e.target.value + 's';
    });
  }

  // Add Manual Group
  const addManualGroupBtn = document.getElementById('addManualGroupBtn');
  const manualGroupUrlInput = document.getElementById('manualGroupUrl');
  if (addManualGroupBtn && manualGroupUrlInput) {
    addManualGroupBtn.addEventListener('click', () => {
      const inputVal = manualGroupUrlInput.value.trim();
      if (!inputVal) return alert('Please enter a Facebook Group URL or ID.');

      const parsedGroup = parseGroupInput(inputVal);
      if (!parsedGroup) return alert('Invalid input. Please provide a valid Facebook Group URL (must contain /groups/) or a numeric Group ID.');

      // Check if already exists
      const exists = discoveredGroups.some(g => String(g.id) === String(parsedGroup.id));
      if (exists) return alert('Group already exists in the list.');

      discoveredGroups.push(parsedGroup);
      chrome.storage.local.set({ fb_discovered_groups: discoveredGroups }, () => {
        manualGroupUrlInput.value = '';
        updateGroupsUI();
      });
    });
  }

  // Select All Groups Checkbox
  const selectAllGroupsCheckbox = document.getElementById('selectAllGroups');
  if (selectAllGroupsCheckbox) {
    selectAllGroupsCheckbox.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.group-checkbox').forEach(cb => {
        cb.checked = isChecked;
        const gid = cb.dataset.gid;
        if (isChecked) {
          selectedGroups.add(String(gid));
          cb.closest('.group-item').classList.add('selected');
        } else {
          selectedGroups.delete(String(gid));
          cb.closest('.group-item').classList.remove('selected');
        }
      });
      updateGroupsStats();
    });
  }

  // Start Auto Post
  const startAutoPostBtn = document.getElementById('startAutoPostBtn');
  const stopAutoPostBtn = document.getElementById('stopAutoPostBtn');
  const autopostMessageArea = document.getElementById('autopostMessage');
  if (startAutoPostBtn) {
    startAutoPostBtn.addEventListener('click', () => {
      const message = autopostMessageArea.value;
      const delay = parseInt(autopostDelayRange.value);
      
      if (!message) return alert('Please enter a message to post.');
      if (selectedGroups.size === 0) return alert('Please select at least one group.');

      if (confirm(`Launch auto-post on ${selectedGroups.size} groups?`)) {
        const selectedGroupData = discoveredGroups.filter(g => selectedGroups.has(String(g.id)));
        
        chrome.runtime.sendMessage({
          type: 'START_AUTO_POST',
          groups: selectedGroupData,
          message: message,
          delay: delay
        }, () => {
          if (chrome.runtime.lastError) {
            console.error("Auto Post send error:", chrome.runtime.lastError);
            alert("Error: " + chrome.runtime.lastError.message + "\nPlease reload this Dashboard tab to reconnect to the extension.");
            startAutoPostBtn.style.display = 'flex';
            stopAutoPostBtn.style.display = 'none';
            const statusLabel = document.getElementById('autopostStatus');
            if (statusLabel) statusLabel.innerText = 'Error: Connection lost';
            statusText.innerText = 'Error: Connection lost';
            statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--danger)';
            return;
          }
          
          startAutoPostBtn.style.display = 'none';
          stopAutoPostBtn.style.display = 'flex';
          const statusLabel = document.getElementById('autopostStatus');
          if (statusLabel) statusLabel.innerText = 'Running Auto Post...';
          statusText.innerText = 'Running Auto Post...';
          statusIndicator.querySelector('.status-dot').style.backgroundColor = 'var(--warning)';
        });
      }
    });
  }

  if (stopAutoPostBtn) {
    stopAutoPostBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_AUTO_POST' });
      stopAutoPostBtn.innerText = 'Stopping...';
      setTimeout(() => {
        stopAutoPostBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg> Stop';
      }, 2000);
    });
  }
});

function updateUI() {
  const exportBtn = document.getElementById('exportBtn');
  exportBtn.disabled = currentPosts.length === 0;

  let filtered = currentPosts.filter(p => 
    (p.text && p.text.toLowerCase().includes(activeFilter)) || 
    (p.author && p.author.toLowerCase().includes(activeFilter)) ||
    (p.groupName && p.groupName.toLowerCase().includes(activeFilter))
  );

  if (activeSort === 'likes') filtered.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  else if (activeSort === 'comments') filtered.sort((a, b) => (b.comments || 0) - (a.comments || 0));
  else filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // Newest first

  resultsGrid.innerHTML = '';

  if (filtered.length === 0) {
    resultsGrid.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
        <p>No posts match your filters or no data captured yet.</p>
      </div>`;
  } else {
    filtered.forEach(post => {
      const isSelected = selectedPosts.has(String(post.fbid));
      const card = document.createElement('div');
      card.className = `post-card ${isSelected ? 'selected' : ''}`;
      
      card.innerHTML = `
        <div class="post-header">
          <label class="checkbox-container" style="margin: 0; padding-left: 24px;">
            <input type="checkbox" class="post-checkbox" data-fbid="${post.fbid}" ${isSelected ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
          <div class="post-avatar">${(post.author || '?').charAt(0).toUpperCase()}</div>
          <div class="post-meta">
            <div class="post-author">${escapeHtml(post.author)}</div>
            <div class="post-time">${escapeHtml(post.groupName || 'Feed')} • ${escapeHtml(post.timestamp)}</div>
          </div>
        </div>
        <div class="post-content">${escapeHtml(post.text)}</div>
        <div class="post-stats">
          <div class="stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
            ${formatNumber(post.likes)}
          </div>
          <div class="stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            ${formatNumber(post.comments)}
          </div>
          <div class="stat-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
            ${formatNumber(post.shares)}
          </div>
          <a href="${post.postUrl}" target="_blank" style="margin-left: auto; color: var(--primary); text-decoration: none; font-weight: 500;">View &rarr;</a>
          
          <div class="post-actions-row">
            ${post.comments > 0 ? `<button class="btn-mini btn-deep" data-url="${escapeHtml(post.postUrl)}" data-fbid="${post.fbid}">Deep Comment</button>` : ''}
            <button class="btn-mini btn-analyze" data-fbid="${post.fbid}">Analyze</button>
          </div>
        </div>
        <div class="analysis-panel" id="analysis-${post.fbid}"></div>
      `;

      // Store comment data in DOM for analysis
      card.dataset.commentsText = post.commentsText || '';

      const cb = card.querySelector('.post-checkbox');
      cb.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedPosts.add(String(post.fbid));
          card.classList.add('selected');
        } else {
          selectedPosts.delete(String(post.fbid));
          card.classList.remove('selected');
          document.getElementById('selectAll').checked = false;
        }
        updateStats();
      });

      resultsGrid.appendChild(card);
    });

    // Attach event listeners for Deep Comment and Analyze buttons
    document.querySelectorAll('.btn-deep').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = e.target.dataset.url;
        const fbid = e.target.dataset.fbid;
        e.target.innerText = 'Scraping...';
        e.target.style.opacity = '0.7';
        e.target.disabled = true;
        e.target.id = `active-scraping-${fbid}`;

        chrome.runtime.sendMessage({
          type: 'START_DEEP_SCRAPE',
          url: url,
          fbid: fbid
        });
      });
    });

    document.querySelectorAll('.btn-analyze').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const fbid = e.target.dataset.fbid;
        const panel = document.getElementById(`analysis-${fbid}`);
        const card = e.target.closest('.post-card');
        const commentsText = card.dataset.commentsText || '';
        
        if (panel.style.display === 'block') {
          panel.style.display = 'none';
          return;
        }

        const keywords = extractKeywords(commentsText);
        const keywordHtml = keywords.length > 0 
          ? keywords.map(kw => `<span class="keyword-tag">🏷️ ${escapeHtml(kw)}</span>`).join(' ')
          : '<span style="font-size: 0.75rem; color: var(--text-muted);">Not enough comment data. Run Deep Comment first!</span>';

        panel.innerHTML = `
          <div style="font-size: 0.8rem; font-weight: 600; margin-bottom: 8px; color: var(--text-main);">
            Audience Intent (Top Keywords):
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">
            ${keywordHtml}
          </div>
        `;
        panel.style.display = 'block';
      });
    });
  }

  updateStats();
}

function updateStats() {
  statTotalPosts.innerText = currentPosts.length;
  statSelectedPosts.innerText = selectedPosts.size;
  
  const totalComments = currentPosts.reduce((sum, p) => sum + (p.comments || 0), 0);
  statTotalComments.innerText = formatNumber(totalComments);
  
  document.getElementById('targetInfoText').innerText = `${selectedPosts.size} posts selected for automation`;
}

function extractKeywords(text) {
  if (!text) return [];
  const stopWords = new Set(['yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'untuk', 'dengan', 'dalam', 'pada', 'adalah', 'sebagai', 'tidak', 'akan', 'ada', 'bisa', 'juga', 'kami', 'saya', 'mereka', 'sudah', 'atau', 'saat', 'oleh', 'menjadi', 'lagi', 'buat', 'apa', 'kita', 'kalau', 'karena', 'aja', 'sama', 'pun', 'belum', 'baru', 'hanya', 'lebih', 'saja', 'tapi', 'banyak', 'the', 'and', 'to', 'of', 'a', 'in', 'is', 'for', 'that', 'on', 'with', 'it', 'as', 'are', 'be', 'this', 'was', 'have', 'or', 'at', 'not', 'but', 'by', 'all', 'we']);
  
  const wordCounts = {};
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  words.forEach(word => {
    if (word.length > 3 && !stopWords.has(word) && isNaN(word)) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  });

  return Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(entry => entry[0]);
}

function updateCommentLog(log) {
  const logContainer = document.getElementById('commentLog');
  if (!log || log.length === 0) return;
  
  logContainer.innerHTML = log.map(entry => `
    <div class="log-entry ${entry.success ? 'success' : 'error'}">
      <span style="color: #64748b;">[${new Date(entry.time).toLocaleTimeString()}]</span> ${escapeHtml(entry.msg)}
    </div>
  `).join('');
  logContainer.scrollTop = logContainer.scrollHeight;
}

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

function formatNumber(num) {
  if (!num) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCsv(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '""');
}

// Auto Post Helper Functions
function parseGroupInput(val) {
  // If numeric ID
  if (/^\d+$/.test(val)) {
    return {
      id: val,
      name: 'Group ' + val,
      url: `https://www.facebook.com/groups/${val}/`,
      memberCount: 0,
      postsPerDay: 0,
      score: 'Manually Added',
      scoreColor: '#10b981',
      discoveredAt: new Date().toISOString()
    };
  }
  
  // If URL like https://www.facebook.com/groups/2118472764926881/ or similar
  try {
    const url = new URL(val);
    if (!url.hostname.includes('facebook.com')) return null;
    const parts = url.pathname.split('/');
    const groupsIndex = parts.indexOf('groups');
    if (groupsIndex !== -1 && parts[groupsIndex + 1]) {
      const groupId = parts[groupsIndex + 1];
      return {
        id: groupId,
        name: 'Group ' + groupId,
        url: `https://www.facebook.com/groups/${groupId}/`,
        memberCount: 0,
        postsPerDay: 0,
        score: 'Manually Added',
        scoreColor: '#10b981',
        discoveredAt: new Date().toISOString()
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

function updateGroupsUI() {
  const container = document.getElementById('groupList');
  const countBadge = document.getElementById('groupCountBadge');
  if (!container) return;

  if (countBadge) {
    countBadge.innerText = `${discoveredGroups.length} groups`;
  }

  if (discoveredGroups.length === 0) {
    container.innerHTML = `<div class="empty-state">No groups available. Scrape some posts first or add manually.</div>`;
    return;
  }

  container.innerHTML = '';
  discoveredGroups.forEach(group => {
    const isSelected = selectedGroups.has(String(group.id));
    const groupEl = document.createElement('div');
    groupEl.className = `group-item ${isSelected ? 'selected' : ''}`;
    
    groupEl.innerHTML = `
      <label class="checkbox-container" style="margin: 0; padding-left: 24px;">
        <input type="checkbox" class="group-checkbox" data-gid="${group.id}" ${isSelected ? 'checked' : ''}>
        <span class="checkmark"></span>
      </label>
      <div class="group-item-meta">
        <div class="group-item-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</div>
        <div class="group-item-id">ID: ${group.id}</div>
      </div>
      <button class="btn-delete-group" data-gid="${group.id}" title="Remove Group">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    // Event listener for checkbox
    const cb = groupEl.querySelector('.group-checkbox');
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedGroups.add(String(group.id));
        groupEl.classList.add('selected');
      } else {
        selectedGroups.delete(String(group.id));
        groupEl.classList.remove('selected');
        const selectAll = document.getElementById('selectAllGroups');
        if (selectAll) selectAll.checked = false;
      }
      updateGroupsStats();
    });

    // Event listener for delete
    const deleteBtn = groupEl.querySelector('.btn-delete-group');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Are you sure you want to remove group: "${group.name}"?`)) return;
      
      discoveredGroups = discoveredGroups.filter(g => String(g.id) !== String(group.id));
      selectedGroups.delete(String(group.id));
      
      chrome.storage.local.set({ fb_discovered_groups: discoveredGroups }, () => {
        updateGroupsUI();
        updateGroupsStats();
      });
    });

    container.appendChild(groupEl);
  });
  
  updateGroupsStats();
}

function updateGroupsStats() {
  const targetText = document.getElementById('targetGroupsInfoText');
  if (targetText) {
    targetText.innerText = `${selectedGroups.size} groups selected for auto-post`;
  }
}

function updatePostLog(log) {
  const logContainer = document.getElementById('autopostLog');
  if (!logContainer || !log || log.length === 0) return;
  
  logContainer.innerHTML = log.map(entry => `
    <div class="log-entry ${entry.success ? 'success' : 'error'}">
      <span style="color: #64748b;">[${new Date(entry.time).toLocaleTimeString()}]</span> ${escapeHtml(entry.msg)}
    </div>
  `).join('');
  logContainer.scrollTop = logContainer.scrollHeight;
}
