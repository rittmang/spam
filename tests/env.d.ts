import type { LocalEnv as WorkerEnv } from '../worker/local-group';
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
