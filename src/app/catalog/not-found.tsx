// src/app/catalog/not-found.tsx
export default function NotFound() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1 style={{ marginBottom: 8 }}>Ничего не найдено</h1>
      <p>Запрошенная страница каталога отсутствует или была перемещена.</p>
      <a href="/catalog" style={{ display: 'inline-block', marginTop: 16 }}>
        ← Вернуться в каталог
      </a>
    </div>
  );
}
