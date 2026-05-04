import React from 'react';
import styles from './UniversalGridCards.module.scss';
import Container from '@/shared/ui/Container';

type Span = {
  col: number;
  row?: number;
  minH?: number;
};

type ResponsiveSpans = {
  desktop: Span;
  tablet?: Span;
  mobile?: Span;
};

export type UniversalCardItem = {
  id?: string;
  title: string;
  desc: string;

  bgImage?: string;

  bgImageTablet?: string;
  bgImageMobile?: string;

  bgSize?: string;
  bgPos?: string;
  bgRepeat?: string;
  spans: ResponsiveSpans;
  className?: string;
};

type Props = {
  title?: string;
  titleAccent?: string; 
  items: UniversalCardItem[];
  className?: string;
};

function renderWithBr(str: string) {
  return str.split('<br/>').map((part, idx, arr) => (
    <React.Fragment key={idx}>
      {part}
      {idx < arr.length - 1 && <br />}
    </React.Fragment>
  ));
}

export const UniversalGridCards = ({
  title,
  titleAccent,
  items,
  className,
}: Props) => {
  return (
    <section className={`${styles.section} ${className ?? ''}`}>
      <Container>
        {(title || titleAccent) && (
          <h2 className={styles.h2}>
            {title ? renderWithBr(title) : null}
            {titleAccent ? <span>{renderWithBr(titleAccent)}</span> : null}
          </h2>
        )}

        <div className={styles.grid}>
          {items.map((it, idx) => {
            const d = it.spans.desktop;
            const t = it.spans.tablet ?? d;
            const m = it.spans.mobile ?? t;

            const styleVars: React.CSSProperties = {
              // spans
              ['--col-desktop' as any]: d.col,
              ['--row-desktop' as any]: d.row ?? 1,
              ['--minh-desktop' as any]: d.minH ? `${d.minH}px` : undefined,

              ['--col-tablet' as any]: t.col,
              ['--row-tablet' as any]: t.row ?? 1,
              ['--minh-tablet' as any]: t.minH ? `${t.minH}px` : undefined,

              ['--col-mobile' as any]: m.col,
              ['--row-mobile' as any]: m.row ?? 1,
              ['--minh-mobile' as any]: m.minH ? `${m.minH}px` : undefined,

              // background per breakpoint
              ['--bg-image' as any]: it.bgImage ? `url(${it.bgImage})` : 'none',
              ['--bg-image-tablet' as any]: it.bgImageTablet
                ? `url(${it.bgImageTablet})`
                : undefined,
              ['--bg-image-mobile' as any]: it.bgImageMobile
                ? `url(${it.bgImageMobile})`
                : undefined,

              ['--bg-size' as any]: it.bgSize ?? 'cover',
              ['--bg-pos' as any]: it.bgPos ?? 'right bottom',
              ['--bg-repeat' as any]: it.bgRepeat ?? 'no-repeat',
            };

            return (
              <div
                key={it.id ?? `${idx}-${it.title}`}
                className={`${styles.card} ${it.className ?? ''}`}
                style={styleVars}
              >
                <div className={styles.cardTitle}>{renderWithBr(it.title)}</div>
                <div className={styles.cardDesc}>{it.desc}</div>
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
};