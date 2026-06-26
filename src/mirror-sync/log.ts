import type { Logger } from '../git/log.ts';

export type { Logger } from '../git/log.ts';

export function setMirrorSyncUtf8Environment(): void {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
}

export function createMirrorSyncLogger(): Logger {
  return {
    write(message, level = 'Info') {
      const prefix =
        level === 'Warn' ? '[mirror-sync][warn]' : level === 'Error' ? '[mirror-sync][error]' : '[mirror-sync]';
      console.log(`${prefix} ${message}`);
    },
    close() {}
  };
}
