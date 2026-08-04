import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import { join } from "path";
import { existsSync } from "fs";

function getTrayIcon(): Electron.NativeImage {
  const iconPath = join(__dirname, "../../resources/tray-icon.png");
  if (existsSync(iconPath)) {
    return nativeImage
      .createFromPath(iconPath)
      .resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

export class TrayService {
  private tray: Tray | null = null;
  private window: BrowserWindow;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.createTray();
  }

  private createTray(): void {
    const icon = getTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip("Lenvo Vantage Service");
    this.updateMenu();
    this.tray.on("click", () => this.toggleVisibility());
  }

  private updateMenu(): void {
    if (!this.tray) return;
    const isVisible = this.window.isVisible();
    const isAlwaysOnTop = this.window.isAlwaysOnTop();
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isVisible
          ? "Hide Interview Assistant"
          : "Show Interview Assistant",
        click: () => this.toggleVisibility(),
      },
      {
        label: isAlwaysOnTop ? "Disable Always-on-Top" : "Enable Always-on-Top",
        click: () => {
          this.window.setAlwaysOnTop(!this.window.isAlwaysOnTop());
          this.refreshMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          this.destroy();
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(contextMenu);
  }

  toggleVisibility(): void {
    if (this.window.isVisible()) {
      this.window.hide();
    } else {
      this.window.show();
      this.window.focus();
    }
    this.updateMenu();
  }

  refreshMenu(): void {
    this.updateMenu();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
