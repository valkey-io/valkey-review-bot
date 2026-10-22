import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { buildChildEnv, resolveInside } from '../../../common/src/tools/child-env.js';
import { runBounded, type BoundedResult } from '../../../common/src/tools/spawn.js';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import {
  COMMON_BUILD_ARGS, OFFLINE_ENV, SUBCOMMAND_NAMES, SUBCOMMANDS, checkBuildArgs, describeBuildTool, finalArgs, needsCommonBuild, normalizeDir,
  type Subcommand,
} from './build-policy.js';

const LIMITS = { timeoutMs: 8 * 60_000, maxBytes: 1_000_000, maxErrBytes: 128_000, graceMs: 3000 } as const;

/**
 * The installed script behind `node_modules/.bin/<bin>` at the workspace
 * root, where `npm ci` puts every tool (valkey-admin's lockfile installs
 * nothing under a package's own node_modules). The root node_modules must
 * be a real directory and the script must resolve inside it, so a link the
 * checkout plants is not followed.
 */
export function resolveBin(workspaceRoot: string, bin: string): string | null {
  const modules = path.join(workspaceRoot, 'node_modules');
  try {
    if (!lstatSync(modules).isDirectory()) return null;
    const realModules = realpathSync(modules);
    const real = realpathSync(path.join(modules, '.bin', bin));
    return real.startsWith(realModules + path.sep) ? real : null;
  } catch {
    return null;
  }
}

/** The environment of the model-facing git tool: no credentials, no system or global config. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...buildChildEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Why the checkout is not fit to run a tool in, or null. `git checkout`
 * overwrites gitignored files, so a pull request that tracks files under a
 * node_modules directory replaces installed tools; and a package directory
 * the pull request turns into a symbolic link moves the working directory
 * out of the package.
 */
export async function checkoutProblem(workspaceRoot: string, dir: string): Promise<string | null> {
  const realRoot = realpathSync(workspaceRoot);
  const wanted = dir === '.' ? realRoot : path.join(realRoot, dir);
  let real: string;
  try {
    real = realpathSync(path.join(workspaceRoot, dir));
  } catch {
    return `dir "${dir}" does not exist at this head.`;
  }
  if (real !== wanted) return `dir "${dir}" is a symbolic link at this head (it resolves to ${JSON.stringify(path.relative(realRoot, real) || '.')}), so no tool runs in it.`;
  const tracked = await runBounded('git', ['ls-files', '-z', '--', 'node_modules', ':(glob)**/node_modules', ':(glob)**/node_modules/**'], {
    cwd: workspaceRoot, env: gitEnv(), timeoutMs: 60_000, maxBytes: 64_000,
  });
  if (tracked.code !== 0) return `could not list the tracked files (git ls-files exited ${tracked.code}), so no tool runs.`;
  const paths = tracked.out.split('\0').filter(Boolean);
  if (paths.length > 0) {
    return `the pull request tracks files under node_modules (${paths.slice(0, 3).map((p) => JSON.stringify(p)).join(', ')}${paths.length > 3 ? ', ...' : ''}), which replace installed tools at checkout, so the build tool does not run on this head. That is worth a finding.`;
  }
  return null;
}

function format(r: BoundedResult): string {
  return `${r.out}\n${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n[exit ${r.code}]`;
}

/**
 * The build tool. Each tool's script runs under this process's node, from
 * the installed node_modules: never npm, npx or a package script, so no
 * lifecycle script runs. Calls run one at a time, so the build of
 * `common/dist` that the first command needing it triggers
 * (`needsCommonBuild`) never overlaps a command that reads it.
 */
export function buildValkeyAdminBuildTool(opts: { workspaceRoot: string }) {
  let commonBuilt = false;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (subcommand: Subcommand, args: readonly string[], dir: string): Promise<{ text: string; code: number }> => {
    const cwd = resolveInside(opts.workspaceRoot, dir === '.' ? undefined : dir);
    if (!cwd) return { text: `ERROR: dir "${dir}" is outside the workspace.`, code: 1 };
    const problem = await checkoutProblem(opts.workspaceRoot, dir);
    if (problem) return { text: `ERROR: ${problem}`, code: 1 };
    const script = resolveBin(opts.workspaceRoot, SUBCOMMANDS[subcommand].bin);
    if (!script) {
      return { text: `ERROR: ${SUBCOMMANDS[subcommand].bin} is not installed in node_modules. The image installs main's dependencies; the tool installs nothing.`, code: 127 };
    }
    const r = await runBounded(process.execPath, [script, ...finalArgs(subcommand, args)], {
      cwd, env: { ...buildChildEnv(), ...OFFLINE_ENV }, ...LIMITS,
    });
    return { text: format(r), code: r.code };
  };

  const call = async (subcommand: Subcommand, args: readonly string[], dir: string): Promise<string> => {
    let prefix = '';
    if (needsCommonBuild(subcommand, dir) && !commonBuilt) {
      const built = await run('tsup', COMMON_BUILD_ARGS, 'common');
      if (built.code !== 0) {
        return `common/dist could not be built from the checkout, so ${subcommand} in ${dir} did not run. tsup ${COMMON_BUILD_ARGS.join(' ')} in common:\n${built.text}`;
      }
      commonBuilt = true;
      prefix = `[built common/dist from the checkout first: tsup ${COMMON_BUILD_ARGS.join(' ')}]\n\n`;
    }
    const result = await run(subcommand, args, dir);
    // A failed tsup may have cleaned dist/ already.
    if (subcommand === 'tsup') commonBuilt = result.code === 0;
    return prefix + result.text;
  };

  return tool({
    name: 'build',
    description: describeBuildTool(),
    inputSchema: z.object({
      subcommand: z.enum(SUBCOMMAND_NAMES),
      args: z.array(z.string()).min(1).describe('argv tokens after the tool name, e.g. ["--noEmit", "-p", "tsconfig.json"], ["run", "src/utils/secureStorage.test.ts"] or ["--test", "src/__tests__/session.test.ts"]'),
      dir: z.string().describe('Package directory: ".", "common", "apps/frontend", "apps/server" or "apps/metrics".'),
    }),
    callback: async (input) => {
      const refused = checkBuildArgs(input.subcommand, input.args, input.dir);
      if (refused) return `ERROR: ${refused}`;
      const next = queue.then(() => call(input.subcommand, input.args, normalizeDir(input.dir)));
      queue = next.catch(() => undefined);
      return next;
    },
  });
}
