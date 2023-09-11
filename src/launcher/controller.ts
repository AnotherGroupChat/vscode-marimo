import {
  Disposable,
  ExtensionContext,
  Terminal,
  TextDocument,
  Uri,
  env,
  window,
  workspace,
} from "vscode";
import { Config, composeUrl } from "./config";
import { getCurrentFile, isMarimoApp, ping } from "./utils";
import path from "node:path";
import { MarimoTerminal } from "./terminal";
import { MarimoPanelManager } from "./panel";
import { logger } from "../logger";
import { updateStatusBar } from "./status-bar";

export type AppMode = "edit" | "run";

export class MarimoController implements Disposable {
  public terminal: MarimoTerminal;
  private panel: MarimoPanelManager;

  public currentMode: AppMode | undefined;
  public active: boolean = false;
  public port: number | undefined;
  private logger = logger.createLogger(this.appName);

  constructor(
    private file: TextDocument,
    private extension: ExtensionContext,
    private onUpdate: () => void,
  ) {
    this.file = file;
    const workspaceFolder = workspace.workspaceFolders?.find((folder) =>
      file.uri.fsPath.startsWith(folder.uri.fsPath),
    )?.uri.fsPath;

    this.terminal = new MarimoTerminal(
      extension,
      file.uri.fsPath,
      workspaceFolder,
      this.appName,
    );
    this.panel = new MarimoPanelManager(this.appName);

    // Try to recover state
    this.tryRecoverState();
  }

  hasTerminal(term: Terminal) {
    return this.terminal.is(term);
  }

  async start(mode: AppMode, port: number) {
    this.extension.globalState.update(this.keyFor("mode"), mode);
    this.currentMode = mode;
    this.extension.globalState.update(this.keyFor("port"), port);
    this.port = port;
    const filePath = this.terminal.relativePathFor(this.file.uri.fsPath);

    await (mode === "edit"
      ? this.terminal.executeCommand(
          `marimo -d edit ${filePath} --port=${port} --headless`,
        )
      : this.terminal.executeCommand(
          `marimo -d run ${filePath} --port=${port} --headless`,
        ));

    this.active = true;
    this.onUpdate();
  }

  isWebviewActive() {
    return this.panel.isActive();
  }

  async open(browser = Config.browser) {
    // If already opened, just focus
    if (browser === "embedded" && this.panel.isReady()) {
      this.panel.show();
    }

    if (browser === "system") {
      // Close the panel if opened
      this.panel.dispose();
      env.openExternal(Uri.parse(this.url));
    } else if (browser === "embedded") {
      this.panel.create(this.url);
      this.panel.show();
    }
  }

  reloadPanel() {
    this.panel.reload();
  }

  async tryRecoverState() {
    if (!(await this.terminal.tryRecoverTerminal())) {
      return;
    }
    this.logger.log("terminal recovered");

    const port = +(
      this.extension.globalState.get<number>(this.keyFor("port")) || 0
    );
    if (!port) {
      return;
    }

    const url = composeUrl(port);

    if (!(await ping(url))) {
      return;
    }

    this.active = true;
    this.port = port;
    this.currentMode =
      this.extension.globalState.get(this.keyFor("mode")) || "edit";
    this.logger.log("state recovered");

    this.onUpdate();
    return true;
  }

  dispose() {
    this.panel.dispose();
    this.terminal.dispose();
    this.active = false;
    this.extension.globalState.update(this.keyFor("mode"), undefined);
    this.extension.globalState.update(this.keyFor("port"), undefined);
    this.onUpdate();
  }

  public get appName() {
    const filePath = this.file.uri.fsPath;
    const fileName = path.basename(filePath) || "app.py";
    const folderName = path.basename(path.dirname(filePath));
    return folderName ? `${folderName}/${fileName}` : fileName;
  }

  public get url() {
    if (!this.port) {
      return "";
    }
    return composeUrl(this.port);
  }

  private keyFor(key: string) {
    return `marimo.${this.file.uri.fsPath}.${key}`;
  }
}

const all = new Map<string, MarimoController>();

export const Controllers = {
  getControllerForActivePanel(): MarimoController | undefined {
    return [...all.values()].find((c) => c.isWebviewActive());
  },
  getOrCreate(
    file: TextDocument,
    extension: ExtensionContext,
  ): MarimoController {
    const key = file.uri.fsPath;
    if (all.has(key)) {
      return all.get(key)!;
    }
    const controller = new MarimoController(file, extension, () =>
      updateStatusBar(extension),
    );
    all.set(key, controller);
    return controller;
  },
  get(file: TextDocument | undefined): MarimoController | undefined {
    if (!file) {
      return;
    }
    return all.get(file.uri.fsPath);
  },
  findWithTerminal(term: Terminal): MarimoController | undefined {
    return [...all.values()].find((c) => c.terminal.is(term));
  },
  disposeAll() {
    for (const c of all.values()) c.dispose();
    all.clear();
  },
};

export function withController<T>(
  extension: ExtensionContext,
  fn: (controller: MarimoController) => T,
) {
  const activePanelController = Controllers.getControllerForActivePanel();
  if (activePanelController) {
    return fn(activePanelController);
  }

  const file = getCurrentFile();
  if (!file) {
    return;
  }
  if (!isMarimoApp(file)) {
    window.showInformationMessage("This is not a marimo app.");
    return;
  }
  const controller = Controllers.getOrCreate(file, extension);
  return fn(controller);
}