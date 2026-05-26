// popup.js - Minimal launcher for FB Scraper Pro

const btn = document.getElementById('scrapeBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');
const clearBtn = document.getElementById('clearBtn');
const status = document.getElementById('status');
const countBadge = document.getElementById('countBadge');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Load from storage to show count
  chrome.storage.local.get(['fb_intercepted_posts'], (result) => {
    if (result.fb_intercepted_posts) {
      countBadge.innerText = result.fb_intercepted_posts.length;
    }
  });

  // Listen for real-time updates to update the badge count live
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'DATA_UPDATED') {
      countBadge.innerText = msg.posts ? msg.posts.length : 0;
    }
  });
});

// Open Dashboard
if (openDashboardBtn) {
  openDashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });
}

// Start Scraping
if (btn) {
  btn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Check if on Facebook and specifically on a Group page
    if (!tab || !tab.url.includes('facebook.com')) {
      if (status) {
        status.innerText = 'Error: Buka halaman Facebook terlebih dahulu.';
        status.style.color = 'var(--danger)';
      }
      return;
    }

    if (!tab.url.includes('/groups/')) {
      if (status) {
        status.innerText = 'Error: Buka halaman Group Facebook (URL harus mengandung /groups/). Scrape beranda utama tidak diizinkan.';
        status.style.color = 'var(--danger)';
      }
      return;
    }

    btn.disabled = true;
    const original = btn.innerText;
    btn.innerText = 'Scraping Active...';
    if (status) {
      status.innerText = 'Scroll halaman untuk mengumpulkan post.';
      status.style.color = 'var(--success)';
    }

    const limitInput = document.getElementById('scrapeLimit');
    const targetLimit = limitInput && limitInput.value ? parseInt(limitInput.value) : null;
    
    try {
      await chrome.tabs.sendMessage(tab.id, { 
        type: 'START_SCRAPE',
        targetLimit: targetLimit
      });
    } catch (err) {
      if (status) {
        status.innerText = 'Error: Silakan refresh halaman Facebook Anda.';
        status.style.color = 'var(--danger)';
      }
    } finally {
      // Re-enable after a short delay to prevent spam clicking
      setTimeout(() => {
        btn.disabled = false;
        btn.innerText = original;
      }, 2000);
    }
  });
}

// Clear Data
if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear all captured data?')) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes('facebook.com')) {
      chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_DATA' }).catch(() => {});
    }
    chrome.storage.local.set({ fb_intercepted_posts: [], fb_auto_comment_log: [] });
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: 0 }).catch(() => {});
    countBadge.innerText = '0';
    if (status) {
      status.innerText = 'Data cleared.';
      status.style.color = 'var(--text-muted)';
    }
  });
}
