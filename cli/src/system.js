// Tiny host probe used by the Docker run model.
import { capture } from './run.js';

// Resolve a command to its path (or null). Used to detect `docker` / `sudo` presence.
export async function which(bin) {
  const p = await capture(`command -v ${bin} 2>/dev/null || true`);
  return p ? p.split('\n')[0] : null;
}
