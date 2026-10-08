chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL("dashboard.html"));
  if (tab.id && tab.url?.startsWith("https://pan.baidu.com/")) {
    url.searchParams.set("source", String(tab.id));
  }
  await chrome.tabs.create({ url: url.href });
});
