import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMMON_BUILD_ARGS, ESLINT_OPTIONS, OFFLINE_ENV, PACKAGE_DIRS, SUBCOMMANDS, SUBCOMMAND_NAMES, TSC_OPTIONS, VITEST_REPORTERS,
  buildToolEnabled, checkBuildArgs, describeBuildTool, finalArgs, needsCommonBuild,
} from '../src/tools/build-policy.ts';

const ok = (sub, args, dir) => assert.equal(checkBuildArgs(sub, args, dir), null, `${sub} ${args.join(' ')} in ${dir}`);
const refused = (sub, args, dir, pattern) => {
  const r = checkBuildArgs(sub, args, dir);
  assert.ok(r, `${sub} ${JSON.stringify(args)} in ${dir} should be refused`);
  if (pattern) assert.match(r, pattern);
};

test('the subcommands are the tools themselves, never npm, npx or node', () => {
  assert.deepEqual([...SUBCOMMAND_NAMES], ['tsc', 'vitest', 'tsx', 'eslint', 'vite', 'tsup']);
  assert.deepEqual([...PACKAGE_DIRS], ['.', 'common', 'apps/frontend', 'apps/server', 'apps/metrics']);
  for (const sub of ['npm', 'npx', 'node', 'pnpm', 'yarn', 'bash', 'sh', 'electron', 'electron-builder', 'concurrently']) {
    refused(sub, ['start'], '.', /not a build tool here/);
  }
});

// The attack shape: code hidden in a `.prebuild` directory, run from an
// `npm start` prestart hook.
test('npm start, package scripts, lifecycle scripts and .prebuild are never reachable', () => {
  for (const args of [['start'], ['run', 'start'], ['run', 'prestart'], ['test'], ['run', 'dev'], ['run', 'package:linux:nosign'], ['exec', 'tsx']]) {
    refused('npm', args, '.', /not a build tool here/);
  }
  for (const args of [['.prebuild/index.js'], ['--test', '.prebuild/x.test.mjs'], ['-e', 'require("./.prebuild")']]) {
    refused('node', args, '.', /not a build tool here/);
  }
  for (const dir of ['.prebuild', './.prebuild', '.prebuild/hooks', '.github', '.agents', 'docs-site', 'tools', 'apps', 'apps/frontend/src', 'node_modules/.bin']) {
    refused('eslint', ['.'], dir, /not a package directory/);
  }
  refused('vitest', ['run', '.prebuild/cache.test.ts'], 'apps/frontend', /dot/);
  refused('vitest', ['run', 'src/.prebuild/x.test.ts'], 'apps/metrics', /dot/);
  refused('tsx', ['--test', 'src/.prebuild/x.test.ts'], 'apps/server', /dot/);
  refused('tsx', ['--test', '.prebuild/x.test.ts'], 'common', /dot/);
  refused('eslint', ['.prebuild'], '.', /dot/);
  refused('eslint', ['apps/.prebuild/x.js'], '.', /dot/);
  refused('tsc', ['--noEmit', '-p', '.prebuild/tsconfig.json'], 'apps/server', /tsconfig file in the package directory/);
  refused('tsx', ['.prebuild/index.ts'], 'apps/server', /only "--test"/);
  refused('tsx', ['src/index.ts'], 'apps/server', /only "--test"/);
  refused('tsx', ['watch', 'src/index.ts'], 'apps/server', /only "--test"/);
});

test('nothing starts a server, a watcher, Electron or a packager', () => {
  refused('vite', [], 'apps/frontend', /only \["build"\]/);
  refused('vite', ['dev'], 'apps/frontend', /only \["build"\]/);
  refused('vite', ['preview'], 'apps/frontend', /only \["build"\]/);
  refused('vite', ['build', '--watch'], 'apps/frontend', /only \["build"\]/);
  refused('vite', ['build', '--config', '/tmp/x.ts'], 'apps/server', /only \["build"\]/);
  refused('vitest', [], 'apps/frontend', /needs "run" first/);
  refused('vitest', ['watch'], 'apps/frontend', /needs "run" first/);
  refused('vitest', ['--ui'], 'apps/frontend', /needs "run" first/);
  refused('vitest', ['run', '--ui'], 'apps/frontend', /vitest option/);
  refused('vitest', ['run', '--watch'], 'apps/frontend', /vitest option/);
  refused('tsx', ['--test', '--watch', 'src/__tests__/session.test.ts'], 'apps/server', /tsx option/);
  refused('tsc', ['--noEmit', '-p', 'tsconfig.json', '--watch'], 'apps/server', /tsc option/);
  refused('vite', ['build'], '.', /runs only in/);
});

test('tsc type-checks a tsconfig in common, apps/server or apps/frontend without emitting', () => {
  ok('tsc', ['--noEmit', '-p', 'tsconfig.json'], 'apps/server');
  ok('tsc', ['--noEmit', '-p', 'tsconfig.json'], 'common');
  ok('tsc', ['--noEmit', '--project', 'tsconfig.app.json', '--pretty'], 'apps/frontend');
  ok('tsc', ['-p', 'tsconfig.test.json', '--noEmit'], './apps/frontend/');
  ok('tsc', ['--noEmit', '-p', 'tsconfig.node.json', '--extendedDiagnostics'], 'apps/frontend');
  refused('tsc', ['-p', 'tsconfig.json'], 'apps/server', /needs --noEmit/);
  refused('tsc', ['--noEmit'], 'apps/server', /needs -p <tsconfig>/);
  refused('tsc', ['--noEmit', '-p', 'tsconfig.json'], 'apps/metrics', /runs only in/);
  refused('tsc', ['--noEmit', '-p', 'tsconfig.json'], '.', /runs only in/);
  for (const option of ['-b', '--build', '--init', '--outDir', '--incremental', '--generateTrace', '--listEmittedFiles', '--plugins', 'src/index.ts']) {
    refused('tsc', ['--noEmit', '-p', 'tsconfig.json', option], 'apps/server', /tsc option/);
  }
  for (const value of ['../tsconfig.base.json', '/etc/tsconfig.json', 'src/tsconfig.json', 'x.json', '', '-w']) {
    refused('tsc', ['--noEmit', '-p', value], 'apps/server', /tsconfig file in the package directory/);
  }
});

test('vitest runs once, in apps/frontend or apps/metrics, with filters and name patterns', () => {
  ok('vitest', ['run'], 'apps/frontend');
  ok('vitest', ['run', 'src/utils/secureStorage.test.ts'], 'apps/frontend');
  ok('vitest', ['run', 'src/state', '-t', 'purges cleartext passwords'], 'apps/frontend');
  ok('vitest', ['run', '--testNamePattern=config', '--reporter=verbose'], 'apps/metrics');
  ok('vitest', ['run', '--testNamePattern', 'collector', 'src/epics/collector-rx.test.js'], 'apps/metrics');
  refused('vitest', ['run'], 'apps/server', /runs only in/);
  refused('vitest', ['run'], 'common', /runs only in/);
  refused('vitest', ['run', '-t'], 'apps/frontend', /needs a test name pattern/);
  refused('vitest', ['run', '-t', '--coverage'], 'apps/frontend', /needs a test name pattern/);
  refused('vitest', ['run', '--testNamePattern='], 'apps/frontend', /needs a pattern/);
  for (const reporter of ['./evil.js', 'json', '/tmp/r.mjs', '']) {
    refused('vitest', ['run', `--reporter=${reporter}`], 'apps/frontend', /--reporter takes/);
  }
  for (const option of ['--coverage', '--config', '--root', '--dir', '--globalSetup', '--setupFiles', '--environment', '--outputFile', '--update', '-u', '--api', '--inspect', '--reporter', '--project']) {
    refused('vitest', ['run', option, 'x'], 'apps/frontend', /vitest option/);
  }
  for (const filter of ['/etc/passwd', '../server/src', 'src/../../x', '.hidden']) {
    refused('vitest', ['run', filter], 'apps/frontend');
  }
  assert.deepEqual([...VITEST_REPORTERS], ['default', 'verbose', 'dot']);
});

test('tsx runs node --test on unit tests in apps/server and common, never integration tests', () => {
  ok('tsx', ['--test', 'src/__tests__/session.test.ts'], 'apps/server');
  ok('tsx', ['--test', 'src/__tests__/**/*.test.ts'], 'apps/server');
  ok('tsx', ['--test', '--test-name-pattern=origin', 'src/__tests__/websocket-origin.test.ts', 'src/__tests__/session.test.ts'], 'apps/server');
  ok('tsx', ['--test', 'src/__tests__/*.test.ts'], 'common');
  ok('tsx', ['--test', '--test-skip-pattern=slow', 'src/__tests__/connection-id.test.ts'], 'common');
  refused('tsx', ['--test'], 'apps/server', /at least one test file/);
  refused('tsx', ['--test', 'src/__tests__/session.test.ts'], 'apps/metrics', /runs only in/);
  refused('tsx', ['--test', 'src/__integration__/connection.integration.test.ts'], 'apps/server', /integration test/);
  refused('tsx', ['--test', 'src/__integration__/**/*.integration.test.ts'], 'apps/server', /integration test/);
  refused('tsx', ['--test', 'src/**/*.integration.test.ts'], 'apps/server', /integration test/);
  // node expands the glob itself, and src/** would reach src/__integration__/.
  refused('tsx', ['--test', 'src/**/*.test.ts'], 'apps/server', /under src\/__tests__\//);
  refused('tsx', ['--test', 'src/*/*.test.ts'], 'apps/server', /under src\/__tests__\//);
  for (const file of ['src/index.ts', 'src/session.ts', 'test/x.test.ts', '/tmp/x.test.ts', 'src/../../x.test.ts', 'src/__tests__']) {
    refused('tsx', ['--test', file], 'apps/server');
  }
  for (const option of ['--import', '--require=./x.js', '-e', '--eval=1', '--inspect', '--watch', '--experimental-test-coverage', '--test-reporter=./r.mjs', '--test-reporter-destination=src/a.ts', '--tsconfig']) {
    refused('tsx', ['--test', option, 'src/__tests__/session.test.ts'], 'apps/server', /tsx option/);
  }
});

test('eslint lints paths without fixing them', () => {
  ok('eslint', ['.'], '.');
  ok('eslint', ['apps/server/src/session.ts', 'common/src'], '.');
  ok('eslint', ['--quiet', '--max-warnings', '0', 'src'], 'apps/frontend');
  ok('eslint', ['--no-warn-ignored', 'src/index.js'], 'apps/metrics');
  refused('eslint', [], '.', /at least one path/);
  refused('eslint', ['--quiet'], '.', /at least one path/);
  refused('eslint', ['--max-warnings', 'x', '.'], '.', /needs a number/);
  for (const option of ['--fix', '--fix-dry-run', '--fix-type', '-c', '--config', '--rulesdir', '--plugin', '--resolve-plugins-relative-to', '--cache', '--cache-location', '-o', '--output-file', '-f', '--format', '--stdin', '--inspect-config', '--debug', '--env', '--ext', '--no-config-lookup', '--flag']) {
    refused('eslint', [option, '.'], '.', /eslint option/);
  }
  for (const p of ['/etc', '../', 'apps/../..', '-', '.git']) refused('eslint', [p], '.');
});

test('vite builds and tsup builds common, each with one fixed argv', () => {
  for (const dir of ['apps/frontend', 'apps/server', 'apps/metrics']) ok('vite', ['build'], dir);
  refused('vite', ['build'], 'common', /runs only in/);
  ok('tsup', [...COMMON_BUILD_ARGS], 'common');
  ok('tsup', [...COMMON_BUILD_ARGS], './common');
  refused('tsup', [...COMMON_BUILD_ARGS], 'apps/server', /runs only in/);
  refused('tsup', ['src/index.ts'], 'common', /tsup runs only/);
  refused('tsup', [...COMMON_BUILD_ARGS, '--onSuccess', 'curl x'], 'common', /tsup runs only/);
  refused('tsup', [...COMMON_BUILD_ARGS, '--watch'], 'common', /tsup runs only/);
  assert.deepEqual(finalArgs('tsup', COMMON_BUILD_ARGS), [...COMMON_BUILD_ARGS, '--no-config']);
  assert.deepEqual(finalArgs('vitest', ['run']), ['run']);
  assert.deepEqual(finalArgs('tsc', ['--noEmit', '-p', 'tsconfig.json']), ['--noEmit', '-p', 'tsconfig.json', '--incremental', 'false']);
});

test('common/dist is built first only for the commands that import it', () => {
  assert.equal(needsCommonBuild('vitest', 'apps/metrics'), true);
  assert.equal(needsCommonBuild('vitest', './apps/metrics/'), true);
  assert.equal(needsCommonBuild('vite', 'apps/server'), true);
  assert.equal(needsCommonBuild('vite', 'apps/metrics'), true);
  assert.equal(needsCommonBuild('tsc', 'apps/server'), true);
  for (const [sub, dir] of [['vitest', 'apps/frontend'], ['vite', 'apps/frontend'], ['tsx', 'apps/server'], ['tsx', 'common'], ['tsc', 'common'], ['tsc', 'apps/frontend'], ['eslint', '.'], ['tsup', 'common']]) {
    assert.equal(needsCommonBuild(sub, dir), false, `${sub} in ${dir}`);
  }
});

test('the environment hides credential sources and metadata servers', () => {
  assert.equal(OFFLINE_ENV.AWS_CONFIG_FILE, '/dev/null');
  assert.equal(OFFLINE_ENV.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
  assert.equal(OFFLINE_ENV.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(OFFLINE_ENV.METADATA_SERVER_DETECTION, 'none');
  assert.equal(OFFLINE_ENV.NPM_CONFIG_IGNORE_SCRIPTS, 'true');
  assert.equal(OFFLINE_ENV.NPM_CONFIG_OFFLINE, 'true');
  assert.equal(OFFLINE_ENV.CI, 'true');
  // None of these carries a credential: buildChildEnv's own pattern would remove them otherwise.
  for (const name of Object.keys(OFFLINE_ENV)) assert.doesNotMatch(name, /TOKEN|SECRET|PASSWORD|PRIVATE_KEY|KEY_ID|ACCESS_KEY|SESSION/);
});

test('the tool description names every tool, directory and option', () => {
  const d = describeBuildTool();
  for (const name of SUBCOMMAND_NAMES) {
    assert.ok(d.includes(`\`${name}\``), name);
    for (const dir of SUBCOMMANDS[name].dirs) assert.ok(d.includes(`\`${dir}\``), `${name} ${dir}`);
  }
  for (const word of [...TSC_OPTIONS.filter((o) => !['-p', '--project'].includes(o)), ...ESLINT_OPTIONS, ...VITEST_REPORTERS, COMMON_BUILD_ARGS.join(' '), '--test-name-pattern=<pattern>', 'lifecycle script']) {
    assert.ok(d.includes(word), word);
  }
});

test('ALLOW_BUILD enables the tool and ALLOW_MAKE is an alias', () => {
  assert.equal(buildToolEnabled({}), false);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_MAKE: 'true' }), true);
  assert.equal(buildToolEnabled({ ALLOW_BUILD: 'false', ALLOW_MAKE: 'true' }), false);
});

const buildSection = () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  return prompt.slice(prompt.indexOf('### Build'), prompt.indexOf('## Workflow'));
};

test('the prompt lists every tool and the directories it runs in', () => {
  const section = buildSection();
  for (const name of SUBCOMMAND_NAMES) {
    const line = section.split('\n').find((l) => l.startsWith(`- \`${name}\``));
    assert.ok(line, `Build section has a line for ${name}`);
    // The parenthesis after the name lists the directories.
    const dirs = [...line.slice(0, line.indexOf(')')).matchAll(/`([^`]+)`/g)].map((m) => m[1]).slice(1);
    assert.deepEqual(dirs, [...SUBCOMMANDS[name].dirs], name);
  }
  assert.doesNotMatch(section, /`(npm|npx|node)`, `args:/);
});

test('every command the prompt suggests is accepted', () => {
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  // Examples are written as `subcommand`, `args: [...]`, `dir: "..."` on one line.
  const examples = [...prompt.matchAll(/`(tsc|vitest|tsx|eslint|vite|tsup)`, `args: (\[[^\]]*\])`, `dir: "([^"]+)"`/g)];
  assert.ok(examples.length >= 6, `found ${examples.length} examples`);
  for (const [, sub, args, dir] of examples) ok(sub, JSON.parse(args), dir);
});

// The prompt tells the reviewer to write without em dashes, so its own
// prose and the skill's do the same.
test('the prompt and the skill have no em dashes', () => {
  for (const file of ['prompt.md', 'skill.md']) {
    const text = readFileSync(new URL(`../config/${file}`, import.meta.url), 'utf8');
    const lines = text.split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => l.includes('—'));
    assert.deepEqual(lines, [], file);
  }
});
