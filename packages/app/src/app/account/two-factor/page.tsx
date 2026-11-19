import type { Metadata } from "next";
import { getViewer } from "@/lib/viewer.ts";
import { Enroll } from "./enroll.tsx";

export const metadata: Metadata = { title: "Second factor" };

export default async function TwoFactorPage() {
  const viewer = await getViewer();
  const enabled = !!viewer?.twoFactorEnabled;
  return (
    <section>
      <h1>{enabled ? "Change your second factor" : "Set up your second factor"}</h1>
      <p className="lead">
        {enabled
          ? "Choose how you confirm it is you when you log in. The method you choose replaces the current one."
          : "Every Kwazat account needs a second factor. Choose one to continue."}
      </p>
      <Enroll current={viewer?.twoFactorMethod ?? null} />
    </section>
  );
}
