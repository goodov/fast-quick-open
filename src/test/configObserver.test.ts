import * as assert from 'assert';
import * as vscode from 'vscode';

import ConfigObserver from '../helpers/configObserver.ts';
import { config } from '../config.ts';
import { stubWorkspaceConfig } from './helpers/stubWorkspaceConfig.ts';

class TestConfigObserver extends ConfigObserver {
  changes = 0;
  observedLowercaseQuery: boolean | undefined;

  constructor() {
    super();
  }

  protected onConfigurationChanged(): void {
    this.changes += 1;
    this.observedLowercaseQuery = config.settings().lowercaseQuery;
  }
}

suite('ConfigObserver', () => {
  let restoreConfig: (() => void) | undefined;
  let restoreEvent: (() => void) | undefined;

  setup(() => {
    restoreConfig = stubWorkspaceConfig({
      fastQuickOpen: { lowercaseQuery: false },
    });
  });

  teardown(() => {
    restoreEvent?.();
    restoreEvent = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
  });

  test('filters changes, clears config cache, and disposes its listener', () => {
    const fastQuickOpen: Record<string, unknown> = {
      lowercaseQuery: false,
    };
    restoreConfig?.();
    restoreConfig = stubWorkspaceConfig({ fastQuickOpen });

    let listener:
      ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      'onDidChangeConfiguration',
    );
    const original = vscode.workspace.onDidChangeConfiguration;
    Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
      configurable: true,
      value: (callback: (event: vscode.ConfigurationChangeEvent) => void) => {
        listener = callback;
        return new vscode.Disposable(() => {
          listener = undefined;
        });
      },
    });
    restoreEvent = () => {
      if (originalDescriptor) {
        Object.defineProperty(
          vscode.workspace,
          'onDidChangeConfiguration',
          originalDescriptor,
        );
      } else {
        Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
          configurable: true,
          value: original,
        });
      }
    };

    const observer = new TestConfigObserver();
    assert.ok(listener);
    const configListener = listener;

    configListener({
      affectsConfiguration: (key) => key === 'editor.fontSize',
    });
    assert.strictEqual(observer.changes, 0);

    fastQuickOpen.lowercaseQuery = true;
    configListener({
      affectsConfiguration: (key) => key === 'fastQuickOpen',
    });
    assert.strictEqual(observer.changes, 1);
    assert.strictEqual(observer.observedLowercaseQuery, true);

    observer.dispose();
    configListener({
      affectsConfiguration: () => true,
    });
    assert.strictEqual(observer.changes, 1);
  });
});
