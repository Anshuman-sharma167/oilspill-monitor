export interface PlatformCommandOptions {
  platform?: NodeJS.Platform;
  npmExecPath?: string;
  nodeExecPath?: string;
}

export interface PlatformCommand {
  command: string;
  args: string[];
}

export function platformCommand(
  command: string,
  args: string[],
  options?: PlatformCommandOptions,
): PlatformCommand;
