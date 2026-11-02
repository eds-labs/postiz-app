import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

/** Own local uploads need no HTTP round trip through the private reverse proxy. */
export async function readLocalXImage(
  input: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Buffer | undefined> {
  if (env.STORAGE_PROVIDER !== 'local' || !env.FRONTEND_URL) {
    return undefined;
  }

  let url: URL;
  let publicBase: URL;
  try {
    url = new URL(input);
    publicBase = new URL(
      env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY ||
        env.NEXT_PUBLIC_UPLOAD_DIRECTORY ||
        '/uploads',
      env.FRONTEND_URL
    );
  } catch {
    return undefined;
  }

  const ownOrigin = new URL(env.FRONTEND_URL).origin;
  const prefix = publicBase.pathname.replace(/\/+$/, '') + '/';
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    publicBase.origin !== ownOrigin ||
    url.origin !== ownOrigin ||
    prefix === '/' ||
    !url.pathname.startsWith(prefix)
  ) {
    return undefined;
  }

  if (url.username || url.password) {
    throw new Error('Local X image URL must not contain credentials');
  }
  if (!env.UPLOAD_DIRECTORY || !isAbsolute(env.UPLOAD_DIRECTORY)) {
    throw new Error('Local X image upload directory is not configured');
  }

  // Decode exactly once. Neither encoded separators nor symlinks may escape
  // the upload mount. Invalid own-upload paths never fall back to HTTP.
  const relative = decodeURIComponent(url.pathname.slice(prefix.length));
  if (
    !relative ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Unsafe local X image path');
  }
  const base = await realpath(env.UPLOAD_DIRECTORY);
  const candidate = resolve(base, relative);
  if (!candidate.startsWith(base + sep)) {
    throw new Error('Unsafe local X image path');
  }
  const file = await realpath(candidate);
  if (!file.startsWith(base + sep)) {
    throw new Error('Unsafe local X image path');
  }

  // O_NONBLOCK avoids hanging on a special file; O_NOFOLLOW prevents a final
  // symlink replacement between realpath() and open(). No files are written.
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    // Linux workers can also validate the opened descriptor, closing the
    // parent-directory replacement race after the first realpath check.
    if (process.platform === 'linux') {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!opened.startsWith(base + sep)) {
        throw new Error('Unsafe local X image path');
      }
    }
    if (!(await handle.stat()).isFile()) {
      throw new Error('Local X image must be a regular file');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
