import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { buildValkeyAdminBuildTool, resolveBin } = await import('../src/tools/build.ts');
const { COMMON_BUILD_ARGS } = await import('../src/tools/build-policy.ts');

// A stand-in for an installed tool: logs its call to calls.log in the
// workspace root, prints the environment when asked, and fails when a
// fail-<bin> file exists in the workspace root.
const STUB = (bin, root) => `
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(path.join(root, 'calls.log'))}, JSON.stringify({ bin: ${JSON.stringify(bin)}, cwd: process.cwd(), args }) + '\\n');
console.log('ran ${bin} ' + args.join(' '));
if (args.includes('print-env')) for (const [k, v] of Object.entries(process.env)) console.log(k + '=' + v);
if (existsSync(${JSON.stringify(path.join(root, `fail-${bin}`))})) { console.error('${bin} failed'); process.exit(1); }
`;

function installStub(root, modulesDir, bin) {
  const pkg = path.join(modulesDir, bin);
  mkdirSync(pkg, { recursive: true });
  mkdirSync(path.join(modulesDir, '.bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'cli.mjs'), STUB(bin, root));
  symlinkSync(path.join('..', bin, 'cli.mjs'), path.join(modulesDir, '.bin', bin));
}

// A valkey-admin-shaped checkout whose package.json has every lifecycle
// hook that could run around the tools, each writing a marker file, and a
// .prebuild directory with a script in it.
function workspace() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'valkey-admin-build-')));
  const hook = (name) => `node -e "require('fs').writeFileSync('${path.join(root, `HOOK-${name}`)}', '')"`;
  const scripts = {};
  for (const name of ['prestart', 'start', 'poststart', 'pretest', 'test', 'posttest', 'prepare', 'preinstall', 'postinstall', 'prebuild', 'build', 'postbuild', 'prelint', 'lint']) {
    scripts[name] = hook(name);
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'valkey-admin', private: true, workspaces: ['common', 'apps/*'], scripts }));
  writeFileSync(path.join(root, '.npmrc'), 'ignore-scripts=false\n');
  mkdirSync(path.join(root, '.prebuild'));
  writeFileSync(path.join(root, '.prebuild', 'index.js'), `require('fs').writeFileSync('${path.join(root, 'HOOK-prebuild-dir')}', '')\n`);
  for (const dir of ['common', 'apps/frontend', 'apps/server', 'apps/metrics']) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name: path.basename(dir), scripts }));
  }
  for (const bin of ['tsc', 'vitest', 'tsx', 'eslint', 'vite', 'tsup']) installStub(root, path.join(root, 'node_modules'), bin);
  return root;
}

const calls = (root) => existsSync(path.join(root, 'calls.log'))
  ? readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : [];
const hooks = (root) => ['prestart', 'start', 'poststart', 'pretest', 'test', 'posttest', 'prepare', 'preinstall', 'postinstall', 'prebuild', 'build', 'postbuild', 'prelint', 'lint', 'prebuild-dir']
  .filter((name) => existsSync(path.join(root, `HOOK-${name}`)));

test('every tool runs from node_modules, and no package or lifecycle script runs', async () => {
  const root = workspace();
  const tool = buildValkeyAdminBuildTool({ workspaceRoot: root });
  const runs = [
    { subcommand: 'tsc', args: ['--noEmit', '-p', 'tsconfig.json'], dir: 'common' },
    { subcommand: 'vitest', args: ['run', 'src/x.test.ts'], dir: 'apps/frontend' },
    { subcommand: 'tsx', args: ['--test', 'src/__tests__/session.test.ts'], dir: 'apps/server' },
    { subcommand: 'eslint', args: ['.'], dir: '.' },
    { subcommand: 'vite', args: ['build'], dir: 'apps/frontend' },
    { subcommand: 'tsup', args: [...COMMON_BUILD_ARGS], dir: 'common' },
  ];
  for (const input of runs) {
    const out = await tool.invoke(input);
    assert.match(out, new RegExp(`^ran ${input.subcommand} `), out);
    assert.match(out, /\n\[exit 0\]$/);
  }
  assert.deepEqual(calls(root).map((c) => [c.bin, path.relative(root, c.cwd) || '.']), runs.map((r) => [r.subcommand, r.dir]));
  assert.deepEqual(calls(root).at(-1).args, [...COMMON_BUILD_ARGS, '--no-config']);
  assert.deepEqual(hooks(root), []);
});

test('refused calls run nothing: npm start, .prebuild and dot paths', async () => {
  const root = workspace();
  const tool = buildValkeyAdminBuildTool({ workspaceRoot: root });
  const attempts = [
    { subcommand: 'tsx', args: ['.prebuild/index.js'], dir: 'apps/server' },
    { subcommand: 'tsx', args: ['--test', '.prebuild/index.test.ts'], dir: 'common' },
    { subcommand: 'vitest', args: ['run', '.prebuild'], dir: 'apps/frontend' },
    { subcommand: 'eslint', args: ['.'], dir: '.prebuild' },
    { subcommand: 'vite', args: ['dev'], dir: 'apps/frontend' },
    { subcommand: 'tsc', args: ['--noEmit', '-p', '../../.prebuild/tsconfig.json'], dir: 'apps/server' },
  ];
  for (const input of attempts) assert.match(await tool.invoke(input), /^ERROR: /, JSON.stringify(input));
  // The schema has no npm, npx or node at all.
  for (const subcommand of ['npm', 'npx', 'node']) {
    await assert.rejects(tool.invoke({ subcommand, args: ['start'], dir: '.' }));
  }
  assert.deepEqual(calls(root), []);
  assert.deepEqual(hooks(root), []);
});

test('a .bin link that leaves node_modules is not followed', async () => {
  const root = workspace();
  const binDir = path.join(root, 'apps', 'server', 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(path.join('..', '..', '..', '..', '.prebuild', 'index.js'), path.join(binDir, 'tsx'));
  // The root's tsx is used instead of the package's escaping link.
  assert.equal(resolveBin(root, 'apps/server', 'tsx'), realpathSync(path.join(root, 'node_modules', 'tsx', 'cli.mjs')));
  const out = await buildValkeyAdminBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'tsx', args: ['--test', 'src/__tests__/a.test.ts'], dir: 'apps/server' });
  assert.match(out, /^ran tsx --test/);
  assert.deepEqual(hooks(root), []);
  // With no installed copy at all, the tool says so and runs nothing.
  const bare = mkdtempSync(path.join(tmpdir(), 'valkey-admin-bare-'));
  mkdirSync(path.join(bare, 'apps', 'server'), { recursive: true });
  assert.match(await buildValkeyAdminBuildTool({ workspaceRoot: bare }).invoke({ subcommand: 'tsx', args: ['--test', 'src/__tests__/a.test.ts'], dir: 'apps/server' }),
    /^ERROR: tsx is not installed in node_modules/);
});

test("a package's own node_modules comes before the root's", async () => {
  const root = workspace();
  installStub(root, path.join(root, 'apps', 'frontend', 'node_modules'), 'vitest');
  const out = await buildValkeyAdminBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'vitest', args: ['run'], dir: 'apps/frontend' });
  assert.match(out, /^ran vitest run/);
  assert.ok(resolveBin(root, 'apps/frontend', 'vitest').includes(path.join('apps', 'frontend', 'node_modules', 'vitest')));
});

test('common/dist is built once per review, before the first command that imports it', async () => {
  const root = workspace();
  const tool = buildValkeyAdminBuildTool({ workspaceRoot: root });
  const first = await tool.invoke({ subcommand: 'vitest', args: ['run'], dir: 'apps/metrics' });
  assert.match(first, /^\[built common\/dist from the checkout first: tsup /);
  await tool.invoke({ subcommand: 'vitest', args: ['run'], dir: 'apps/metrics' });
  await tool.invoke({ subcommand: 'vite', args: ['build'], dir: 'apps/server' });
  await tool.invoke({ subcommand: 'vitest', args: ['run'], dir: 'apps/frontend' });
  assert.deepEqual(calls(root).map((c) => `${c.bin} ${path.relative(root, c.cwd)}`), [
    'tsup common', 'vitest apps/metrics', 'vitest apps/metrics', 'vite apps/server', 'vitest apps/frontend',
  ]);
  // A new review (a new tool) builds again.
  await buildValkeyAdminBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'vite', args: ['build'], dir: 'apps/metrics' });
  assert.deepEqual(calls(root).slice(-2).map((c) => c.bin), ['tsup', 'vite']);
});

test('when common does not build, the command that needs it does not run', async () => {
  const root = workspace();
  writeFileSync(path.join(root, 'fail-tsup'), '');
  const tool = buildValkeyAdminBuildTool({ workspaceRoot: root });
  const out = await tool.invoke({ subcommand: 'vitest', args: ['run'], dir: 'apps/metrics' });
  assert.match(out, /^common\/dist could not be built from the checkout, so vitest in apps\/metrics did not run\./);
  assert.match(out, /tsup failed/);
  assert.deepEqual(calls(root).map((c) => c.bin), ['tsup']);
});

// Code from the pull request runs here. It sees no credential, and the
// AWS SDK and google-auth-library see the settings that keep them off
// credential files and metadata servers.
test('the command runs without credentials, with credential sources off', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials', GH_TOKEN: 'g', GITHUB_TOKEN: 'g',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json', VALKEY_PASSWORD: 'p', ORCHESTRATOR_KEY_SECRET: 'k',
  });
  try {
    const root = workspace();
    const out = await buildValkeyAdminBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'vitest', args: ['run', 'print-env'], dir: 'apps/frontend' });
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'VALKEY_PASSWORD', 'ORCHESTRATOR_KEY_SECRET']) {
      assert.doesNotMatch(out, new RegExp(`^${name}=`, 'm'), name);
    }
    for (const line of ['AWS_EC2_METADATA_DISABLED=true', 'AWS_CONFIG_FILE=/dev/null', 'AWS_SHARED_CREDENTIALS_FILE=/dev/null', 'METADATA_SERVER_DETECTION=none', 'NPM_CONFIG_IGNORE_SCRIPTS=true', 'CI=true']) {
      assert.match(out, new RegExp(`^${line}$`, 'm'), line);
    }
    assert.match(out, /\n\[exit 0\]$/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('build returns stdout, then stderr, then the exit code, and refuses a dir outside the workspace', async () => {
  const root = workspace();
  writeFileSync(path.join(root, 'fail-eslint'), '');
  const tool = buildValkeyAdminBuildTool({ workspaceRoot: root });
  const out = await tool.invoke({ subcommand: 'eslint', args: ['.'], dir: '.' });
  const [stdout, stderr] = out.split('\n--- stderr ---\n');
  assert.match(stdout, /ran eslint \./);
  assert.match(stderr, /eslint failed/);
  assert.match(out, /\n\[exit 1\]$/);
  assert.match(await tool.invoke({ subcommand: 'eslint', args: ['.'], dir: '../..' }), /^ERROR: dir "..\/.." is not a package directory/);
});
