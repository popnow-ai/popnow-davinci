/* The few Electron APIs the plugin's main process uses. Resolve bundles Electron (36.x in Resolve
   20.1), so there is no electron package to install; these declarations keep the build honest. */
declare module "electron" {
  interface WebContents {
    send(channel: string, ...args: unknown[]): void;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" | "allow" }): void;
    on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
  }
  interface IpcMainInvokeEvent {
    sender: WebContents;
  }
  export const app: {
    whenReady(): Promise<void>;
    on(event: "window-all-closed" | "before-quit", listener: () => void): void;
    quit(): void;
    getPath(name: "home" | "temp" | "videos" | "userData"): string;
  };
  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    loadFile(path: string): Promise<void>;
    webContents: WebContents;
    on(event: "closed", listener: () => void): void;
  }
  export const ipcMain: {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  };
  export const shell: {
    openExternal(url: string): Promise<void>;
  };
  export const nativeTheme: {
    shouldUseDarkColors: boolean;
  };
}
