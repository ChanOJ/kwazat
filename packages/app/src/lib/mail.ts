import fs from "node:fs";
import path from "node:path";
import { uuidv7 } from "@kwazat/db";

export type Mail = { id: string; to: string; subject: string; text: string; sentAt: string };

/** Local development mailbox: one JSON file per message, read by the /dev/mail page. */
export const DEV_MAIL_DIR = process.env.KWAZAT_MAIL_DIR || path.join(process.cwd(), ".data/mail");

export const devMailbox = () => process.env.NODE_ENV !== "production";

/**
 * Sends an email. Development: stored in the local mailbox (/dev/mail), nothing leaves the
 * machine. Staging and prod have no mail transport yet: sending fails loudly.
 */
export async function sendMail(mail: Omit<Mail, "id" | "sentAt">): Promise<void> {
  if (!devMailbox()) throw new Error("No mail transport configured for this environment");
  const message: Mail = { ...mail, id: uuidv7(), sentAt: new Date().toISOString() };
  fs.mkdirSync(DEV_MAIL_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEV_MAIL_DIR, `${message.id}.json`), JSON.stringify(message, null, 2));
  console.log(`[mail] to ${mail.to}: ${mail.subject} (see /dev/mail)`);
}

export function readDevMailbox(limit = 20): Mail[] {
  if (!devMailbox() || !fs.existsSync(DEV_MAIL_DIR)) return [];
  return fs
    .readdirSync(DEV_MAIL_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => JSON.parse(fs.readFileSync(path.join(DEV_MAIL_DIR, f), "utf8")) as Mail);
}
