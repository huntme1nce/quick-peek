// options.js

// Rule management functions
const rules = [];

function addRule(rule) {
    rules.push(rule);
    saveRules();
}

function removeRule(rule) {
    const index = rules.indexOf(rule);
    if (index !== -1) {
        rules.splice(index, 1);
        saveRules();
    }
}

function getRules() {
    return rules;
}

// Settings persistence functions
function saveRules() {
    localStorage.setItem('rules', JSON.stringify(rules));
}

function loadRules() {
    const storedRules = localStorage.getItem('rules');
    if (storedRules) {
        rules.push(...JSON.parse(storedRules));
    }
}

// Initialization
loadRules();

// Example export
export { addRule, removeRule, getRules, saveRules, loadRules };