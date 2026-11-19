export function SearchForm({ query = "" }: { query?: string }) {
  return (
    <form action="/search" method="get" role="search" className="search-form">
      <label htmlFor="q" className="visually-hidden">
        Name of a public figure, brand or product
      </label>
      <input id="q" name="q" type="search" defaultValue={query} placeholder="A public figure, brand or product" autoComplete="off" required />
      <button type="submit">Search</button>
    </form>
  );
}
