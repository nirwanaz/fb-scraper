const btn = document.getElementById('scrapeBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const status = document.getElementById('status');
const results = document.getElementById('results');
const groupResults = document.getElementById('group-results');
const countBadge = document.getElementById('countBadge');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const filterInput = document.getElementById('filterInput');
const sortSelect = document.getElementById('sortSelect');
const exportGroupsBtn = document.getElementById('exportGroupsBtn');

let currentPosts = [];
let currentGroups = [];
let activeFilter = '';
let activeSort = 'newest';

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Load from storage
  chrome.storage.local.get(['fb_intercepted_posts', 'fb_discovered_groups'], (result) => {
    if (result.fb_intercepted_posts) currentPosts = result.fb_intercepted_posts;
    if (result.fb_discovered_groups) currentGroups = result.fb_discovered_groups;
    updateUI();
  });

  // Listen for real-time updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DATA_UPDATED') {
      currentPosts = msg.posts;
      currentGroups = msg.groups;
      updateUI();
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
});

function updateUI() {
  countBadge.innerText = currentPosts.length + currentGroups.length;
  exportBtn.disabled = currentPosts.length === 0;
  
  if (currentPosts.length > 0) {
    status.innerText = `${currentPosts.length} posts captured so far.`;
    displayPosts(currentPosts);
  } else {
    results.innerHTML = `<div class="empty-state"><div class="empty-icon">📥</div><p>No data captured yet.</p></div>`;
    status.innerText = 'Waiting for Facebook Group...';
  }

  if (currentGroups.length > 0) {
    displayGroups(currentGroups, currentPosts);
  } else {
    groupResults.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No groups discovered yet.</p></div>`;
  }
}

btn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes('facebook.com')) {
    status.innerText = 'Please navigate to a Facebook page.';
    return;
  }
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<span>Extracting...</span>';
  
  const limitInput = document.getElementById('scrapeLimit');
  const targetLimit = limitInput.value ? parseInt(limitInput.value) : null;
  
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
    status.innerText = 'Error: Please refresh the page.';
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

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

exportGroupsBtn.addEventListener('click', () => {
  if (currentGroups.length === 0) return;
  const headers = ['ID', 'Name', 'URL', 'Members', 'Activity', 'Score'];
  const csvRows = [headers.join(',')];
  currentGroups.forEach(group => {
    const row = [group.id, `"${escapeCsv(group.name)}"`, group.url, group.memberCount, group.postsPerDay, group.score];
    csvRows.push(row.join(','));
  });
  downloadCsv(csvRows.join('\n'), `fb-discovered-groups-${Date.now()}.csv`);
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all data?')) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_DATA' }).catch(() => {});
  currentPosts = []; currentGroups = [];
  chrome.storage.local.set({ fb_intercepted_posts: [], fb_discovered_groups: [] });
  chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: 0 }).catch(() => {});
  updateUI();
});

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
        <button class="btn-analyze" data-group="${escapeHtml(groupName)}">Analyze</button>
      </div>
    `;
    section.appendChild(header);

    // Analysis container
    const analysisContainer = document.createElement('div');
    analysisContainer.id = `analysis-${groupName.replace(/\s+/g, '-')}`;
    section.appendChild(analysisContainer);

    grouped[groupName].forEach(post => {
      const postEl = document.createElement('div');
      postEl.className = 'post';
      
      // Need a unique ID for the post to target its analysis container
      const safeId = `post-${post.fbid || Math.random().toString(36).substr(2, 9)}`;
      
      postEl.innerHTML = `
        <div class="post-header"><span class="post-author">${escapeHtml(post.author)}</span><span class="post-time">${escapeHtml(post.timestamp)}</span></div>
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
      `;
      section.appendChild(postEl);
      
      // Store post data temporarily on the element for easy access
      postEl.dataset.postText = post.text;
      postEl.dataset.commentsText = post.commentsText || '';
    });
    
    results.appendChild(section);
  });

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
      
      // Focus strictly on audience insights (comments)
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
      
      if (!url) {
        alert("Cannot find source URL for this post.");
        return;
      }

      const originalText = e.target.innerText;
      e.target.innerText = 'Scraping...';
      e.target.style.opacity = '0.7';
      e.target.disabled = true;

      chrome.runtime.sendMessage({
        type: 'START_DEEP_SCRAPE',
        url: url,
        fbid: fbid
      });

      // Reset button after 15 seconds (assumed completion time or timeout)
      setTimeout(() => {
        e.target.innerText = 'Done! Click Analyze';
        e.target.style.background = '#3b82f6';
        e.target.style.opacity = '1';
        e.target.disabled = false;
      }, 15000);
    });
  });

  // Add Group Analyze Event Listeners
  document.querySelectorAll('.btn-analyze').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const gName = e.target.dataset.group;
      runAnalysis(gName, grouped[gName]);
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


function displayGroups(groups, allPosts = []) {
  const sorted = [...groups].sort((a, b) => {
    const map = { 'High Potential': 4, 'Medium Potential': 3, 'Low': 2, '⭐ Linked from Post': 1 };
    const scoreA = map[a.score] || 0;
    const scoreB = map[b.score] || 0;
    return scoreB - scoreA;
  });

  groupResults.innerHTML = '';
  sorted.forEach(group => {
    // Calculate stats for this group if it has posts
    const groupPosts = allPosts.filter(p => String(p.groupId) === String(group.id) || p.groupName === group.name);
    const totalEngagement = groupPosts.reduce((sum, p) => sum + (p.likes || 0) + (p.comments || 0), 0);
    
    const isLinked = group.score.includes('Linked');
    
    const el = document.createElement('div');
    el.className = 'group-card';
    el.innerHTML = `
      <div class="group-info">
        <span class="group-name">${escapeHtml(group.name)}</span>
        <span class="potential-badge" style="background: ${group.scoreColor}22; color: ${group.scoreColor}">${group.score}</span>
      </div>
      <div class="group-meta">
        ${isLinked ? `
          <span>Captured: <span class="meta-val">${groupPosts.length} posts</span></span>
          <span>Engagement: <span class="meta-val">🔥 ${formatNumber(totalEngagement)}</span></span>
        ` : `
          <span>Members: <span class="meta-val">${formatNumber(group.memberCount)}</span></span>
          <span>Activity: <span class="meta-val">${group.postsPerDay} posts/day</span></span>
        `}
      </div>
      <div class="group-actions"><a href="${group.url}" target="_blank" class="btn-visit">Visit Group</a></div>
    `;
    groupResults.appendChild(el);
  });
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
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function escapeCsv(str) {
  if (!str) return '';
  return str.replace(/"/g, '""').replace(/\n/g, ' ');
}
