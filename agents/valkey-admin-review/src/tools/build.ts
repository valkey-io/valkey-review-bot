import { realpathSync } from 'node:fs';
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
 * The installed script behind `node_modules/.bin/<bin>`, nearest package
 * first, as npm would find it: the package's own node_modules, then the
 * workspace root's. It must resolve inside one of those node_modules
 * directories, so a link the checkout plants elsewhere is not followed.
 */
export function resolveBin(workspaceRoot: string, dir: string, bin: string): string | null {
  const roots = [...new Set([path.join(workspaceRoot, dir, 'node_modules'), path.join(workspaceRoot, 'node_modules')])];
  for (const modules of roots) {
    let real: string;
    let realModules: string;
    try {
      real = realpathSync(path.join(modules, '.bin', bin));
      realModules = realpathSync(modules);
    } catch {
      continue;
    }
    if (real.startsWith(realModules + path.sep)) return real;
  }
  return null;
}

function format(r: BoundedResult): string {
  return `${r.out}\n${r.err ? `\n--- stderr ---\n${r.err}` : ''}\n[exit ${r.code}]`;
}

/**
 * The build tool. Each tool's script runs under this process's node, from
 * the installed node_modules: never npm, npx or a package script, so no
 * lifecycle script runs. `common/dist` is built once per review, before
 * the first command that imports it (`needsCommonBuild`).
 */
export function buildValkeyAdminBuildTool(opts: { workspaceRoot: string }) {
  let commonBuilt = false;

  const run = async (subcommand: Subcommand, args: readonly string[], dir: string): Promise<{ text: string; code: number }> => {
    const cwd = resolveInside(opts.workspaceRoot, dir === '.' ? undefined : dir);
    if (!cwd) return { text: `ERROR: dir "${dir}" is outside the workspace.`, code: 1 };
    const script = resolveBin(opts.workspaceRoot, dir, SUBCOMMANDS[subcommand].bin);
    if (!script) {
      return { text: `ERROR: ${SUBCOMMANDS[subcommand].bin} is not installed in node_modules. The image installs main's dependencies; the tool installs nothing.`, code: 127 };
    }
    const r = await runBounded(process.execPath, [script, ...finalArgs(subcommand, args)], {
      cwd, env: { ...buildChildEnv(), ...OFFLINE_ENV }, ...LIMITS,
    });
    return { text: format(r), code: r.code };
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
      const dir = normalizeDir(input.dir);

      let prefix = '';
      if (needsCommonBuild(input.subcommand, dir) && !commonBuilt) {
        const built = await run('tsup', COMMON_BUILD_ARGS, 'common');
        if (built.code !== 0) {
          return `common/dist could not be built from the checkout, so ${input.subcommand} in ${dir} did not run. tsup ${COMMON_BUILD_ARGS.join(' ')} in common:\n${built.text}`;
        }
        commonBuilt = true;
        prefix = `[built common/dist from the checkout first: tsup ${COMMON_BUILD_ARGS.join(' ')}]\n\n`;
      }

      const result = await run(input.subcommand, input.args, dir);
      if (input.subcommand === 'tsup' && result.code === 0) commonBuilt = true;
      return prefix + result.text;
    },
  });
}
