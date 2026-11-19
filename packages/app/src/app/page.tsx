import { SearchForm } from "./search-form.tsx";

export default function Home() {
  return (
    <section className="home">
      <h1>Who are you dealing with?</h1>
      <p className="lead">Neutral, sourced fact sheets on public figures, brands and products.</p>
      <SearchForm />
    </section>
  );
}
