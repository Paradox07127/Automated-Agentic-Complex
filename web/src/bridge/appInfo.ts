// `app.info`: the app's build and where its web files and agentd come from.
export interface AppInfo {
  version: string;
  buildGit: string;
  os: string;
  /** One-minute load average, read on each call. */
  loadAverage: number;
  cores: number;
  /** `dev`: the web files, routes.json and agentd come from config.json `dev_resources`, not the app. */
  source: 'bundle' | 'dev';
  /** The dev deployment's dev-receipt.json; empty and false with `bundle`. */
  devCommit: string;
  devDirty: boolean;
  devUiHash: string;
  devAgentdHash: string;
  /** The coding-tool hook installer steps: dry run, then install; empty when this build gives none. */
  hookInstallSteps: Array<{ label: string; command: string; terminal: boolean }>;
}
