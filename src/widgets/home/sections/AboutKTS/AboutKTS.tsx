import { Fragment } from "react";
import Container from '@/shared/ui/Container';
import { ArrowHorizontal } from '@/shared/icons/ArrowHorizontal';
import { ArrowVertical } from '@/shared/icons/ArrowVertical';
import { IconArrows } from '@/shared/icons/IconArrows';
import { IconCircles } from '@/shared/icons/IconCircles';
import { IconCrystal } from '@/shared/icons/IconCrystal';
import { IconPathNet } from '@/shared/icons/IconPathNet';
import { AboutKTSReveal } from "./AboutKTSReveal";
import styles from "./AboutKTS.module.scss";

type FactConfig = {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string }>;
  number: string;
  description: string[];
};

const FACTS: FactConfig[] = [
  {
    icon: IconCircles,
    number: "60 000 м²",
    description: ["складские", "мощности"],
  },
  {
    icon: IconCrystal,
    number: "более 40",
    description: ["брендов", "в портфеле"],
  },
  {
    icon: IconArrows,
    number: "2 000+",
    description: ["видов товаров", "в наличии"],
  },
];

const ROOT_ID = 'about-kts';

export const AboutKTS = () => {
  return (
    <section className={styles.aboutKts} id={ROOT_ID}>
      <AboutKTSReveal rootId={ROOT_ID} />
      <Container>
        <h2>КТС – ЭТО</h2>
        <div className={styles.grid}>
          <div className={styles.bigCard}>
            <div className={styles.title}>
              Всё для <br />
              холода -
              <br />
              в наличии
            </div>
            <ArrowHorizontal className={styles.arrowHorizontal} aria-hidden />
            <ArrowVertical className={styles.arrowVertical} aria-hidden />
            <IconPathNet className={styles.net} aria-hidden />
          </div>

          <div className={styles.facts}>
            {FACTS.map(({ icon: Icon, number, description }) => (
              <div
                key={number}
                className={styles.fact}
              >
                <Icon className={styles.icon} aria-hidden />
                <span className={styles.number}>{number}</span>
                <span className={styles.desc}>
                  {description.map((line, lineIdx) => (
                    <Fragment key={`${number}-line-${lineIdx}`}>
                      {line}
                      {lineIdx < description.length - 1 && <br />}
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
};
