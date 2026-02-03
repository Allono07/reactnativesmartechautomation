import { createTwoFilesPatch } from "diff";

export function createUnifiedDiff(
  filePath: string,
  originalContent: string,
  newContent: string
): string {
  return createTwoFilesPatch(filePath, filePath, originalContent, newContent, "original", "updated");
}
