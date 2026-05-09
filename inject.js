(function() {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  // Intercept Fetch
  window.fetch = async (...args) => {
    const response = await ORIGINAL_FETCH(...args);
    const url = args[0] instanceof Request ? args[0].url : args[0];

    if (url.includes('/api/graphql/')) {
      const clone = response.clone();
      clone.text().then(text => {
        handleGraphQLResponse(text, url);
      }).catch(err => console.error('Error reading fetch response:', err));
    }
    return response;
  };

  // Intercept XHR
  XMLHttpRequest.prototype.send = function(body) {
    this.addEventListener('load', function() {
      if (this.responseURL && this.responseURL.includes('/api/graphql/')) {
        handleGraphQLResponse(this.responseText, this.responseURL);
      }
    });
    return ORIGINAL_XHR_SEND.apply(this, arguments);
  };

  function handleGraphQLResponse(text, url) {
    try {
      // Facebook responses often start with for (;;);
      const cleanText = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
      
      // Some responses are newline-delimited JSON or multiple JSON objects
      const lines = cleanText.split('\n').filter(l => l.trim() !== '');
      
      lines.forEach(line => {
        try {
          const data = JSON.parse(line);
          processData(data);
        } catch (e) {
          // Could be a partial JSON chunk or non-JSON
        }
      });
    } catch (err) {
      // console.error('Failed to parse GraphQL response:', err);
    }
  }

  function processData(data) {
    // Check if this is a group post feed response
    // Look for patterns like "nodes", "comet_sections", "story"
    // We send everything to content.js for filtering to keep inject.js light
    window.postMessage({
      type: 'FB_GRAPHQL_DATA',
      data: data
    }, '*');
  }

  console.log('Facebook GraphQL Interceptor Injected');
})();
