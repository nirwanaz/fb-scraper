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
      // Note: we need access to 'grouped' from displayPosts, so we'll refactor slightly
      // or just re-calculate it. For simplicity, let's re-calculate or pass data.
      // But grouped is local to displayPosts. Let's make it more robust.
      const groupPosts = currentPosts.filter(p => (p.groupName || 'Unknown Group') === gName);
      runAnalysis(gName, groupPosts);
    });
  });
}
