/**
 * Local test account, for automated checks and for Claude in a local browser. Not a secret: it
 * only exists in the local PGlite database (`pnpm users test-account` refuses DATABASE_URL), and
 * the `.local` domain cannot receive mail.
 */
export const TEST_ACCOUNT = {
  email: "test@kwazat.local",
  name: "Test account",
  password: "local-test-account-only",
};
