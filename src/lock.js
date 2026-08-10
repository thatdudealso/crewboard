import crypto from 'node:crypto';
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

async function recoveryLockExists(lockPath) {
  for (const suffix of ['.recovery', '.recovery.claim']) {
    try {
      await fs.access(`${lockPath}${suffix}`);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function acquireLock(lockPath) {
  const token = crypto.randomUUID();
  const temporaryPath = `${lockPath}.${process.pid}.${token}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }));
  try {
    await fs.link(temporaryPath, lockPath);
    return token;
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function releaseLock(lockPath, token) {
  let owner;
  try {
    owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (owner.token !== token) return;
  await fs.unlink(lockPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function recoverStaleRecoveryLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const claimPath = `${recoveryPath}.claim`;
  try {
    await fs.link(recoveryPath, claimPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (await staleLock(claimPath)) {
        await fs.unlink(claimPath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
        return true;
      }
      return false;
    }
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    if (!(await staleLock(claimPath))) return false;
    await fs.unlink(recoveryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return true;
  } finally {
    await fs.unlink(claimPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function handoffStaleLock(lockPath) {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryToken = await acquireLock(recoveryPath);
  if (!recoveryToken) return false;
  try {
    if (!(await staleLock(lockPath))) return false;
    const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    await fs.unlink(stalePath);
    return true;
  } finally {
    await releaseLock(recoveryPath, recoveryToken);
  }
}

export async function withFileLock(lockPath, busyMessage, operation) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let token;
  while (!token) {
    if (await recoveryLockExists(lockPath)) {
      if (await recoverStaleRecoveryLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(busyMessage);
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    token = await acquireLock(lockPath);
    if (token) continue;
    if (await staleLock(lockPath) && await handoffStaleLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) throw new Error(busyMessage);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    return await operation();
  } finally {
    await releaseLock(lockPath, token);
  }
}
