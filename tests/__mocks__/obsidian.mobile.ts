/**
 * Obsidian stub for integration tests — Platform.isDesktop is FALSE.
 * This causes S3ClientWrapper to use FetchHttpHandler (Node.js built-in fetch)
 * instead of ObsHttpHandler (Obsidian requestUrl), so real HTTP calls work.
 */

export const Platform = {
  isDesktop: false,
  isMobile: true,
};

export class Notice {
  constructor(public message: string, public timeout?: number) {}
  hide() {}
  setMessage(msg: string) { this.message = msg; }
}

export class Modal {
  app: any;
  contentEl: any = { empty: () => {}, addClass: () => {} };
  constructor(app: any) { this.app = app; }
  open() {}
  close() {}
}

export class Plugin {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) { this.app = app; this.manifest = manifest; }
  async loadData(): Promise<any> { return null; }
  async saveData(_data: any): Promise<void> {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void) { return {} as any; }
  addStatusBarItem() { return { createEl: () => ({ setText: () => {} }) } as any; }
  addCommand(_cmd: any) {}
  addSettingTab(_tab: any) {}
}

export class PluginSettingTab {
  constructor(public app: any, public plugin: any) {}
  display() {}
}

export class Setting {
  constructor(_container: any) {}
  setName(_n: string) { return this; }
  setDesc(_d: string) { return this; }
  addText(_cb: any) { return this; }
  addTextArea(_cb: any) { return this; }
  addToggle(_cb: any) { return this; }
  addDropdown(_cb: any) { return this; }
  addButton(_cb: any) { return this; }
  addSlider(_cb: any) { return this; }
  setWarning() { return this; }
}

export async function requestUrl(_params: any): Promise<any> {
  // Not called when Platform.isDesktop = false
  throw new Error("requestUrl should not be called in mobile/integration mode");
}
