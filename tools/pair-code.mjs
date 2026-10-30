import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomInt, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createPairing(dir, now = Date.now()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pair = { code: String(randomInt(100000, 1000000)), expiresAt: now + 15 * 60 * 1000 };
  const temporary = join(dir, 'pairing-' + randomBytes(8).toString('hex') + '.tmp');
  await writeFile(temporary, JSON.stringify(pair), { mode: 0o600 });
  await rename(temporary, join(dir, 'pairing.json'));
  await writeFile(join(dir, 'pair-code'), pair.code, { mode: 0o600 });
  return pair;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('生成一个有效 15 分钟的电视配对码，不中断现有电视。\n用法：STATE_DIR=/state node tools/pair-code.mjs');
  } else {
    const pair = await createPairing(resolve(process.env.STATE_DIR || '.local/bridge'));
    console.log(`电视配对码：${pair.code}\n有效期：15 分钟。已经配对的电视不受影响。`);
  }
}
