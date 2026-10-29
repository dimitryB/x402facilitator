import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Run e2e files in filename order (01-…, 02-…) so the output reads like the Definition of done. */
class FilenameSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["./setup/global.ts"],
    // One facilitator, one signer per chain and rate-limited upstreams: run files one at a time.
    fileParallelism: false,
    sequence: { sequencer: FilenameSequencer },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 120_000,
  },
});
