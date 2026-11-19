'use strict';
/* Build both installers (CPU + CUDA) in sequence.
 *
 *   npm run dist:all                          -- rebuild Piper servers, then build both installers
 *   npm run dist:all --no-piper-rebuild       -- skip Piper rebuilds; use existing server binaries
 *
 * The CUDA dist always runs last; when --no-piper-rebuild is set it uses the
 * already-built CUDA server binary instead of rebuilding it.
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
}
run('dist');
if (!noPiperRebuild) {
  run('piper:build:cuda');
}
run('dist:cuda');
console.log('\n=== dist:all complete ===');
