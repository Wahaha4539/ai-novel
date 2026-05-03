import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

/**
 * Loads the API-specific environment file before other modules read process.env.
 *
 * Inputs: none.
 * Outputs: dotenv result is intentionally ignored because Nest/Prisma will report
 * missing required values during startup.
 * Side effects: populates process.env from apps/api/.env without overriding values
 * that were already provided by the shell or deployment platform.
 */
loadEnv({ path: resolve(__dirname, '..', '.env') });