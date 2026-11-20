import * as vscode from 'vscode';
import { config } from '../config.ts';

/** Base lifecycle for classes that react to extension configuration changes. */
export default abstract class ConfigObserver implements vscode.Disposable {
  private observerDisposed = false;
  private readonly configSubscription: vscode.Disposable;

  protected constructor() {
    this.configSubscription = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (this.observerDisposed || !config.isConfigChange(event)) {
          return;
        }
        config.clearCache();
        this.onConfigurationChanged(event);
      },
    );
  }

  protected abstract onConfigurationChanged(
    event: vscode.ConfigurationChangeEvent,
  ): void;

  dispose(): void {
    if (this.observerDisposed) {
      return;
    }
    this.observerDisposed = true;
    this.configSubscription.dispose();
  }
}
