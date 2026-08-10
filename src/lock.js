import fs from 'node:fs/promises';

const LOCK_TIMEOUT_MS = 5_000;

async function staleLock(lockPath) {
  let contents;
  try {
    contents = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(contents);
  } catch {
    const details = await fs.stat(lockPath);
    return Date.now() - details.mtimeMs >= LOCK_TIMEOUT_MS;
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    const details = await fs.stat(lockPath);
    return Date.now() - details.mtimeMs >= LOCK_TIMEOUT_MS;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

export async function withFileLock(lockPath, busyMessage, operation) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await staleLock(lockPath)) {
        await fs.unlink(lockPath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(busyMessage);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
