import { config as dotenvConfig } from 'dotenv'
import { existsSync } from 'fs'

/**
 * Loads every existing .env file in priority order. dotenv never overrides a
 * variable that is already set, so the first file to define a key wins and
 * later files only fill in keys the earlier ones left out. Returns the paths
 * that were loaded (never their contents).
 */
export function loadEnvFiles(paths: string[]): string[] {
  const loaded = paths.filter((path) => existsSync(path))
  for (const path of loaded) dotenvConfig({ path, quiet: true })
  return loaded
}
