"use client";

export default function CatalogError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: '2rem' }}>
      <h2>Что-то пошло не так 😔</h2>
      <p>{error.message}</p>
      <button onClick={() => reset()}>Попробовать снова</button>
    </div>
  );
}
