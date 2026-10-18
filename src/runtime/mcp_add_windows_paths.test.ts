import { expect, it } from "vitest";
import { mcpAddInputError } from "./mcp_add_types";

const input = (executablePath: string) => ({
  name: "local-program",
  executablePath,
  args: ["", "space value", "& literal"],
});

it.each([
  String.raw`C:\Programs\工具\program.exe`,
  "D:/Program Files/local/program.exe",
  String.raw`C:\Programs/local\program.exe`,
  String.raw`\\?\C:\Programs\program.exe`,
])("retains a Windows local disk program spelling: %s", (path) => {
  const value = input(path);
  expect(mcpAddInputError(value)).toBeNull();
  expect(value.executablePath).toBe(path);
  expect(value.args).toEqual(["", "space value", "& literal"]);
});

it.each([
  String.raw`\\server\share\program.exe`,
  String.raw`\\?\UNC\server\share\program.exe`,
  String.raw`\\.\pipe\program`,
  String.raw`C:program.exe`,
  String.raw`\Programs\program.exe`,
  String.raw`C:\Programs\\program.exe`,
  String.raw`C:\Programs\.\program.exe`,
  String.raw`C:\Programs\..\program.exe`,
  "C:/Programs/",
  String.raw`C:\Programs\program.exe:stream`,
  String.raw`C:\Programs\NUL.exe`,
  String.raw`C:\Programs\COM¹.exe`,
  String.raw`C:\Programs\program.exe.`,
  String.raw`C:\Programs\program.exe `,
  String.raw`C:\Programs\bad?name.exe`,
  String.raw`\\?\C:\Programs/program.exe`,
])("refuses unsupported Windows program spelling: %s", (path) => {
  expect(mcpAddInputError(input(path))).toBe("invalidExecutablePath");
});
