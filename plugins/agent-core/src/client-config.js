/** Set the public name hook already consumed by startup-animation. No DOM or I/O. */
export function installPublicConfig(root, name) {
  const previous = root.__CHENGMENG_CONFIG__
  const installed = Object.freeze({ ...previous, agentDisplayName: name })
  root.__CHENGMENG_CONFIG__ = installed
  return () => {
    if (root.__CHENGMENG_CONFIG__ !== installed) return
    if (previous === undefined) delete root.__CHENGMENG_CONFIG__
    else root.__CHENGMENG_CONFIG__ = previous
  }
}
