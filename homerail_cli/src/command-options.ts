import { InvalidArgumentError } from "commander";

export function parseSettingIdOption(value: string): string {
  const settingId = value.trim();
  if (!settingId) {
    throw new InvalidArgumentError("--setting-id must not be empty or whitespace");
  }
  return settingId;
}
