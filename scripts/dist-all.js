'use strict';
/* Build both installers (CPU + CUDA) in sequence.
 *
 *   npm run dist:all                          -- rebuild Piper servers, then build both installers
 *   npm run dist:all --no-piper-rebuild       -- skip Piper rebuilds; copy built servers from resources/piper/
 *
 * With --no-piper-rebuild, both `resources/piper/kanna-piper-server.exe` (CPU)
 * and `resources/piper/kanna-piper-server-cuda.exe` (CUDA) must already exist
 * from a previous `npm run piper:build` / `npm run piper:build:cuda`.
 * If either is missing, a warning is logged and that server is rebuilt anyway.
 *
 * The CUDA dist always runs last; when --no-piper-rebuild is set it uses the
 * already-built CUDA server binary from resources/piper/ instead of rebuilding it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

const noPiperRebuild = process.argv.includes('--no-piper-rebuild');

const cpuExe = path.join(root, 'resources', 'piper', 'kanna-piper-server.exe');
const cudaExe = path.join(root, 'resources', 'piper', 'kanna-piper-server-cuda.exe');

let buildCpu = true;   // default: rebuild
let buildCuda = true;  // default: rebuild

if (noPiperRebuild) {
  buildCpu = !fs.existsSync(cpuExe);
  buildCuda = !fs.existsSync(cudaExe);
  if (!buildCpu && !buildCuda) {
    console.log('--no-piper-rebuild: both Piper servers exist in resources/piper/, skipping rebuilds');
  } else {
    if (!buildCpu) {
      console.log('--no-piper-rebuild: resources/piper/kanna-piper-server.exe missing — forcing CPU build');
    }
    if (!buildCuda) {
      console.log('--no-piper-rebuild: resources/piper/kanna-piper-server-cuda.exe missing — forcing CUDA build');
    }
    console.log('--no-piper-rebuild: missing server(s) will be rebuilt');
  }
}

function run(script) {
  console.log(`\n=== running: ${script} ===\n`);
  const r = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('clean:dist');
if (buildCpu) {
  run('piper:build');
}
if (buildCuda) {
  run('piper:build:cuda');
}
run('dist');
run('dist:cuda');
console.log('\n=== dist:all complete ===');
