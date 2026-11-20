// Sandboxed preload: the only door between the panel page and the plugin's main process.
// It exposes named calls, never ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

const call = (name, ...args) => ipcRenderer.invoke(`popnow:${name}`, ...args);

contextBridge.exposeInMainWorld("popnow", {
  actions: () => call("actions"),
  status: () => call("status"),
  login: () => call("login"),
  cancelLogin: () => call("cancelLogin"),
  logout: () => call("logout"),
  balance: () => call("balance"),
  context: () => call("context"),
  price: (actionId, values) => call("price", actionId, values),
  create: (quoteId, choice) => call("create", quoteId, choice),
  stopWaiting: () => call("stopWaiting"),
  getCredits: () => call("getCredits"),
  openLibrary: () => call("openLibrary"),
  onStatus: (listener) => {
    const wrapped = (_event, text) => listener(String(text));
    ipcRenderer.on("popnow:status", wrapped);
    return () => ipcRenderer.removeListener("popnow:status", wrapped);
  },
});
