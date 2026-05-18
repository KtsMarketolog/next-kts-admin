import { revalidatePath, revalidateTag } from 'next/cache';

export const PUBLIC_CATALOG_CACHE_TAG = 'public-catalog';

export function revalidatePublicCatalog() {
  revalidatePath('/catalog', 'layout');
  revalidateTag(PUBLIC_CATALOG_CACHE_TAG, { expire: 0 });
}
