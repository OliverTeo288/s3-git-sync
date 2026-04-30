/**
 * Minimal stub of the Obsidian API for unit tests.
 * Only the symbols actually referenced in src/ need to be present.
 */

export const Platform = {
  isDesktop: true,
  isMobile: false,
};

export class Notice {
  constructor(public message: string, public timeout?: number) {}
  hide() {}
  setMessage(msg: string) {
    this.message = msg;
  }
}

export class Modal {
  app: any;
  contentEl: HTMLElement = {
    empty: () => {},
    addClass: () => {},
    createEl: () => ({ setText: () => {}, hide: () => {}, show: () => {} } as any),
    createDiv: () => ({} as any),
    createSpan: () => ({} as any),
    querySelectorAll: () => [] as any,
  } as any;

  constructor(app: any) {
    this.app = app;
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class Plugin {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData(): Promise<any> { return null; }
  async saveData(_data: any): Promise<void> {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void) { return {} as any; }
  addStatusBarItem() { return { createEl: () => ({ setText: () => {} }) } as any; }
  addCommand(_cmd: any) {}
  addSettingTab(_tab: any) {}
  registerInterval(_id: number) {}
  registerEvent(_evt: any) {}
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: any;
  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
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
  return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}
