// The bare builtin name deliberately bypasses Wrangler's node:util alias.
import nativeUtil from 'util';
export * from 'util';

/** workerd enables debuglog unconditionally; never emit SDK signed payloads. */
export const debuglog: typeof nativeUtil.debuglog = (section, callback) => {
  if (/^alipay-sdk(?::|$)/i.test(section)) {
    const quiet = Object.assign(() => {}, { enabled: false });
    callback?.(quiet);
    return quiet;
  }
  return nativeUtil.debuglog(section, callback);
};

export const debug = debuglog;
export default { ...nativeUtil, debuglog, debug };
