'use strict';
/* Build both installers (CPU + CUDA) in sequence.
 *
 *   npm run dist:all                          -- rebuild Piper servers, then build both installers
 *   npm run dist:all --no-piper-rebuild       -- skip Piper rebuilds; copy built servers from resources/piper/
 *
 * With --no-piper-rebuild, both `resources/piper/kanna-piper-server.exe` (CPU)
 * and `resources/piper/kanna-piper-server-cuda.exe` (CUDA) must already exist
 * from a previous `npm run piper:build` / `npm run piper:build:cuda`.
 *
 * The CUDA dist always runs last; when --no-piper-rebuild is set it uses the
 * already-built CUDA server binary from resources/piper/ instead of rebuilding it.
 */
const { spawnSync } = require('node:child_process');

const noPiperRebuild = process.argv.includes('--no-piper-rebuild');

function run(script) {
  console.log(`\n=== running: ${script} ===\n`);
  const r = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('clean:dist');
if (!noPiperRebuild) {
  run('piper:build');
  run('piper:build:cuda');
}
run('dist');
run('dist:cuda');
console.log('\n=== dist:all complete ===');
