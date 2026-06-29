export function terminateCommand(
  child,
  signal,
  { platform = process.platform, hostProcess = process } = {},
) {
  if (
    platform !== "win32" &&
    Number.isSafeInteger(child.pid) &&
    child.pid > 0
  ) {
    try {
      return hostProcess.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
      return false;
    }
  }
  return child.kill(signal);
}

export function forwardCommandSignals(
  child,
  { platform = process.platform, hostProcess = process } = {},
) {
  const signals = [
    "SIGINT",
    "SIGTERM",
    ...(platform === "win32" ? [] : ["SIGHUP"]),
  ];
  const handlers = new Map();
  let forwardedSignal;
  for (const signal of signals) {
    const handler = () => {
      forwardedSignal ??= signal;
      terminateCommand(child, signal, { platform, hostProcess });
    };
    handlers.set(signal, handler);
    hostProcess.on(signal, handler);
  }
  return {
    get forwardedSignal() {
      return forwardedSignal;
    },
    stop() {
      for (const [signal, handler] of handlers)
        hostProcess.off(signal, handler);
    },
  };
}
