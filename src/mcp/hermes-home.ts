import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The folder name Hermes installs this plugin under. */
export const HERMES_PLUGIN_NAME = 'leafi';

/** Hermes's home folder: `$HERMES_HOME` (a profile's folder), else its platform default. */
export function hermesHome(): string {
  const home = process.env.HERMES_HOME?.trim();
  if (home) {
    return home.replace(/^~(?=$|[\\/])/, os.homedir());
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local'), 'hermes');
  }
  return path.join(os.homedir(), '.hermes');
}

/** Where Hermes keeps its settings, which the plugin reads. */
export function hermesEnvFile(): string {
  return path.join(hermesHome(), '.env');
}

/** Whether Hermes has this plugin installed, enabled or not. */
export function hermesPluginInstalled(): boolean {
  return fs.existsSync(path.join(hermesHome(), 'plugins', HERMES_PLUGIN_NAME));
}
