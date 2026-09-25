export const platformCommand = (
  command,
  args,
  {
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodeExecPath = process.execPath,
  } = {},
) => {
  if (platform !== "win32" || command !== "npm") {
    return { command, args };
  }

  return npmExecPath
    ? { command: nodeExecPath, args: [npmExecPath, ...args] }
    : { command: "npm.cmd", args };
};
