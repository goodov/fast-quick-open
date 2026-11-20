import * as vscode from 'vscode';

type LogHandler = (message: string, ...args: unknown[]) => void;
type LogErrorHandler = (error: string | Error, ...args: unknown[]) => void;

export default class Log {
  private static logHandlers = new Map<
    vscode.LogLevel,
    LogHandler | LogErrorHandler | undefined
  >();
  private static outputChannel: vscode.LogOutputChannel | undefined;

  static activate(context: vscode.ExtensionContext) {
    Log.outputChannel = vscode.window.createOutputChannel(
      context.extension.packageJSON.displayName,
      {
        log: true,
      },
    );

    context.subscriptions.push(
      {
        dispose: () => {
          Log.logHandlers.clear();
          Log.outputChannel?.dispose();
          Log.outputChannel = undefined;
        },
      },
      Log.outputChannel.onDidChangeLogLevel(() => {
        Log.updateLogHandlers();
      }),
    );

    Log.updateLogHandlers();
  }

  private static updateLogHandlers() {
    Log.logHandlers.clear();

    if (
      Log.outputChannel?.logLevel === undefined
      || Log.outputChannel?.logLevel === vscode.LogLevel.Off
    ) {
      return;
    }

    for (let i = vscode.LogLevel.Error; i >= Log.outputChannel.logLevel; --i) {
      Log.logHandlers.set(i, (message: string | Error, ...args: unknown[]) => {
        Log.logHandler(i, message, ...args);
      });
    }
  }

  static get error(): LogErrorHandler | undefined {
    return Log.logHandlers.get(vscode.LogLevel.Error) as
      LogErrorHandler | undefined;
  }

  static get warn(): LogHandler | undefined {
    return Log.logHandlers.get(vscode.LogLevel.Warning);
  }

  static get info(): LogHandler | undefined {
    return Log.logHandlers.get(vscode.LogLevel.Info);
  }

  static get debug(): LogHandler | undefined {
    return Log.logHandlers.get(vscode.LogLevel.Debug);
  }

  static get trace(): LogHandler | undefined {
    return Log.logHandlers.get(vscode.LogLevel.Trace);
  }

  private static logHandler(
    level: vscode.LogLevel,
    message: string | Error,
    ...args: unknown[]
  ) {
    if (!Log.outputChannel) {
      return;
    }
    switch (level) {
      case vscode.LogLevel.Error:
        Log.outputChannel.error(message, ...args);
        break;
      case vscode.LogLevel.Warning:
        Log.outputChannel.warn(message as string, ...args);
        break;
      case vscode.LogLevel.Info:
        Log.outputChannel.info(message as string, ...args);
        break;
      case vscode.LogLevel.Debug:
        Log.outputChannel.debug(message as string, ...args);
        break;
      case vscode.LogLevel.Trace:
        Log.outputChannel.trace(message as string, ...args);
        break;
    }
  }
}
