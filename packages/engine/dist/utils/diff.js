import { createTwoFilesPatch } from "diff";
export function createUnifiedDiff(filePath, originalContent, newContent) {
    return createTwoFilesPatch(filePath, filePath, originalContent, newContent, "original", "updated");
}
