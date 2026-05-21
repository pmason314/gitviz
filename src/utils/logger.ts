import * as vscode from 'vscode';

let _logger: vscode.LogOutputChannel | undefined;

export function initLogger(channel: vscode.LogOutputChannel): void {
    _logger = channel;
}

export const logger = {
    error(message: string | Error, ...args: unknown[]): void {
        _logger?.error(message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
        _logger?.warn(message, ...args);
    },
    info(message: string, ...args: unknown[]): void {
        _logger?.info(message, ...args);
    },
};
