import { assembleCommonTools } from '../../../common/src/tools/index.js';
import type { AssembleBaseOpts } from '../../../common/src/run-agent.js';

/**
 * The common lsp tool starts clangd and nothing else. This image does not
 * install clangd, and there is no TypeScript server in the manifest, so
 * every lsp call would fail. The prompt sends the reviewer to grep instead.
 */
function isLspTool(t: unknown): boolean {
  return typeof t === 'object' && t !== null && (t as { name?: unknown }).name === 'lsp';
}

/**
 * valkey-review-bot-review tool set: the common tools without lsp.
 *
 * There is no build tool, whatever agents.<id>.allowBuild says. This
 * reviewer reviews the bot's own repository, and code from a pull request
 * there must never run in its container. Scrubbing the environment is not a sandbox: that
 * code could read the agent process, reach the runtime's credentials and
 * use the network. infra/lib/deployment-config.ts relies on this
 * (REVIEWER_RUNS_PULL_REQUEST_CODE).
 */
export async function assembleTools(opts: AssembleBaseOpts): Promise<readonly unknown[]> {
  const common = await assembleCommonTools({
    ctx: opts.ctx,
    octokit: opts.octokit,
    tokens: opts.tokens,
    allowWrite: opts.allowWrite,
    statusComment: opts.statusComment,
    onTerminal: opts.onTerminal,
  });
  return common.filter((t) => !isLspTool(t));
}
