import { canonicalUrl } from '@/shared/lib/seo/siteUrl';
import type { JsonLdValue } from '@/shared/lib/seo/jsonLd';

export type CatalogBreadcrumb = {
  name: string;
  path: string;
};

export type CatalogListItem = {
  name: string;
  path?: string;
};

type CatalogCollectionJsonLdOptions = {
  name: string;
  description: string;
  path: string;
  breadcrumbs: CatalogBreadcrumb[];
  items: CatalogListItem[];
  positionOffset?: number;
};

export function buildCatalogCollectionJsonLd({
  name,
  description,
  path,
  breadcrumbs,
  items,
  positionOffset = 0,
}: CatalogCollectionJsonLdOptions): JsonLdValue {
  const pageUrl = canonicalUrl(path);
  const breadcrumbId = `${pageUrl}#breadcrumbs`;
  const itemListId = `${pageUrl}#items`;
  const breadcrumbItems: JsonLdValue[] = breadcrumbs.map((breadcrumb, index) => ({
    '@type': 'ListItem',
    position: index + 1,
    name: breadcrumb.name,
    item: canonicalUrl(breadcrumb.path),
  }));
  const listItems: JsonLdValue[] = items.map((item, index): JsonLdValue => {
    if (item.path) {
      return {
        '@type': 'ListItem',
        position: positionOffset + index + 1,
        name: item.name,
        url: canonicalUrl(item.path),
      };
    }

    return {
      '@type': 'ListItem',
      position: positionOffset + index + 1,
      item: {
        '@type': 'Thing',
        name: item.name,
      },
    };
  });

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${pageUrl}#webpage`,
        url: pageUrl,
        name,
        description,
        breadcrumb: { '@id': breadcrumbId },
        mainEntity: { '@id': itemListId },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': breadcrumbId,
        itemListElement: breadcrumbItems,
      },
      {
        '@type': 'ItemList',
        '@id': itemListId,
        numberOfItems: items.length,
        itemListElement: listItems,
      },
    ],
  };
}
