const btn = document.getElementById('scrapeBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const status = document.getElementById('status');
const results = document.getElementById('results');
const countBadge = document.getElementById('countBadge');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const filterInput = document.getElementById('filterInput');
const sortSelect = document.getElementById('sortSelect');
let currentPosts = [];
let selectedPosts = new Set(); // Track FBIDs of selected posts
let autoCommentLog = [];
let isAutoCommenting = false;
let activeFilter = '';
let activeSort = 'newest';

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load from storage
  chrome.storage.local.get(['fb_intercepted_posts', 'fb_auto_comment_log'], (result) => {
    if (result.fb_intercepted_posts) currentPosts = result.fb_intercepted_posts;
    if (result.fb_auto_comment_log) autoCommentLog = result.fb_auto_comment_log;
    updateUI();
  });

  // Listen for real-time updates (via messaging)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DATA_UPDATED') {
      currentPosts = msg.posts;
      currentGroups = msg.groups;
      updateUI();
      
      // Update live progress on the scraping button
      const activeBtn = document.querySelector('[id^="active-scraping-"]');
      if (activeBtn) {
        const fbid = activeBtn.id.replace('active-scraping-', '');
        const post = currentPosts.find(p => String(p.fbid) === String(fbid));
        if (post && post.commentsText) {
          const count = post.commentsText.split('|').length;
          activeBtn.innerText = `Scraping: ${count} comments...`;
        }
      }
    }

    if (msg.type === 'DEEP_SCRAPE_COMPLETE') {
      const activeBtn = document.querySelector('[id^="active-scraping-"]');
      if (activeBtn) {
        activeBtn.innerText = 'Done! Click Analyze';
        activeBtn.style.background = '#3b82f6';
        activeBtn.disabled = false;
        activeBtn.removeAttribute('id');
      }
    }
    
    if (msg.type === 'AUTO_COMMENT_PROGRESS') {
      updateCommentLog(msg.log);
      document.getElementById('commentStatus').innerText = msg.status;
      
      const startBtn = document.getElementById('startAutoCommentBtn');
      const stopBtn = document.getElementById('stopAutoCommentBtn');
      
      if (msg.status === 'Completed' || msg.status === 'Cancelled' || msg.status === 'Idle') {
        if (startBtn) startBtn.style.display = 'flex';
        if (stopBtn) stopBtn.style.display = 'none';
      } else {
        if (startBtn) startBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'flex';
      }
    }
  });

  // Listen for storage changes (handles updates from background tabs/scripts)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      let changed = false;
      if (changes.fb_intercepted_posts) {
        currentPosts = changes.fb_intercepted_posts.newValue || [];
        changed = true;
      }
      if (changes.fb_intercepted_posts) {
        currentPosts = changes.fb_intercepted_posts.newValue || [];
        changed = true;
      }
      if (changed) updateUI();
    }
  });

  // Tab switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
    });
  });

  // Filter & Sort Listeners
  filterInput.addEventListener('input', (e) => {
    activeFilter = e.target.value.toLowerCase();
    displayPosts(currentPosts);
  });

  sortSelect.addEventListener('change', (e) => {
    activeSort = e.target.value;
    displayPosts(currentPosts);
  });

  // Select All logic
  const selectAllPosts = document.getElementById('selectAllPosts');
  if (selectAllPosts) {
    selectAllPosts.addEventListener('change', (e) => {
      if (e.target.checked) {
        currentPosts.forEach(p => selectedPosts.add(String(p.fbid)));
      } else {
        selectedPosts.clear();
      }
      displayPosts(currentPosts);
      updateStartButton();
    });
  }
});

function updateStartButton() {
  const startBtn = document.getElementById('startAutoCommentBtn');
  if (startBtn) {
    const span = startBtn.querySelector('span');
    if (span) {
      span.innerText = selectedPosts.size > 0 
        ? `Start Auto Comment (${selectedPosts.size})` 
        : 'Start Auto Comment (Select posts first)';
    }
    startBtn.disabled = selectedPosts.size === 0;
    startBtn.style.opacity = selectedPosts.size === 0 ? '0.5' : '1';
  }
}

function updateUI() {
  if (countBadge) countBadge.innerText = currentPosts.length;
  if (exportBtn) exportBtn.disabled = currentPosts.length === 0;
  
  if (currentPosts.length > 0) {
    if (status) status.innerText = `${currentPosts.length} posts captured so far.`;
    displayPosts(currentPosts);
  } else {
    if (results) results.innerHTML = `<div class="empty-state"><div class="empty-icon">📥</div><p>No data captured yet.</p></div>`;
    if (status) status.innerText = 'Waiting for Facebook Group...';
  }

  if (typeof updateCommentLog === 'function') {
    updateCommentLog(autoCommentLog);
  }
  
  updateStartButton();
}

function updateCommentLog(log) {
  const logContainer = document.getElementById('auto-comment-log');
  if (!logContainer) return;
  
  if (!log || log.length === 0) {
    logContainer.innerHTML = `<div class="empty-state"><p>Wait for start to see progress log.</p></div>`;
    return;
  }
  
  logContainer.innerHTML = log.map(entry => `
    <div class="log-entry">
      <span class="log-time">${new Date(entry.time).toLocaleTimeString()}</span>
      <span class="log-msg ${entry.success ? 'log-success' : 'log-error'}">${escapeHtml(entry.msg)}</span>
    </div>
  `).join('');
  logContainer.scrollTop = logContainer.scrollHeight;
}

if (document.getElementById('autoReplyMode')) {
  document.getElementById('autoReplyMode').addEventListener('change', (e) => {
    const kwGroup = document.getElementById('keywordGroup');
    if (kwGroup) kwGroup.style.display = e.target.checked ? 'flex' : 'none';
  });
}

const startAutoCommentBtn = document.getElementById('startAutoCommentBtn');
if (startAutoCommentBtn) {
  startAutoCommentBtn.addEventListener('click', () => {
    const template = document.getElementById('commentTemplate');
    const delayInput = document.getElementById('commentDelay');
    const replyMode = document.getElementById('autoReplyMode');
    const keywordsInput = document.getElementById('replyKeywords');
    
    const message = template ? template.value : '';
    const delay = delayInput ? parseInt(delayInput.value) || 10 : 10;
    const isReplyMode = replyMode ? replyMode.checked : false;
    const keywords = keywordsInput ? keywordsInput.value.split(',').map(k => k.trim()).filter(k => k) : [];
    
    if (!message) {
      alert('Please enter a message.');
      return;
    }

    if (isReplyMode && keywords.length === 0) {
      alert('Please enter at least one keyword for Auto Reply mode.');
      return;
    }
    
    if (currentPosts.length === 0) {
      alert('No posts captured yet.');
      return;
    }
    
    const confirmMsg = isReplyMode 
      ? `Start auto replying to comments matching [${keywords.join(', ')}] on ${selectedPosts.size} selected posts?`
      : `Start auto commenting on ${selectedPosts.size} selected posts with ${delay}s delay?`;

    if (confirm(confirmMsg)) {
      const selectedData = currentPosts.filter(p => selectedPosts.has(String(p.fbid)));
      
      chrome.runtime.sendMessage({
        type: 'START_AUTO_COMMENT',
        posts: selectedData,
        message: message,
        delay: delay,
        isReplyMode: isReplyMode,
        keywords: keywords
      });
      
      const startBtn = document.getElementById('startAutoCommentBtn');
      const stopBtn = document.getElementById('stopAutoCommentBtn');
      if (startBtn) startBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'flex';
      
      const commentStatus = document.getElementById('commentStatus');
      if (commentStatus) commentStatus.innerText = 'Starting...';
    }
  });
}

const stopAutoCommentBtn = document.getElementById('stopAutoCommentBtn');
if (stopAutoCommentBtn) {
  stopAutoCommentBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AUTO_COMMENT' });
    stopAutoCommentBtn.disabled = true;
    stopAutoCommentBtn.innerText = 'Stopping...';
    
    setTimeout(() => {
      stopAutoCommentBtn.disabled = false;
      stopAutoCommentBtn.innerText = 'Stop';
    }, 2000);
  });
}

if (btn) {
  btn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url.includes('facebook.com')) {
      if (status) status.innerText = 'Please navigate to a Facebook page.';
      return;
    }
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<span>Extracting...</span>';
    
    const limitInput = document.getElementById('scrapeLimit');
    const targetLimit = limitInput ? (limitInput.value ? parseInt(limitInput.value) : null) : null;
    
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { 
        type: 'START_SCRAPE',
        targetLimit: targetLimit
      });
      if (response) {
        if (response.posts) currentPosts = response.posts;
        if (response.groups) currentGroups = response.groups;
        updateUI();
      }
    } catch (err) {
      if (status) status.innerText = 'Error: Please refresh the page.';
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
}

if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    if (currentPosts.length === 0) return;
    const headers = ['ID', 'Author', 'GroupName', 'GroupID', 'Timestamp', 'Text', 'Likes', 'Comments', 'Shares', 'URL', 'LastUpdated'];
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
        post.postUrl,
        post.lastUpdated || post.scrapedAt
      ];
      csvRows.push(row.join(','));
    });
    downloadCsv(csvRows.join('\n'), `fb-posts-${Date.now()}.csv`);
  });
}

// Group export removed

if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all data?')) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_DATA' }).catch(() => {});
    currentPosts = [];
    chrome.storage.local.set({ fb_intercepted_posts: [] });
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: 0 }).catch(() => {});
    updateUI();
  });
}

function displayPosts(posts) {
  let filtered = posts.filter(p => 
    p.text.toLowerCase().includes(activeFilter) || 
    p.author.toLowerCase().includes(activeFilter) ||
    p.groupName.toLowerCase().includes(activeFilter)
  );

  if (activeSort === 'likes') {
    filtered.sort((a, b) => b.likes - a.likes);
  } else if (activeSort === 'comments') {
    filtered.sort((a, b) => b.comments - a.comments);
  } else {
    filtered.reverse(); // Newest first
  }

  // Grouping logic
  const grouped = filtered.reduce((acc, post) => {
    const key = post.groupName || 'Unknown Group';
    if (!acc[key]) acc[key] = [];
    acc[key].push(post);
    return acc;
  }, {});

  results.innerHTML = '';
  
  Object.keys(grouped).forEach(groupName => {
    const section = document.createElement('div');
    section.className = 'group-section';
    
    const header = document.createElement('div');
    header.className = 'group-section-header';
    header.innerHTML = `
      <div class="group-section-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
        ${escapeHtml(groupName)}
      </div>
      <div class="group-section-actions">
        <span class="group-section-count">${grouped[groupName].length} posts</span>
        <button class="btn-analyze" data-group="${escapeHtml(groupName)}">Analyze Group</button>
      </div>
    `;
    section.appendChild(header);

    // Analysis container for group
    const groupAnalysisContainer = document.createElement('div');
    groupAnalysisContainer.id = `analysis-${groupName.replace(/\s+/g, '-')}`;
    section.appendChild(groupAnalysisContainer);

    grouped[groupName].forEach(post => {
      const isSelected = selectedPosts.has(String(post.fbid));
      const postEl = document.createElement('div');
      postEl.className = `post ${isSelected ? 'selected' : ''}`;
      
      const safeId = `post-${post.fbid || Math.random().toString(36).substr(2, 9)}`;
      
      postEl.innerHTML = `
        <div style="display: flex; gap: 12px; align-items: flex-start;">
          <input type="checkbox" class="post-checkbox" data-fbid="${post.fbid}" ${isSelected ? 'checked' : ''} style="margin-top: 4px;">
          <div style="flex: 1;">
            <div class="post-header">
              <span class="post-author">${escapeHtml(post.author)}</span>
              <span class="post-time">${escapeHtml(post.timestamp)}</span>
            </div>
            <div class="post-text">${escapeHtml(post.text)}</div>
            <div class="post-footer">
              <div class="post-stats">
                <div class="stat">❤️ ${formatNumber(post.likes)}</div>
                <div class="stat">💬 ${formatNumber(post.comments)}</div>
                <div class="stat">🔁 ${formatNumber(post.shares)}</div>
              </div>
              <div class="post-actions">
                <button class="btn-analyze-post" data-target="${safeId}" style="background: var(--primary); color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.65rem; cursor: pointer;">Analyze</button>
                ${post.comments > 0 ? `<button class="btn-deep-comment" data-url="${escapeHtml(post.postUrl)}" data-fbid="${post.fbid}" style="background: #10b981; color: white; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.65rem; cursor: pointer;">Deep Comment</button>` : ''}
                <button class="copy-btn" data-text="${escapeHtml(post.text)}">Copy</button>
                <a href="${escapeHtml(post.postUrl)}" class="view-link" target="_blank">Source</a>
              </div>
            </div>
            <div id="analysis-${safeId}" style="display: none; margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1);"></div>
          </div>
        </div>
      `;
      
      // Store post data temporarily
      postEl.dataset.commentsText = post.commentsText || '';
      
      // Selection handler
      const checkbox = postEl.querySelector('.post-checkbox');
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedPosts.add(String(post.fbid));
          postEl.classList.add('selected');
        } else {
          selectedPosts.delete(String(post.fbid));
          postEl.classList.remove('selected');
          const sa = document.getElementById('selectAllPosts');
          if (sa) sa.checked = false;
        }
        updateStartButton();
      });

      section.appendChild(postEl);
    });
    
    results.appendChild(section);
  });

  // Re-attach event listeners
  attachPostEventListeners();
}

function attachPostEventListeners() {
  // Add Copy Event Listeners
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const text = e.target.dataset.text;
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.innerText;
        btn.innerText = 'Copied!';
        setTimeout(() => btn.innerText = original, 2000);
      });
    });
  });

  // Add Per-Post Analyze Event Listeners
  document.querySelectorAll('.btn-analyze-post').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetId = e.target.dataset.target;
      const container = document.getElementById(`analysis-${targetId}`);
      const commentsText = e.target.closest('.post').dataset.commentsText || '';
      
      if (container.style.display === 'block') {
        container.style.display = 'none';
        return;
      }
      
      const keywords = extractKeywords(commentsText);
      const keywordHtml = keywords.length > 0 
        ? keywords.map(kw => `<span class="keyword-tag">🏷️ ${escapeHtml(kw)}</span>`).join('')
        : '<span style="font-size: 0.7rem; color: var(--text-muted);">Not enough comment data. Try Deep Comment first!</span>';

      container.innerHTML = `
        <span class="top-post-label" style="display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h4l3-9 5 18 3-9h5"/></svg>
          Audience Intent (Comments Analysis):
        </span>
        <div class="keyword-cloud" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
          ${keywordHtml}
        </div>
      `;
      container.style.display = 'block';
    });
  });

  // Add Deep Comment Event Listeners
  document.querySelectorAll('.btn-deep-comment').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = e.target.dataset.url;
      const fbid = e.target.dataset.fbid;
      const targetBtn = e.target;
      targetBtn.innerText = 'Initializing...';
      targetBtn.style.opacity = '0.7';
      targetBtn.disabled = true;
      targetBtn.id = `active-scraping-${fbid}`;

      chrome.runtime.sendMessage({
        type: 'START_DEEP_SCRAPE',
        url: url,
        fbid: fbid
      });
    });
  });

  // Add Group Analyze Event Listeners
  document.querySelectorAll('.btn-analyze').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gName = e.target.dataset.group;
      const filtered = currentPosts.filter(p => (p.groupName || 'Unknown Group') === gName);
      runAnalysis(gName, filtered);
    });
  });
}

function extractKeywords(text) {
  if (!text) return [];
  const stopWords = new Set(['yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'untuk', 'dengan', 'dalam', 'pada', 'adalah', 'sebagai', 'tidak', 'akan', 'ada', 'bisa', 'juga', 'kami', 'saya', 'mereka', 'sudah', 'atau', 'saat', 'oleh', 'menjadi', 'lagi', 'buat', 'apa', 'kita', 'kalau', 'karena', 'kalau', 'aja', 'sama', 'pun', 'belum', 'kalau', 'baru', 'hanya', 'lebih', 'saja', 'tapi', 'banyak', 'the', 'and', 'to', 'of', 'a', 'in', 'is', 'for', 'that', 'on', 'with', 'it', 'as', 'are', 'be', 'this', 'was', 'have', 'or', 'at', 'not', 'but', 'by', 'all', 'we']);
  
  const wordCounts = {};
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  words.forEach(word => {
    if (word.length > 3 && !stopWords.has(word) && isNaN(word)) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
  });

  return Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(entry => entry[0]);
}

function runAnalysis(groupName, posts) {
  const containerId = `analysis-${groupName.replace(/\s+/g, '-')}`;
  const container = document.getElementById(containerId);
  
  if (container.innerHTML !== '') {
    container.innerHTML = '';
    return;
  }

  const totalPosts = posts.length;
  const totalLikes = posts.reduce((sum, p) => sum + (p.likes || 0), 0);
  const totalComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0);
  const totalShares = posts.reduce((sum, p) => sum + (p.shares || 0), 0);
  const totalEngagement = totalLikes + totalComments + totalShares;
  const avgEngagement = (totalEngagement / totalPosts).toFixed(1);
  
  const topPost = [...posts].sort((a, b) => (b.likes + b.comments) - (a.likes + a.comments))[0];

  // Combine all texts
  const allText = posts.map(p => p.text).join(' ');
  const topKeywords = extractKeywords(allText);

  const keywordHtml = topKeywords.length > 0 
    ? topKeywords.map(kw => `<span class="keyword-tag">🏷️ ${escapeHtml(kw)}</span>`).join('')
    : '<span style="font-size: 0.7rem; color: var(--text-muted);">Not enough text data</span>';

  container.innerHTML = `
    <div class="analysis-dashboard">
      <div class="analysis-grid">
        <div class="analysis-item">
          <span class="analysis-label">Avg Engagement</span>
          <span class="analysis-value">🔥 ${avgEngagement}</span>
        </div>
        <div class="analysis-item">
          <span class="analysis-label">Total Interactions</span>
          <span class="analysis-value">📊 ${formatNumber(totalEngagement)}</span>
        </div>
      </div>
      
      <div class="keywords-preview" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.1);">
        <span class="top-post-label" style="display: flex; align-items: center; gap: 4px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h4l3-9 5 18 3-9h5"/></svg>
          Trending Keywords (Product Ideas):
        </span>
        <div class="keyword-cloud" style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
          ${keywordHtml}
        </div>
      </div>

      <div class="top-post-preview" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.1);">
        <span class="top-post-label">🏆 Top Performing Post:</span>
        <div class="post-text" style="font-size: 0.75rem; -webkit-line-clamp: 2;">${escapeHtml(topPost.text)}</div>
        <div class="stat" style="margin-top: 4px;">❤️ ${formatNumber(topPost.likes)} | 💬 ${formatNumber(topPost.comments)}</div>
      </div>
    </div>
  `;
}


// Group display functions removed

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
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function escapeCsv(str) {
  if (!str) return '';
  return str.replace(/"/g, '""').replace(/\n/g, ' ');
}
