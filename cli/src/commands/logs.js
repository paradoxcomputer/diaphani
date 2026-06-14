import { ui } from '../ui.js';
import * as docker from '../docker.js';

// `diaphani logs [-f] [-n N]` — stream the container's node output (sync progress,
// peer dials, startup errors) via `docker logs`.
export async function logs(opts = {}) {
  const follow = !!opts.follow;
  const tail = Math.max(1, Number(opts.lines) || 200);

  if (!(await docker.containerExists())) {
    ui.warn('No Diaphani container — run `diaphani up` first.');
    return;
  }
  await docker.streamLogs({ follow, tail });
}
