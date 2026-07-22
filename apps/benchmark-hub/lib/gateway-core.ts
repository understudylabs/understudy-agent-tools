/**
 * Gateway auth re-export (env first, then ~/.understudy/credentials.json) —
 * the CLI's own resolver from the compiled dist, one relative path so route
 * handlers keep working under the tests' .build output (the app's dist
 * symlink covers the compiled depth), same idiom as replay-core.
 */
export { resolveGatewayAuth } from "../../../dist/trace-author.js";
