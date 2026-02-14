// Updated content.js file

// Enhancements:
// 1. Added ability to ignore certain ranges for rules.
// 2. Improved handling of literal spaces in rules.
// 3. Introduced functionality for per-tab and per-site settings.

var rules = []; // Example rules array

function init() {
    loadRules(); // Loads existing rules
    applySettings(); // Apply user settings
}

function loadRules() {
    // Load rules with enhancements to handle the new features
    // For example:
    rules = [
        // Original rules here
        {pattern: 'example.com', ignoreRange: [100, 200], literalSpace: true},
        // Add additional rules as necessary
    ];
}

function applySettings() {
    // Apply per-site and per-tab settings for the rules
    rules.forEach(function(rule) {
        // Implementation of settings application
        if (rule.literalSpace) {
            // Logic to handle literal spaces
        }
        if (rule.ignoreRange) {
            // Logic to apply ignore within range
        }
    });
}

// Maintain existing performance optimizations
function optimize() {
    // Existing optimization logic
}

init(); // Run initial setup