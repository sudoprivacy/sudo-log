import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export class BlobStore {
  public constructor(private readonly rootDir: string) {}

  public async writeText(kind: string, eventId: string, content: string): Promise<string> {
    const relativePath = `${kind}/${eventId}.txt`;
    const fullPath = resolve(this.rootDir, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return `blob://${relativePath}`;
  }

  public async readText(ref: string): Promise<string> {
    if (!ref.startsWith('blob://')) {
      throw Object.assign(new Error('Invalid blob ref'), { statusCode: 400 });
    }

    const relativePath = ref.slice('blob://'.length);
    if (!/^stacks\/[a-f0-9-]{36}\.txt$/i.test(relativePath)) {
      throw Object.assign(new Error('Unsupported blob ref'), { statusCode: 400 });
    }

    const rootPath = resolve(this.rootDir);
    const fullPath = resolve(rootPath, relativePath);
    const resolvedRelativePath = relative(rootPath, fullPath);
    if (resolvedRelativePath.startsWith('..') || isAbsolute(resolvedRelativePath)) {
      throw Object.assign(new Error('Invalid blob path'), { statusCode: 400 });
    }

    try {
      return await readFile(fullPath, 'utf-8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw Object.assign(new Error('Blob not found'), { statusCode: 404 });
      }
      throw error;
    }
  }
}
