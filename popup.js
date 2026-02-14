// Updated popup.js to handle content script not loaded gracefully

function sendMessageToContentScript(message) {
    // Check if the content script is ready
    if (window.contentScriptReady) {
        // Send the message to the content script
        chrome.runtime.sendMessage(message);
    } else {
        console.error('Content script not loaded. Please try again later.');
    }
}

// Example: Sending a message when the popup is opened
document.addEventListener('DOMContentLoaded', function() {
    sendMessageToContentScript({ greeting: 'hello' });
});
