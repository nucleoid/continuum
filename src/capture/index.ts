import { CaptureRegistry } from './plugin.js';
import { githubPrPlugin } from './plugins/github-pr.js';
import { adoWorkItemPlugin } from './plugins/ado-workitem.js';
import { githubBranchPlugin } from './plugins/github-branch.js';
import { deployEventPlugin } from './plugins/deploy-event.js';
import { terminalSummaryPlugin } from './plugins/terminal-summary.js';

export * from './plugin.js';
export { githubPrPlugin } from './plugins/github-pr.js';
export type { GitHubPrEvent } from './plugins/github-pr.js';
export { adoWorkItemPlugin } from './plugins/ado-workitem.js';
export type { AdoWorkItemEvent } from './plugins/ado-workitem.js';
export { githubBranchPlugin } from './plugins/github-branch.js';
export type { GitHubBranchEvent } from './plugins/github-branch.js';
export { deployEventPlugin } from './plugins/deploy-event.js';
export type { DeployEventPayload, DeployStatus } from './plugins/deploy-event.js';
export { terminalSummaryPlugin } from './plugins/terminal-summary.js';
export type { TerminalSummaryPayload } from './plugins/terminal-summary.js';

export function defaultCaptureRegistry(): CaptureRegistry {
  const reg = new CaptureRegistry();
  reg.register(githubPrPlugin);
  reg.register(adoWorkItemPlugin);
  reg.register(githubBranchPlugin);
  reg.register(deployEventPlugin);
  reg.register(terminalSummaryPlugin);
  return reg;
}
