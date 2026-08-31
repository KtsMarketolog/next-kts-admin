import styles from './CatalogSeo.module.scss';
import { JsonLd, type JsonLdValue } from '@/shared/lib/seo/jsonLd';

type Props = {
  heading: string;
  jsonLd?: JsonLdValue;
};

export function CatalogSeo({ heading, jsonLd }: Props) {
  return (
    <>
      <h1 className={styles.visuallyHidden}>{heading}</h1>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
    </>
  );
}
