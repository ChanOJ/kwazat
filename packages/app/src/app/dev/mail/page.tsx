import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { devMailbox, readDevMailbox } from "@/lib/mail.ts";
import { AutoRefresh } from "../../auto-refresh.tsx";

export const metadata: Metadata = { title: "Local mailbox" };

/** Development only: the messages the app "sent" (nothing leaves the machine). */
export default function DevMailPage() {
  if (!devMailbox()) notFound();
  const mails = readDevMailbox();
  return (
    <section>
      <AutoRefresh seconds={5} />
      <h1>Local mailbox</h1>
      <p className="lead">Development only. Emails the app sends locally land here (newest first).</p>
      {mails.length === 0 && <p className="empty">No message yet.</p>}
      {mails.map((m) => (
        <article key={m.id} className="panel mail">
          <p className="mail-meta">
            To <strong>{m.to}</strong> · {new Date(m.sentAt).toLocaleString("en-GB")}
          </p>
          <h2>{m.subject}</h2>
          <p className="mail-body">
            {m.text.split(/(https?:\/\/\S+)/).map((part, i) => (i % 2 ? <a key={i} href={part}>{part}</a> : part))}
          </p>
        </article>
      ))}
    </section>
  );
}
