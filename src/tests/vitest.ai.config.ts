import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(testsDir, "wrangler.ai.jsonc")
      }
    })
  ],
  test: {
    name: "assistant-example-ai-e2e",
    include: [path.join(testsDir, "e2e-ai.test.ts")],
    setupFiles: [path.join(testsDir, "setup.ts")],
    testTimeout: 60_000,
    deps: {
      optimizer: {
        ssr: {
          include: ["ajv"]
        }
      }
    }
  }
});
