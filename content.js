// COMPLETE CONTENT SCRIPT WITH ALL FIXES AND FEATURES

const SYNC_KEYS = {
  ENABLED: "globalEnabled",
  DISPLAY_MODE: "displayMode",
  ACTIVE_PROFILE: "activeProfile",
  UNIFORM_CUE: "uniformCueColorEnabled",
  CUE_COLOR: "cueColor",
  NAME_AFTER: "nameAfterCueEnabled",
  NAME_COLOR: "nameColor",
  NAME_MAX: "nameAfterCueMaxWords",
  SCOPE_ENABLED: "scopeEnabled",
  SCOPE_SELECTOR: "scopeSelector",
  REPLACE_ENABLED: "replaceEnabled",
  REPLACED_COLOR: "replacedColor"
};

const LOCAL_KEYS = {
  GENERAL: "rules",
  CRICKET: "rulesCricket",
  MANTIS: "rulesMantis"
};

// FIX #1: Global cleanup tracking
let observer = null;
let debounce = null;
let lastApplyTime = 0;
let isCleanedUp = false;
let currentTabId = null;

// FIX #10: Cache for floating element detection
const floatingElementCache = new WeakMap();

// FIX #9: Rate limiting for storage access
let lastStorageRefresh = 0;
const STORAGE_REFRESH_COOLDOWN = 250;
const MIN_APPLY_INTERVAL = 350;
const MAX_QUEUE_TIME = 2000;
const TEXT_NODE_SIZE_LIMIT = 100000;
const TREE_WALKER_TIME_LIMIT = 100;

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\\\]]/g, "\\$&");
}

function normalizeDisplayMode(v) {
  const s = String(v || "all").toLowerCase();
  return (s === "all" || s === "between" || s === "match" || s === "cue") ? s : "all";
}

// FIX #14: Color validation
function isValidColor(color) {
  const s = String(color || "").trim();
  if (!s) return false;
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(s) ||
         /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(s) ||
         /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/.test(s);
}

function normalizeColor(color) {
  if (isValidColor(color)) return color;
  return "#FFF59D";
}

function isValidBetweenRule(r) {
  if (!r || r.mode !== "between") return false;

  const startText = typeof r?.startText === "string" ? r.startText.trim() : "";
  const endText = typeof r?.endText === "string" ? r.endText : "";
  const maxChars = Number(r?.betweenMaxChars ?? 180);

  // FIX #7: Validate max chars and prevent circular references
  if (startText.length === 0 || endText.length === 0) return false;
  if (maxChars < 20 || maxChars > 5000) return false;
  if (startText === endText) return false;
  if (startText.length > 100 || endText.length > 100) {
    console.warn('Between rule text too long (>100 chars), may cause performance issues');
    return false;
  }

  return true;
}

function buildWordRegex(word, caseSensitive) {
  const w = (word || "").trim();
  if (!w) return null;
  const flags = caseSensitive ? "gu" : "giu";
  const safe = escapeRegex(w);
  try {
    return new RegExp(
      `(?<!\\p{L}\\p{N}\\p{M}_)${safe}(?!\\p{L}\\p{N}\\p{M}_)`,
      flags
    );
  } catch (e) {
    console.error('Word regex compilation failed:', e);
    return null;
  }
}

function buildPhraseRegex(phrase, caseSensitive) {
  const text = (phrase || "").trim();
  if (!text) return null;
  const flags = caseSensitive ? "gu" : "giu";
  const tokens = text.split(/\\s+/).filter(Boolean).map(escapeRegex);
  if (!tokens.length) return null;
  const sep = `[\\s\\u00A0\\W_]+`;
  try {
    return new RegExp(tokens.join(sep), flags);
  } catch (e) {
    console.error('Phrase regex compilation failed:', e);
    return null;
  }
}

// FIX #15: Between regex with timeout protection
function buildBetweenRegex(startText, endText, maxChars, caseSensitive, ignorePatterns) {
  const s = (startText || "").trim();
  const e = endText || "";
  if (!s || !e) return null;

  const flags = caseSensitive ? "gu" : "giu";
  const sep = `[\\s\\u00A0\\W_]+`;

  const startTokens = s.split(/\\s+/).filter(Boolean).map(escapeRegex);
  const endTokens = e.split(/\\s+/).filter(Boolean).map(escapeRegex);

  if (startTokens.length === 0 || endTokens.length === 0) return null;

  const startRe = startTokens.join(sep);
  const endEscaped = escapeRegex(e);
  const filler = `(?:\\b(?:please|kindly|okay)\\b${sep})?`;
  const endRe = `${filler}${endEscaped}(?:[\\s\\u00A0\\W_]|$)`;

  const cap = Math.max(20, Math.min(500, Number(maxChars) || 180));

  // NEW: Handle ignore patterns - accepts ANYTHING
  let contentPattern = `[\\s\\S]{0,${cap}}?`;

  if (ignorePatterns && Array.isArray(ignorePatterns) && ignorePatterns.length > 0) {
    const validPatterns = ignorePatterns
      .filter(p => p && String(p).trim().length > 0)
      .map(p => escapeRegex(String(p)))
      .filter(Boolean);

    if (validPatterns.length > 0) {
      const patternsStr = validPatterns.join("|");
      try {
        contentPattern = `(?:(?!${patternsStr})[\\s\\S]){0,${cap}}?`;
      } catch (e) {
        console.warn('Error building ignore patterns, using fallback:', e);
        contentPattern = `[\\s\\S]{0,${cap}}?`;
      }
    }
  }

  try {
    const pattern = `${startRe}${contentPattern}${endRe}`;
    const testRegex = new RegExp(pattern, flags);

    // FIX #15: Test regex performance before returning
    const testString = "a".repeat(cap + 100);
    const startTime = performance.now();
    testRegex.test(testString);
    const elapsed = performance.now() - startTime;

    if (elapsed > 50) {
      console.warn('Between rule regex too slow:', {
        startText,
        endText,
        elapsed: elapsed.toFixed(2) + 'ms'
      });
      return null;
    }

    return testRegex;
  } catch (e) {
    console.error('Between regex compilation error:', e);
    return null;
  }
}

// FIX #6: Improved rule compilation with error handling
function compileRules(rules) {
  const compiled = [];
  const errors = [];

  for (const r of (rules || [])) {
    if (!r || r.enabled === false) continue;

    try {
      const mode = String(r.mode || "phrase").toLowerCase();

      if (mode === "between") {
        if (!isValidBetweenRule(r)) {
          errors.push({
            id: r.id,
            type: 'between',
            error: 'Invalid between rule'
          });
          continue;
        }

        const re = buildBetweenRegex(
          r.startText,
          r.endText,
          r.betweenMaxChars,
          r.caseSensitive,
          r.ignorePatterns
        );

        if (!re) {
          errors.push({
            id: r.id,
            type: 'between',
            error: 'Failed to compile regex'
          });
          continue;
        }

        compiled.push({
          ...r,
          mode: "between",
          _re: re,
          isCue: false,
          color: normalizeColor(r.color)
        });
        continue;
      }

      if (!r.text) {
        errors.push({
          id: r.id,
          type: mode,
          error: 'Missing text/pattern'
        });
        continue;
      }

      let re = null;

      if (mode === "regex") {
        try {
          re = new RegExp(r.text, r.caseSensitive ? "gu" : "giu");
        } catch (e) {
          errors.push({
            id: r.id,
            type: 'regex',
            error: e.message
          });
          continue;
        }
      } else if (mode === "word") {
        re = buildWordRegex(r.text, r.caseSensitive);
      } else {
        re = buildPhraseRegex(r.text, r.caseSensitive);
      }

      if (!re) {
        errors.push({
          id: r.id,
          type: mode,
          error: 'Failed to compile pattern'
        });
        continue;
      }

      compiled.push({
        ...r,
        mode,
        _re: re,
        isCue: r.isCue === true,
        replaceWith: (typeof r.replaceWith === "string" ? r.replaceWith : ""),
        color: normalizeColor(r.color)
      });
    } catch (e) {
      errors.push({
        id: r.id,
        error: e.message
      });
    }
  }

  if (errors.length > 0) {
    console.warn('Rule compilation errors:', errors);
  }

  return compiled;
}

function findNameSpan(big, startIndex, maxWords) {
  const allowedParticles = new Set(["de", "del", "la", "van", "von", "da", "di", "of"]);
  const isLetter = (ch) => /\p{L}/u.test(ch);

  let i = startIndex;
  while (i < big.length && /[\s\u00A0\W_]/u.test(big[i])) i++;

  const words = [];
  let nameStart = i;
  let nameEnd = i;

  while (i < big.length && words.length < maxWords) {
    if (/[.!?:\n\r]/u.test(big[i])) break;

    let wStart = i;
    while (i < big.length && (isLetter(big[i]) || big[i] === "'" || big[i] === "-")) i++;
    let wEnd = i;

    const w = big.slice(wStart, wEnd);
    const lower = w.toLowerCase();
    if (!w) {
      i++;
      continue;
    }

    const first = w[0];
    const looksCapitalized = first && first.toUpperCase() === first && first.toLowerCase() !== first;

    if (looksCapitalized || (words.length > 0 && allowedParticles.has(lower))) {
      if (words.length === 0) nameStart = wStart;
      words.push(w);
      nameEnd = wEnd;
    } else {
      if (words.length > 0) break;
    }

    while (i < big.length && /[\s\u00A0\W_]/u.test(big[i])) {
      if (/[.!?:\n\r]/u.test(big[i])) break;
      i++;
    }
  }

  if (words.length === 0) return null;
  return { start: nameStart, end: nameEnd };
}

let state = {
  enabled: true,
  displayMode: "all",
  activeProfile: "general",
  compiled: [],
  uniformCueColorEnabled: true,
  cueColor: "#FFF59D",
  nameAfterCueEnabled: true,
  nameColor: "#80DEEA",
  nameMax: 4,
  scopeEnabled: false,
  scopeSelector: "",
  replaceEnabled: false,
  replacedColor: "#C8E6C9"
};

// FIX #10: Optimized floating element detection with caching
function isFloatingElement(el) {
  if (!el) return false;

  if (floatingElementCache.has(el)) {
    return floatingElementCache.get(el);
  }

  let isFloating = false;

  try {
    const style = window.getComputedStyle(el);
    const position = style.position;
    const zIndex = parseInt(style.zIndex, 10);

    if (position === "fixed" || position === "sticky") {
      isFloating = true;
    } else if (!isNaN(zIndex) && zIndex > 999) {
      isFloating = true;
    } else {
      const classList = el.className?.toLowerCase() || "";
      const id = el.id?.toLowerCase() || "";
      const tag = el.tagName?.toLowerCase() || "";

      const floatingPatterns = [
        "modal", "dialog", "popup", "tooltip", "overlay", "floating",
        "dropdown", "menu", "sidebar", "drawer", "sheet", "panel",
        "extension", "bookmarklet", "floating-widget"
      ];

      for (const pattern of floatingPatterns) {
        if (classList.includes(pattern) || id.includes(pattern)) {
          isFloating = true;
          break;
        }
      }

      if (tag === "iframe") {
        isFloating = true;
      }
    }
  } catch (e) {
    console.warn('Error detecting floating element:', e);
    isFloating = true;
  }

  floatingElementCache.set(el, isFloating);
  return isFloating;
}

// NEW: Get current tab ID
async function getCurrentTabId() {
  if (currentTabId) return currentTabId;
  try {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, (response) => {
        currentTabId = response?.tabId;
        resolve(currentTabId);
      });
    });
  } catch (e) {
    console.warn('Could not get tab ID:', e);
    return null;
  }
}

// FIX #9: Rate limited storage refresh with per-tab support
async function refreshFromStorage() {
  const now = performance.now();
  if (now - lastStorageRefresh < STORAGE_REFRESH_COOLDOWN) {
    return;
  }
  lastStorageRefresh = now;

  try {
    const tabId = await getCurrentTabId();

    // NEW: Check if THIS TAB is enabled (not global)
    if (tabId) {
      const tabState = await chrome.storage.session.get([
        `tab_${tabId}_enabled`,
        `tab_${tabId}_profile`,
        `tab_${tabId}_replaceEnabled`
      ]);

      const tabEnabled = tabState[`tab_${tabId}_enabled`] !== false;

      if (!tabEnabled) {
        state.enabled = false;
        state.compiled = [];
        clearAllHighlights();
        return;
      }

      // Get profile for THIS TAB
      state.activeProfile = (tabState[`tab_${tabId}_profile`] || "general").toLowerCase();
      state.replaceEnabled = tabState[`tab_${tabId}_replaceEnabled`] === true;
    }

    const sync = await chrome.storage.sync.get(Object.values(SYNC_KEYS));
    const local = await chrome.storage.local.get([
      LOCAL_KEYS.GENERAL,
      LOCAL_KEYS.CRICKET,
      LOCAL_KEYS.MANTIS
    ]);

    state.enabled = true;
    state.displayMode = normalizeDisplayMode(sync[SYNC_KEYS.DISPLAY_MODE] || "all");
    state.replacedColor = normalizeColor(sync[SYNC_KEYS.REPLACED_COLOR] || "#C8E6C9");

    const generalRules = Array.isArray(local[LOCAL_KEYS.GENERAL]) ? local[LOCAL_KEYS.GENERAL] : [];
    const cricketRules = Array.isArray(local[LOCAL_KEYS.CRICKET]) ? local[LOCAL_KEYS.CRICKET] : [];
    const mantisRules = Array.isArray(local[LOCAL_KEYS.MANTIS]) ? local[LOCAL_KEYS.MANTIS] : [];

    const profileRules =
      state.activeProfile === "cricket" ? cricketRules :
      state.activeProfile === "mantis" ? mantisRules :
      [];

    let compiledGeneral = compileRules(generalRules);
    let compiledProfile = compileRules(profileRules);

    compiledProfile = compiledProfile.filter(
      r => r.mode !== "between" && (r.mode === "word" || r.mode === "phrase")
    );

    function filterByDisplayMode(arr) {
      let out = arr;
      if (state.displayMode === "between") {
        out = out.filter(r => r.mode === "between");
      } else if (state.displayMode === "match") {
        out = out.filter(r => r.mode !== "between");
      } else if (state.displayMode === "cue") {
        out = out.filter(r => r.mode !== "between" && r.isCue === true);
      }
      return out;
    }

    compiledGeneral = filterByDisplayMode(compiledGeneral);
    compiledProfile = filterByDisplayMode(compiledProfile);

    state.compiled = compiledGeneral.concat(compiledProfile);

    state.uniformCueColorEnabled = sync[SYNC_KEYS.UNIFORM_CUE] === true;
    state.cueColor = normalizeColor(sync[SYNC_KEYS.CUE_COLOR] || "#FFF59D");

    state.nameAfterCueEnabled = sync[SYNC_KEYS.NAME_AFTER] === true;
    state.nameColor = normalizeColor(sync[SYNC_KEYS.NAME_COLOR] || "#80DEEA");
    state.nameMax = Math.max(1, Math.min(10, Number(sync[SYNC_KEYS.NAME_MAX]) || 4));

    state.scopeEnabled = sync[SYNC_KEYS.SCOPE_ENABLED] === true;
    state.scopeSelector = (sync[SYNC_KEYS.SCOPE_SELECTOR] || "").trim();
  } catch (e) {
    console.error('Error refreshing from storage:', e);
  }
}

function getRoot() {
  if (!state.scopeEnabled || !state.scopeSelector) {
    let root = null;

    const candidates = [
      document.querySelector("main"),
      document.querySelector("article"),
      document.querySelector('[role="main"]'),
      document.querySelector('[role="article"]')
    ];

    for (const candidate of candidates) {
      if (candidate && !isFloatingElement(candidate)) {
        root = candidate;
        break;
      }
    }

    if (!root) {
      root = document.body;
    }

    return root;
  }

  const el = document.querySelector(state.scopeSelector);
  return el || document.body;
}

function isSlateRoot(root) {
  return Boolean(
    root.querySelector("[data-slate-editor]") ||
    root.querySelector("[data-slate-node]") ||
    root.querySelector("[data-slate-leaf]") ||
    root.querySelector("[data-slate-string]")
  );
}

function isSkippableTextNode(node) {
  if (!node || !node.parentElement) return true;
  const el = node.parentElement;
  const tag = el.tagName?.toLowerCase();

  // FIX #12: Skip if text node is suspiciously large
  const textLength = (node.nodeValue || "").length;
  if (textLength > TEXT_NODE_SIZE_LIMIT) {
    return true;
  }

  if (isFloatingElement(el)) return true;

  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (isFloatingElement(parent)) return true;
    parent = parent.parentElement;
  }

  return (
    tag === "script" || tag === "style" || tag === "noscript" ||
    tag === "textarea" || tag === "input" ||
    el.closest("[contenteditable='true']") ||
    el.closest("mark[data-th-rule]") ||
    el.closest("mark[data-th-name]")
  );
}

function clearHighlightsMarks(root) {
  if (!root) return;
  try {
    root.querySelectorAll("mark[data-th-rule], mark[data-th-name]").forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  } catch (e) {
    console.warn('Error clearing highlights:', e);
  }
}

// FIX #4: Optimized text node collection with timeout protection
function collectTextNodes(root, limit = 50000) {
  const nodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return isSkippableTextNode(node) ?
          NodeFilter.FILTER_REJECT :
          NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let n;
  const startTime = performance.now();

  while ((n = walker.nextNode())) {
    nodes.push(n);
    if (nodes.length >= limit) break;

    if (nodes.length % 1000 === 0) {
      if (performance.now() - startTime > TREE_WALKER_TIME_LIMIT) {
        console.warn('Text node collection timeout - collected', nodes.length);
        break;
      }
    }
  }

  return nodes;
}

function wrapRangeInTextNode(node, start, end, attrs, color, replacedText = null) {
  try {
    const text = node.nodeValue || "";
    const before = text.slice(0, start);
    const mid = text.slice(start, end);
    const after = text.slice(end);

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));

    const mark = document.createElement("mark");
    for (const [k, v] of Object.entries(attrs)) {
      mark.setAttribute(k, v);
    }

    mark.style.backgroundColor = normalizeColor(color);
    mark.style.padding = "0 2px";
    mark.style.borderRadius = "3px";
    mark.style.userSelect = "text";
    mark.style.pointerEvents = "none";
    mark.textContent = (replacedText !== null) ? replacedText : mid;
    frag.appendChild(mark);

    if (after) frag.appendChild(document.createTextNode(after));
    node.parentNode.replaceChild(frag, node);
  } catch (e) {
    console.warn('Error wrapping text node:', e);
  }
}

// FIX #2: Safe regex execution wrapper
function executeRegexSafely(regex, text) {
  const matches = [];
  try {
    const re = new RegExp(regex.source, regex.flags);
    re.lastIndex = 0;

    let m;
    let iterations = 0;
    const maxIterations = 10000;

    while ((m = re.exec(text)) !== null && iterations < maxIterations) {
      iterations++;
      if (!m[0]) break;
      matches.push(m);
      if (re.lastIndex === m.index) re.lastIndex++;
    }

    if (iterations >= maxIterations) {
      console.warn('Regex execution hit max iterations');
    }
  } catch (e) {
    console.error('Regex execution error:', e);
  }

  return matches;
}

function applyWithMarks(root) {
  if (!root) return;

  clearHighlightsMarks(root);
  if (!state.enabled || !state.compiled.length) return;

  const textNodes = collectTextNodes(root, 50000);
  if (!textNodes.length) return;

  // Replacement (Cricket/Mantis)
  if (state.activeProfile === "cricket" || state.activeProfile === "mantis") {
    const replRules = state.compiled.filter(
      r => r.mode !== "between" &&
      typeof r.replaceWith === "string" &&
      r.replaceWith.length > 0
    );

    if (replRules.length) {
      for (const node of textNodes) {
        try {
          let t = node.nodeValue || "";
          let outText = t;

          for (const rule of replRules) {
            const matches = executeRegexSafely(rule._re, outText);
            if (matches.length > 0) {
              const re = new RegExp(rule._re.source, rule._re.flags);
              re.lastIndex = 0;
              outText = outText.replace(re, rule.replaceWith);
            }
          }

          if (outText !== t) {
            node.nodeValue = outText;
          }
        } catch (e) {
          console.warn('Error during replacement:', e);
        }
      }
    }
  }

  // FIX #8: Optimized string building using array join
  const textContent = [];
  const starts = new Array(textNodes.length);
  const lens = new Array(textNodes.length);

  for (let i = 0; i < textNodes.length; i++) {
    const t = textNodes[i].nodeValue || "";
    starts[i] = textContent.join("").length;
    lens[i] = t.length;
    textContent.push(t);
    textContent.push(" ");
  }

  const big = textContent.join(""
  
  // FIX #3: Collect matches without storing DOM references
  const matches = [];

  try {
    for (const rule of state.compiled) {
      const regexMatches = executeRegexSafely(rule._re, big);

      for (const m of regexMatches) {
        if (!m[0]) break;

        if (rule.mode === "between") {
          const inner = m[1] ?? "";
          if (inner.trim().length) {
            const full = m[0];
            const innerRel = full.indexOf(inner);
            if (innerRel >= 0) {
              const start = m.index + innerRel;
              const end = start + inner.length;

              let s = start, e = end;
              while (s < e && /\s/u.test(big[s])) s++;
              while (e > s && /\s/u.test(big[e - 1])) e--;

              if (e > s) {
                matches.push({
                  start: s,
                  end: e,
                  type: "between",
                  ruleId: rule.id,
                  color: rule.color || "#FFF59D",
                  priority: 4
                });
              }
            }
          }
          continue;
        }

        const cueColor = (rule.isCue && state.uniformCueColorEnabled) ?
          state.cueColor :
          (rule.color || "#FFF59D");

        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          type: "rule",
          ruleId: rule.id,
          color: cueColor,
          priority: 2
        });

        const doReplace = state.replaceEnabled &&
          typeof rule.replaceWith === "string" &&
          rule.replaceWith.length > 0;

        if (doReplace) {
          matches[matches.length - 1].replaced = true;
          matches[matches.length - 1].replacement = rule.replaceWith;
          matches[matches.length - 1].color = state.replacedColor;
          matches[matches.length - 1].priority = 5;
        }

        if (rule.isCue && state.nameAfterCueEnabled) {
          const nameSpan = findNameSpan(big, m.index + m[0].length, state.nameMax);
          if (nameSpan) {
            matches.push({
              start: nameSpan.start,
              end: nameSpan.end,
              type: "name",
              ruleId: rule.id,
              color: state.nameColor,
              priority: 3
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('Error processing matches:', e);
  }

  if (!matches.length) {
    textContent.length = 0;
    return;
  }

  matches.sort((a, b) => b.start - a.start || b.priority - a.priority);

  try {
    for (const match of matches) {
      let i = 0;
      while (i < starts.length && starts[i] + lens[i] < match.start) i++;

      for (; i < starts.length; i++) {
        const nodeStart = starts[i];
        const nodeEnd = nodeStart + lens[i];
        if (nodeStart > match.end) break;

        const segStart = Math.max(match.start, nodeStart);
        const segEnd = Math.min(match.end, nodeEnd);

        if (segStart < segEnd) {
          const node = textNodes[i];
          if (!node || !node.parentNode) continue;

          const localStart = segStart - nodeStart;
          const localEnd = segEnd - nodeStart;

          const attrs =
            (match.type === "name")
              ? { "data-th-name": "1", "data-th-cue": match.ruleId }
              : { "data-th-rule": match.ruleId };

          const replacedText = match.replaced ? (match.replacement ?? "") : null;
          if (match.replaced) attrs["data-th-replaced"] = "1";

          wrapRangeInTextNode(node, localStart, localEnd, attrs, match.color, replacedText);
        }
      }
    }
  } catch (e) {
    console.error('Error applying matches:', e);
  }

  textContent.length = 0;
  matches.length = 0;
}

function clearSlateHighlights(root) {
  if (!root) return;
  try {
    root.querySelectorAll("[data-th-slate='1']").forEach(el => {
      const prev = el.getAttribute("data-th-prev-bg");
      if (prev === null) el.style.removeProperty("background-color");
      else el.style.backgroundColor = prev;

      const prevPad = el.getAttribute("data-th-prev-pad");
      if (prevPad === null) el.style.removeProperty("padding");
      else el.style.padding = prevPad;

      const prevRad = el.getAttribute("data-th-prev-rad");
      if (prevRad === null) el.style.removeProperty("border-radius");
      else el.style.borderRadius = prevRad;

      el.removeAttribute("data-th-slate");
      el.removeAttribute("data-th-prev-bg");
      el.removeAttribute("data-th-prev-pad");
      el.removeAttribute("data-th-prev-rad");
    });
  } catch (e) {
    console.warn('Error clearing slate highlights:', e);
  }
}

function collectSlateTextSpans(root, limit = 120000) {
  let spans = Array.from(root.querySelectorAll("span.word"));
  if (!spans.length) {
    spans = Array.from(root.querySelectorAll("[data-slate-string]"));
  }

  spans = spans.filter(s => (s.textContent || "").trim().length > 0);

  spans = spans.filter(s => {
    let el = s;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isFloatingElement(el)) return false;
      el = el.parentElement;
    }
    return true;
  });

  if (spans.length > limit) spans = spans.slice(0, limit);
  return spans;
}

function applySlateStyles(root) {
  if (!root) return;

  clearSlateHighlights(root);
  if (!state.enabled || !state.compiled.length) return;

  const spans = collectSlateTextSpans(root, 120000);
  if (!spans.length) return;

  let replacedSpan = new Array(spans.length).fill(false);

  if (state.replaceEnabled) {
    for (let i = 0; i < spans.length; i++) {
      try {
        const el = spans[i];
        if (el.closest("[contenteditable='true']")) continue;

        let txt = el.textContent || "";
        let changed = false;

        for (const rule of state.compiled) {
          if (!rule || !rule._re) continue;
          if (!(rule.mode === "word" || rule.mode === "phrase" || rule.mode === "regex")) continue;

          const rep = (typeof rule.replaceWith === "string") ? rule.replaceWith : "";
          if (!rep) continue;

          const re = new RegExp(rule._re.source, rule._re.flags);
          re.lastIndex = 0;
          if (re.test(txt)) {
            txt = txt.replace(re, rep);
            changed = true;
          }
        }

        if (changed) {
          el.textContent = txt;
          replacedSpan[i] = true;
        }
      } catch (e) {
        console.warn('Error during Slate replacement:', e);
      }
    }
  }

  const starts = new Array(spans.length);
  const lens = new Array(spans.length);

  let big = "";
  for (let i = 0; i < spans.length; i++) {
    const t = spans[i].textContent || "";
    starts[i] = big.length;
    lens[i] = t.length;
    big += t;
    big += " ";
  }

  const matches = [];

  try {
    for (const rule of state.compiled) {
      const regexMatches = executeRegexSafely(rule._re, big);

      for (const m of regexMatches) {
        if (!m[0]) break;

        if (rule.mode === "between") {
          const inner = m[1] ?? "";
          if (inner.trim().length) {
            const full = m[0];
            const innerRel = full.indexOf(inner);
            if (innerRel >= 0) {
              const start = m.index + innerRel;
              const end = start + inner.length;

              let s = start, e = end;
              while (s < e && /\s/u.test(big[s])) s++;
              while (e > s && /\s/u.test(big[e - 1])) e--;

              if (e > s) {
                matches.push({
                  start: s,
                  end: e,
                  type: "between",
                  ruleId: rule.id,
                  color: rule.color || "#FFF59D",
                  priority: 4
                });
              }
            }
          }
          continue;
        }

        const cueColor = (rule.isCue && state.uniformCueColorEnabled) ?
          state.cueColor :
          (rule.color || "#FFF59D");

        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          type: "rule",
          ruleId: rule.id,
          color: cueColor,
          priority: 2
        });

        if (rule.isCue && state.nameAfterCueEnabled) {
          const nameSpan = findNameSpan(big, m.index + m[0].length, state.nameMax);
          if (nameSpan) {
            matches.push({
              start: nameSpan.start,
              end: nameSpan.end,
              type: "name",
              ruleId: rule.id,
              color: state.nameColor,
              priority: 3
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('Error processing Slate matches:', e);
  }

  if (!matches.length) return;

  const bestPriority = new Array(spans.length).fill(-1);
  const bestColor = new Array(spans.length).fill(null);

  for (const match of matches) {
    let i = 0;
    while (i < starts.length && starts[i] + lens[i] < match.start) i++;

    for (; i < starts.length; i++) {
      const s0 = starts[i];
      const s1 = s0 + lens[i];
      if (s0 > match.end) break;

      const overlap = Math.max(match.start, s0) < Math.min(match.end, s1);
      if (!overlap) continue;

      if (match.priority > bestPriority[i]) {
        bestPriority[i] = match.priority;
        bestColor[i] = match.color;
      }
    }
  }

  try {
    for (let i = 0; i < spans.length; i++) {
      if (!bestColor[i]) continue;
      const el = spans[i];

      if (!el.hasAttribute("data-th-slate")) {
        el.setAttribute("data-th-slate", "1");
        el.setAttribute("data-th-prev-bg", el.style.backgroundColor || "");
        el.setAttribute("data-th-prev-pad", el.style.padding || "");
        el.setAttribute("data-th-prev-rad", el.style.borderRadius || "");
      }

      const bg = (typeof replacedSpan !== "undefined" && replacedSpan[i]) ?
        state.replacedColor :
        bestColor[i];

      el.style.backgroundColor = normalizeColor(bg);
      el.style.padding = "0 2px";
      el.style.borderRadius = "3px";
    }
  } catch (e) {
    console.error('Error applying Slate styles:', e);
  }
}

function applyNow() {
  if (isCleanedUp) return;

  try {
    const root = getRoot();
    if (!root) return;

    if (isSlateRoot(root)) {
      applySlateStyles(root);
    } else {
      applyWithMarks(root);
    }
  } catch (e) {
    console.error('Error applying highlights:', e);
  }
}

async function refreshAndApply() {
  if (isCleanedUp) return;

  try {
    await refreshFromStorage();
    applyNow();
  } catch (e) {
    console.error('Error in refreshAndApply:', e);
  }
}

function clearAllHighlights() {
  try {
    const root = document.body;
    if (root) {
      clearHighlightsMarks(root);
      clearSlateHighlights(root);
    }
  } catch (e) {
    console.warn('Error clearing highlights:', e);
  }
}

// FIX #1: Observer lifecycle management
function startObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver(() => {
    if (isCleanedUp) return;

    clearTimeout(debounce);

    // FIX #5: Improved debounce with max queue time
    const timeSinceLastApply = performance.now() - lastApplyTime;
    const delay = Math.max(0, MIN_APPLY_INTERVAL - timeSinceLastApply);

    debounce = setTimeout(() => {
      if (!isCleanedUp && state.enabled && state.compiled.length) {
        applyNow();
        lastApplyTime = performance.now();
      }
    }, Math.min(delay, MAX_QUEUE_TIME));
  });

  try {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ['style', 'class', 'id']
    });
  } catch (e) {
    console.warn('Error starting observer:', e);
  }
}

// FIX #1: Cleanup function
function cleanup() {
  if (isCleanedUp) return;
  isCleanedUp = true;
  
  try {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }

    state.compiled = [];
    console.debug('Content script cleanup completed');
  } catch (e) {
    console.warn('Error during cleanup:', e);
  }
}

window.addEventListener('beforeunload', cleanup);
window.addEventListener('unload', cleanup);

(async () => {
  try {
    currentTabId = await getCurrentTabId();
    await refreshAndApply();
    startObserver();
  } catch (e) {
    console.error('Initialization error:', e);
  }
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (isCleanedUp) return;
  if (!msg || typeof msg.type !== "string") return;

  try {
    if (msg.type === "APPLY_HIGHLIGHTS_NOW") {
      refreshAndApply();
    } else if (msg.type === "SET_ACTIVE_PROFILE") {
      refreshAndApply();
    }
  } catch (e) {
    console.error('Error handling message:', e);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (isCleanedUp) return;
  if (area === "local" || area === "sync") {
    refreshAndApply();
  }
});