document.addEventListener("DOMContentLoaded", async () => {
  const enableBtn = document.getElementById("enableBtn");
  const cricketBtn = document.getElementById("cricketBtn");
  const mantisBtn = document.getElementById("mantisBtn");
  const replaceBtn = document.getElementById("replaceBtn");
  const openOptionsBtn = document.getElementById("openOptions");

  // Get current tab ID
  async function getCurrentTabId() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id;
    } catch (e) {
      console.error('Error getting tab ID:', e);
      return null;
    }
  }

  // Get state for CURRENT TAB ONLY
  async function getState() {
    try {
      const tabId = await getCurrentTabId();
      if (!tabId) return { tabId: null, enabled: false, profile: "general", replaceEnabled: false };

      const tabState = await chrome.storage.session.get([
        `tab_${tabId}_enabled`,
        `tab_${tabId}_profile`,
        `tab_${tabId}_replaceEnabled`
      ]);

      return {
        tabId,
        enabled: tabState[`tab_${tabId}_enabled`] !== false,
        profile: (tabState[`tab_${tabId}_profile"] || "general").toLowerCase(),
        replaceEnabled: tabState[`tab_${tabId}_replaceEnabled`] === true
      };
    } catch (e) {
      console.error('Error getting state:', e);
      return { enabled: false, profile: "general", replaceEnabled: false };
    }
  }

  function setEnableLabel(enabled) {
    enableBtn.textContent = enabled ? "Disable on this tab" : "Enable on this tab";
    enableBtn.classList.toggle("ok", enabled);
  }

  function setReplaceLabel(on) {
    if (!replaceBtn) return;
    replaceBtn.textContent = on ? "Replace: On" : "Replace: Off";
    replaceBtn.classList.toggle("ok", on);
  }

  function setProfileActive(profile) {
    const p = String(profile || "general").toLowerCase();
    cricketBtn.classList.toggle("active", p === "cricket");
    mantisBtn.classList.toggle("active", p === "mantis");
  }

  // Safe message sending with error handling
  async function sendToActiveTab(payload) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, payload).catch(err => {
          console.debug('Content script not ready on this tab');
        });
      }
    } catch (e) {
      console.debug('Could not send message:', e.message);
    }
  }

  // Init UI
  try {
    const st = await getState();
    setEnableLabel(st.enabled);
    setReplaceLabel(st.replaceEnabled);
    setProfileActive(st.profile);
  } catch (e) {
    console.error('Error initializing popup:', e);
  }

  // Enable/Disable toggle (PER TAB)
  enableBtn.addEventListener("click", async () => {
    try {
      const st = await getState();
      const nextEnabled = !st.enabled;

      if (st.tabId) {
        await chrome.storage.session.set({
          [`tab_${st.tabId}_enabled`]: nextEnabled
        });
      }

      await sendToActiveTab({ type: "APPLY_HIGHLIGHTS_NOW" });
      setEnableLabel(nextEnabled);
      window.close();
    } catch (e) {
      console.error('Error toggling enable:', e);
    }
  });

  // Choose profile (PER TAB)
  async function chooseProfile(profile) {
    try {
      const st = await getState();
      if (st.tabId) {
        await chrome.storage.session.set({
          [`tab_${st.tabId}_enabled`]: true,
          [`tab_${st.tabId}_profile`]: profile
        });
      }
      await sendToActiveTab({ type: "SET_ACTIVE_PROFILE", profile, apply: true });
      setEnableLabel(true);
      setProfileActive(profile);
    } catch (e) {
      console.error('Error choosing profile:', e);
    }
  }

  cricketBtn.addEventListener("click", () => chooseProfile("cricket"));
  mantisBtn.addEventListener("click", () => chooseProfile("mantis"));

  // Replace toggle (PER TAB)
  if (replaceBtn) {
    replaceBtn.addEventListener("click", async () => {
      try {
        const st = await getState();
        const next = !st.replaceEnabled;

        if (st.tabId) {
          await chrome.storage.session.set({
            [`tab_${st.tabId}_replaceEnabled`]: next
          });
        }

        await sendToActiveTab({ type: "APPLY_HIGHLIGHTS_NOW" });
        setReplaceLabel(next);
        window.close();
      } catch (e) {
        console.error('Error toggling replace:', e);
      }
    });
  }

  openOptionsBtn.addEventListener("click", () => {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      console.error('Error opening options:', e);
    }
  });
});