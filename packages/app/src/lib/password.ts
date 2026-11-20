/**
 * Password rules, shared by the server (which decides) and the signup form (which shows live
 * help). Length is what matters: no composition rules (symbols, digits, capitals), as NIST SP
 * 800-63B advises. A password manager or a passphrase of several words both pass easily.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordIssue = "short" | "long" | "common" | "repetitive" | "email";

/** A short list of the most used long passwords; a breached-password check can replace it later. */
const COMMON = new Set(
  [
    "password1234", "password12345", "password123456", "passwordpassword", "123456789012", "1234567890123",
    "12345678901234", "123456123456", "qwertyuiop12", "qwertyuiopasdf", "qwertyqwerty", "azertyuiop12",
    "azertyazerty", "abcdefghijkl", "abcdefgh1234", "iloveyou1234", "iloveyouiloveyou", "letmein12345",
    "welcome12345", "administrator", "changeme1234", "motdepasse123", "motdepasse1234", "bonjour12345",
    "football1234", "monkey123456", "dragon123456", "sunshine1234", "princess1234", "superman1234",
    "1q2w3e4r5t6y", "1qaz2wsx3edc", "zaq12wsx1234", "kwazatkwazat", "kwazat123456",
  ].map((p) => p.toLowerCase()),
);

/** What is wrong with a candidate password (empty when it is fine). */
export function passwordIssues(password: string, email = ""): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  if (password.length < PASSWORD_MIN) issues.push("short");
  if (password.length > PASSWORD_MAX) issues.push("long");
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.{1,4})\1+$/.test(lower)) issues.push(COMMON.has(lower) ? "common" : "repetitive");
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  if (local.length >= 4 && lower.includes(local)) issues.push("email");
  return issues;
}
