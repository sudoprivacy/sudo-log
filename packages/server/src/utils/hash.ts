import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableErrorHash(errorName: string, errorMessage: string, stackTrace: string): string {
  const topFrame = stackTrace
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at ')) ?? '';
  return sha256([errorName, errorMessage, topFrame].join('\n'));
}
