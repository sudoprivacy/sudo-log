import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { AppConfig } from '../config/appConfig.js';

const CONTENT_TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export class StaticRoutes {
  public constructor(private readonly config: AppConfig) {}

  public async admin(pathname: string, response: ServerResponse): Promise<boolean> {
    const assetPath = this.assetPath(pathname);
    if (!assetPath) return false;

    const content = await readFile(join(this.config.adminStaticDir, assetPath));
    response.writeHead(200, {
      'content-type': CONTENT_TYPES.get(extname(assetPath)) ?? 'application/octet-stream',
      'cache-control': assetPath === 'index.html' ? 'no-store' : 'public, max-age=300',
    });
    response.end(content);
    return true;
  }

  private assetPath(pathname: string): string | null {
    if (pathname === '/' || pathname === '/console') return 'index.html';
    if (pathname === '/assets/app.js') return 'app.js';
    if (pathname === '/assets/styles.css') return 'styles.css';
    if (pathname === '/favicon.svg') return 'favicon.svg';
    return null;
  }
}
