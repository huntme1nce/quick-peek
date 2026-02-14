// Updated background.js

// Tab ID handler for tracking active tabs
let activeTabId = null;

chrome.tabs.onActivated.addListener((activeInfo) => {
    activeTabId = activeInfo.tabId;
});

// Cleanup function to handle unnecessary data or tasks
function cleanup() {
    console.log('Cleanup initiated.');
    // Add logic to cleanup resources
}

chrome.runtime.onSuspend.addListener(() => {
    cleanup();
});

// Other functionalities of background.js
// ...