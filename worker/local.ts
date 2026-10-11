import { createWorker } from './index';
import type { LocalEnv } from './local-group';
import { LocalDirectory } from './directory';
export { GroupModerator } from './local-group';
export default createWorker(
  (env) => {
    const namespace = (env as LocalEnv).GROUPS;
    return namespace.get(namespace.idFromName(env.TELEGRAM_CHAT_ID));
  },
  (env) => new LocalDirectory(env),
);
