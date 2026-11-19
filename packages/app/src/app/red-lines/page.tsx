import type { Metadata } from "next";

export const metadata: Metadata = { title: "Red lines" };

export default function RedLinesPage() {
  return (
    <section>
      <h1>Red lines</h1>
      <p className="lead">
        Choose what you do not want to support, and Kwazat will tell you how each person, brand or product measures up, with
        its sources.
      </p>
      <p className="notice">Coming soon: how red lines work is being designed.</p>
    </section>
  );
}
