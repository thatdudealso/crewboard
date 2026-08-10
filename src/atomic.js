import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export async function atomicWriteFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, contents);
  await fs.rename(temporaryPath, filePath);
}
