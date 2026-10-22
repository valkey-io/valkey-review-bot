/**
 * What the build tool lets the reviewer run in the valkey-admin checkout.
 * This file has no imports so the tests can load it directly.
 *
 * valkey-admin is one npm workspace (`common`, `apps/frontend`,
 * `apps/server`, `apps/metrics`). The image installs its dependencies when
 * it is built, from main at that time, with install scripts off. The tool
 * runs the tools the repository's CI and tsconfigs use, each started
 * directly from the installed `node_modules/.bin`: type-checks, unit tests,
 * lint without fixes, and the builds. It never goes through npm, so no
 * package.json script and no lifecycle script (`prestart`, `pretest`,
 * `prepare`, ...) runs, whatever the pull request puts in package.json.
 * Nothing installs, publishes, packages, deploys, starts a server or starts
 * Electron, and no option outside a short allowlist reaches a tool.
 *
 * The checkout is untrusted. This keeps out code that only a package
 * script would start, such as a `.prebuild` directory run from a
 * `prestart` hook by `npm start`, and no path the tool accepts may name a
 * dot directory. The tools still load the checkout's own configuration,
 * setup and test files (vite.config.ts, vitest.config.ts, eslint.config.mjs,
 * the tests), as running any project's tests does; SECURITY.md describes
 * what that code can reach.
 */

export const SUBCOMMAND_NAMES = ['tsc', 'vitest', 'tsx', 'eslint', 'vite', 'tsup'] as const;
export type Subcommand = (typeof SUBCOMMAND_NAMES)[number];

/** The workspace root and the four workspace packages. */
export const PACKAGE_DIRS = ['.', 'common', 'apps/frontend', 'apps/server', 'apps/metrics'] as const;
export type PackageDir = (typeof PACKAGE_DIRS)[number];

export interface SubcommandSpec {
  /** The executable under node_modules/.bin. */
  readonly bin: string;
  /** The package directories it may run in. */
  readonly dirs: readonly PackageDir[];
}

export const SUBCOMMANDS: Readonly<Record<Subcommand, SubcommandSpec>> = {
  tsc: { bin: 'tsc', dirs: ['common', 'apps/frontend', 'apps/server'] },
  vitest: { bin: 'vitest', dirs: ['apps/frontend', 'apps/metrics'] },
  tsx: { bin: 'tsx', dirs: ['common', 'apps/server'] },
  eslint: { bin: 'eslint', dirs: [...PACKAGE_DIRS] },
  vite: { bin: 'vite', dirs: ['apps/frontend', 'apps/server', 'apps/metrics'] },
  tsup: { bin: 'tsup', dirs: ['common'] },
};

/**
 * The one tsup argv: the build of `common`'s package script without its
 * first step (`node scripts/sync-version.mjs`, which rewrites
 * `common/src/version.ts`). `--no-config` is added when it runs.
 */
export const COMMON_BUILD_ARGS: readonly string[] = ['src/index.ts', '--format', 'esm', '--dts', '--out-dir', 'dist', '--clean'];

/**
 * Added to buildChildEnv() for every command. The AWS settings hide the
 * credential files and instance metadata from the AWS SDK that
 * `apps/metrics` uses for ElastiCache IAM; METADATA_SERVER_DETECTION keeps
 * google-auth-library (`common`'s GCP IAM provider) off the GCE metadata
 * server. buildChildEnv has already removed every AWS_, GH_ and GITHUB_
 * variable and every credential-named one. The npm settings matter only
 * if code under test starts npm itself: offline, and no lifecycle scripts.
 */
export const OFFLINE_ENV: Readonly<Record<string, string>> = {
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  METADATA_SERVER_DETECTION: 'none',
  CI: 'true',
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  NPM_CONFIG_OFFLINE: 'true',
  NPM_CONFIG_IGNORE_SCRIPTS: 'true',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NO_COLOR: '1',
};

/** The tsc options allowed besides --noEmit and -p / --project. */
export const TSC_OPTIONS: readonly string[] = ['--noEmit', '-p', '--project', '--pretty', '--listFiles', '--extendedDiagnostics'];

/** The eslint options allowed besides paths. No --fix, no config, plugin, cache or output file. */
export const ESLINT_OPTIONS: readonly string[] = ['--quiet', '--max-warnings', '--no-warn-ignored'];

/** vitest reporters by name only: --reporter also takes a module path. */
export const VITEST_REPORTERS: readonly string[] = ['default', 'verbose', 'dot'];

/** A tsconfig file in the package directory itself. */
const TSCONFIG = /^tsconfig[\w.-]*\.json$/;

/**
 * A relative path inside the checkout: no leading `/` or `-`, no `..`, and
 * no segment that starts with a dot, so `.prebuild`, `.github` and the like
 * are out. `*` is allowed for the test-file globs node --test expands.
 */
const RELATIVE_PATH = /^(?![/-])(?!(.*\/)?\.)[\w./@*-]+$/;

/**
 * A file node --test runs under tsx: a unit test under src/__tests__/. A
 * glob such as src/**\/*.test.ts would also reach src/__integration__/.
 */
const TSX_TEST_FILE = /^src\/__tests__\/[\w./@*-]*\.test\.(ts|mts|tsx|js|mjs)$/;

/** The node --test options tsx passes through. */
const NODE_TEST_OPTIONS = /^--(test-name-pattern|test-skip-pattern)=.+$/;

/** A test name pattern: one argv value, not an option. */
const NAME_PATTERN = /^[^-][^\n]{0,199}$/;

/** "./apps/server/" and "apps/server" are the same directory. */
export function normalizeDir(dir: string): string {
  return dir.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
}

function isPackageDir(dir: string): dir is PackageDir {
  return (PACKAGE_DIRS as readonly string[]).includes(dir);
}

function checkPath(arg: string, what: string): string | null {
  if (arg.includes('__integration__') || /\.integration\.test\./.test(arg)) {
    return `${what} "${arg}" is an integration test. Those need a running Valkey stack and the app server, which this container does not start.`;
  }
  if (!RELATIVE_PATH.test(arg)) {
    return `${what} "${arg}" must be a relative path inside the package, with no "..", no leading "/" or "-", and no directory or file that starts with a dot.`;
  }
  return null;
}

function checkTsc(args: readonly string[]): string | null {
  if (!args.includes('--noEmit')) return 'tsc needs --noEmit. The packages build with vite and tsup, never with tsc.';
  let project = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!TSC_OPTIONS.includes(a)) return `tsc option "${a}" not allowed. Allowed: ${TSC_OPTIONS.join(', ')}.`;
    if (a === '-p' || a === '--project') {
      const value = args[++i] ?? '';
      if (!TSCONFIG.test(value)) return `tsc ${a} takes a tsconfig file in the package directory, such as tsconfig.json or tsconfig.app.json. Got "${value}".`;
      project = true;
    }
  }
  if (!project) {
    return 'tsc needs -p <tsconfig>: tsconfig.json in common and apps/server; tsconfig.app.json, tsconfig.test.json or tsconfig.node.json in apps/frontend, whose tsconfig.json only lists references.';
  }
  return null;
}

function checkVitest(args: readonly string[]): string | null {
  if (args[0] !== 'run') return `vitest needs "run" first: without it vitest watches until the time cap. Got "${args[0] ?? ''}".`;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--testNamePattern') {
      const value = args[++i] ?? '';
      if (!NAME_PATTERN.test(value)) return `vitest ${a} needs a test name pattern. Got "${value}".`;
    } else if (a.startsWith('--testNamePattern=')) {
      if (a.length === '--testNamePattern='.length) return 'vitest --testNamePattern= needs a pattern.';
    } else if (a.startsWith('--reporter=')) {
      const name = a.slice('--reporter='.length);
      if (!VITEST_REPORTERS.includes(name)) return `vitest --reporter takes ${VITEST_REPORTERS.join(', ')}. Got "${name}".`;
    } else if (a.startsWith('-')) {
      return `vitest option "${a}" not allowed. Allowed: -t <pattern>, --testNamePattern=<pattern>, --reporter=<${VITEST_REPORTERS.join('|')}>, and test file filters.`;
    } else {
      const refused = checkPath(a, 'vitest filter');
      if (refused) return refused;
    }
  }
  return null;
}

function checkTsx(args: readonly string[]): string | null {
  if (args[0] !== '--test') return `tsx runs only "--test" with test files. Got "${args[0] ?? ''}".`;
  let files = 0;
  for (const a of args.slice(1)) {
    if (a.startsWith('-')) {
      if (!NODE_TEST_OPTIONS.test(a)) return `tsx option "${a}" not allowed. Allowed: --test-name-pattern=<pattern>, --test-skip-pattern=<pattern>.`;
      continue;
    }
    const refused = checkPath(a, 'tsx test file');
    if (refused) return refused;
    if (!TSX_TEST_FILE.test(a)) {
      return `tsx --test takes unit test files under src/__tests__/, such as src/__tests__/session.test.ts or the glob src/__tests__/*.test.ts. Got "${a}".`;
    }
    files++;
  }
  if (files === 0) return 'tsx --test needs at least one test file or glob, such as src/__tests__/*.test.ts.';
  return null;
}

function checkEslint(args: readonly string[]): string | null {
  let paths = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--max-warnings') {
      const value = args[++i] ?? '';
      if (!/^\d{1,5}$/.test(value)) return `eslint --max-warnings needs a number. Got "${value}".`;
    } else if (a.startsWith('-')) {
      if (!ESLINT_OPTIONS.includes(a)) {
        return `eslint option "${a}" not allowed. Allowed: ${ESLINT_OPTIONS.join(', ')}. There is no --fix: it would move the lines the review anchors to.`;
      }
    } else if (a === '.') {
      paths++;
    } else {
      const refused = checkPath(a, 'eslint path');
      if (refused) return refused;
      paths++;
    }
  }
  if (paths === 0) return 'eslint needs at least one path, such as "." in the workspace root (as CI runs it) or a source file.';
  return null;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Why the argv is refused in `dir`, or null when it may run. */
export function checkBuildArgs(subcommand: Subcommand, args: readonly string[], dir: string): string | null {
  const spec = (SUBCOMMANDS as Record<string, SubcommandSpec | undefined>)[subcommand];
  if (!spec) return `"${subcommand}" is not a build tool here. Allowed: ${SUBCOMMAND_NAMES.join(', ')}. There is no npm, npx or node: package scripts and lifecycle scripts never run.`;
  const d = normalizeDir(dir);
  if (!isPackageDir(d)) {
    return `dir "${dir}" is not a package directory. Allowed: ${PACKAGE_DIRS.map((p) => `"${p}"`).join(', ')}.`;
  }
  if (!spec.dirs.includes(d)) {
    return `${subcommand} runs only in ${spec.dirs.map((p) => `"${p}"`).join(', ')}. Got dir "${dir}".`;
  }
  switch (subcommand) {
    case 'tsc': return checkTsc(args);
    case 'vitest': return checkVitest(args);
    case 'tsx': return checkTsx(args);
    case 'eslint': return checkEslint(args);
    case 'vite':
      return same(args, ['build']) ? null : `vite runs only ["build"], with the package's own vite.config.ts. Got ${JSON.stringify(args)}. There is no dev server or preview.`;
    case 'tsup':
      return same(args, COMMON_BUILD_ARGS) ? null : `tsup runs only ${JSON.stringify(COMMON_BUILD_ARGS)} in common. Got ${JSON.stringify(args)}.`;
  }
}

/**
 * The argv to run for an accepted call. tsup loads no tsup config file, and
 * tsc writes no .tsbuildinfo even when the checkout's tsconfig turns on
 * incremental builds with a tsBuildInfoFile of its choosing.
 */
export function finalArgs(subcommand: Subcommand, args: readonly string[]): string[] {
  if (subcommand === 'tsup') return [...args, '--no-config'];
  if (subcommand === 'tsc') return [...args, '--incremental', 'false'];
  return [...args];
}

/**
 * Whether a command needs `common/dist` built from the checkout first. The
 * metrics tests and the server and metrics bundles import `valkey-common`
 * through `node_modules`, which resolves to `common/dist`, and
 * `apps/server/src/connection.ts` imports a type from `common/dist`, which
 * the server's tsc resolves through `baseUrl`. `dist/` is gitignored, so a
 * warm container would keep an earlier build. The server's tsx tests
 * resolve `valkey-common` to `common/src` through tsconfig paths.
 */
export function needsCommonBuild(subcommand: Subcommand, dir: string): boolean {
  const d = normalizeDir(dir);
  return (subcommand === 'vitest' && d === 'apps/metrics')
    || (subcommand === 'vite' && (d === 'apps/server' || d === 'apps/metrics'))
    || (subcommand === 'tsc' && d === 'apps/server');
}

/** The tool description. It lists exactly what checkBuildArgs accepts. */
export function describeBuildTool(): string {
  const dirs = (s: Subcommand) => SUBCOMMANDS[s].dirs.map((d) => `\`${d}\``).join(', ');
  return `Run a type-check, unit test, lint or build in one package of the valkey-admin checkout. \`subcommand\` is the tool, \`args\` its argv (no shell), \`dir\` the package directory: ${PACKAGE_DIRS.map((d) => `\`${d}\``).join(', ')}.

- \`tsc\` (in ${dirs('tsc')}): \`--noEmit\` with \`-p <tsconfig>\`, and ${TSC_OPTIONS.filter((o) => !['--noEmit', '-p', '--project'].includes(o)).join(', ')}.
- \`vitest\` (in ${dirs('vitest')}): \`run\`, then test file filters, \`-t <pattern>\` or \`--testNamePattern=<pattern>\`, and \`--reporter=<${VITEST_REPORTERS.join('|')}>\`.
- \`tsx\` (in ${dirs('tsx')}): \`--test\` with unit test files or globs under \`src/__tests__/\`, and \`--test-name-pattern=<pattern>\` or \`--test-skip-pattern=<pattern>\`. No integration tests.
- \`eslint\` (in ${dirs('eslint')}): paths, and ${ESLINT_OPTIONS.join(', ')}. No --fix.
- \`vite\` (in ${dirs('vite')}): \`build\` only.
- \`tsup\` (in ${dirs('tsup')}): only ${COMMON_BUILD_ARGS.join(' ')}, which builds \`common/dist\`.

The first \`vitest\` run in \`apps/metrics\`, \`tsc\` in \`apps/server\` or \`vite build\` in \`apps/server\` or \`apps/metrics\` of a review builds \`common/dist\` from the checkout first. Tools start from the installed node_modules, never through npm, so no package script or lifecycle script runs; they still load the checkout's own config, setup and test files. No path may start with \`/\`, \`-\` or contain \`..\` or a dot directory. Every command gets an environment without credentials, with the AWS config files, instance metadata and the GCE metadata server turned off. The packages installed are those of main when the image was built. Nothing installs, publishes, packages, deploys, or starts a server or Electron.

Output is capped at 1 MB and 8 minutes. Use it when a claim hinges on a type-check, test, lint or build result, not to "just check".`;
}

/**
 * Whether the build tool is offered at all. ALLOW_BUILD is the setting.
 * ALLOW_MAKE is its older name and is read only when ALLOW_BUILD is unset.
 */
export function buildToolEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.ALLOW_BUILD || env.ALLOW_MAKE || 'false';
  return value.toLowerCase() === 'true';
}
