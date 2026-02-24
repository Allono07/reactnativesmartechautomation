const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smartech", {
  isDesktop: true,
  selectProjectDir: () => ipcRenderer.invoke("smartech:select-project-dir"),
  planIntegration: (options) => ipcRenderer.invoke("smartech:plan-integration", options),
  applyIntegration: (payload) => ipcRenderer.invoke("smartech:apply-integration", payload)
});
