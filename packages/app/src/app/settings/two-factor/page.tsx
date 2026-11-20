import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { rememberedPassword } from "@/lib/signup-secret.ts";
import { getViewer } from "@/lib/viewer.ts";
import { Enroll } from "./enroll.tsx";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("meta"))("twoFactor") };
}

export default async function TwoFactorPage() {
  const viewer = await getViewer();
  const enabled = !!viewer?.twoFactorEnabled;
  const t = await getTranslations("twoFactor");
  const passwordKnown = !!viewer && !!(await rememberedPassword(viewer.id));
  return (
    <section>
      <h1>{enabled ? t("titleChange") : t("titleSetUp")}</h1>
      <p className="lead">{enabled ? t("leadChange") : t("leadSetUp")}</p>
      <Enroll current={viewer?.twoFactorMethod ?? null} passwordKnown={passwordKnown} />
    </section>
  );
}
